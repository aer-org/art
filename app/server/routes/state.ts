import type { FastifyInstance } from 'fastify';

import { debugStats } from '../debug-stats.ts';
import { projectState } from '../project-state.ts';
import { buildGraph } from '../pipeline-graph.ts';
import {
  buildTemplateOverview,
  collectReferencedTemplates,
} from '../pipeline-template-overview.ts';
import { readPipelineStateForRun } from '../run-reader.ts';
import { runController } from '../run-controller.ts';
import type {
  Graph,
  NodeLogLine,
  PipelineConfig,
  PipelineState,
} from '../types.ts';

const RUN_STARTING_CLOCK_SKEW_MS = 1000;

// Per-mode single-entry caches keyed by the inputs that actually drive
// the output. pipeline-watcher's readCachedJson preserves object
// identity for unchanged files, so identity comparison here is exact
// enough — every member of `key` is the same reference across SSE
// broadcasts when the underlying inputs haven't changed.
//
// Without this, every connected client recomputed buildGraph (~hundreds
// of stages worst case) on every chokidar-driven snapshot tick. With
// multiple tabs open during a long run this was the dominant CPU draw
// on the server side.
type LiveGraphKey = readonly [
  PipelineConfig | null,
  PipelineState | null,
  boolean, // isRunning
  boolean, // isRunStarting
  number | null, // activeRunStartedAt
];
let liveGraphCache: { key: LiveGraphKey; value: Graph } | null = null;

type OverviewKey = readonly [PipelineConfig | null, string];
let overviewGraphCache: { key: OverviewKey; value: Graph } | null = null;
let templatesCache: {
  key: OverviewKey;
  value: ReturnType<typeof collectReferencedTemplates>;
} | null = null;

function keysEqual<T extends readonly unknown[]>(a: T, b: T): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function stateCatchesRunStart(
  state: { lastUpdated?: unknown } | null | undefined,
  startedAt: number,
): boolean {
  if (typeof state?.lastUpdated !== 'string') return false;
  const updatedAt = Date.parse(state.lastUpdated);
  return Number.isFinite(updatedAt) && updatedAt >= startedAt - RUN_STARTING_CLOCK_SKEW_MS;
}

export function registerStateRoutes(app: FastifyInstance): void {
  app.get('/api/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    debugStats.sseConnections += 1;
    debugStats.sseTotalConnections += 1;

    // Drop high-volume log events while the socket's write queue is
    // already saturated. A busy run can emit ~80 000 run-log / node-log
    // lines in 70 s — far faster than a typical client can drain — and
    // queueing them all has been observed to push server RSS to multi-
    // GB. The disk archive (stages/<n>/stdout.log, agent stream log)
    // is the canonical record; the next snapshot tick brings the
    // client back to a consistent view.
    //
    // Critical events (snapshot, run-exit, run-log-reset, run-starting)
    // are always sent — they're rare and convey state transitions that
    // can't be inferred from missed log lines.
    const DROPPABLE = new Set(['run-log', 'node-log']);
    const send = (event: string, data: unknown) => {
      if (DROPPABLE.has(event) && reply.raw.writableNeedDrain) {
        debugStats.sseWritesBackpressured += 1;
        return;
      }
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      debugStats.sseWritesTotal += 1;
      const ok = reply.raw.write(payload);
      if (!ok) debugStats.sseWritesBackpressured += 1;
      if (event === 'snapshot') {
        debugStats.snapshotSendsTotal += 1;
        debugStats.snapshotBytesTotal += payload.length;
      }
    };

    const sendSnapshot = () => {
      const project = projectState.current;
      if (!project) {
        send('snapshot', { projectDir: null });
        return;
      }
      const snap = project.current();
      const activeRun = runController.activeRunInfo(project.projectDir, snap.latestRun);
      const runStarting = activeRun
        ? null
        : runController.runStartingInfo(project.projectDir);
      const isRunning = activeRun !== null;
      const isRunStarting =
        runStarting !== null && !stateCatchesRunStart(snap.state, runStarting.startedAt);
      // Two graph modes on the Live tab:
      //   - Live/starting run: post-stitch barrier graph from the active
      //     run's state (per-stage, materialized lanes).
      //   - Otherwise (no run yet OR only sealed runs): template overview
      //     showing the *space* of possible flows. Sealed runs have their
      //     own detail view (/runs/<id>); we don't want the Live tab to
      //     freeze on a stale terminal snapshot.
      const isStopping = runController.isStopping(project.projectDir);
      const showLive = isRunning || isRunStarting;
      // pipeline-watcher only reads root PIPELINE_STATE.json into
      // `snap.state`. For a live run with stitched lanes, the
      // grandchildren live in scoped state files (PIPELINE_STATE.<scope>.json)
      // — same data RunDetailPage merges via readPipelineStateForRun.
      // Use the same source here so Live and Runs/<id> render an
      // identical graph.
      const liveRunId = activeRun?.runId ?? snap.latestRun?.runId ?? null;
      const liveState =
        showLive && liveRunId
          ? ((readPipelineStateForRun(
              project.projectDir,
              liveRunId,
            ) as PipelineState | null) ?? snap.state)
          : snap.state;
      let graph: Graph;
      if (showLive) {
        const activeStartedAt =
          activeRun?.startedAt ??
          (isRunStarting ? (runStarting?.startedAt ?? null) : null) ??
          null;
        const key: LiveGraphKey = [
          snap.pipeline,
          liveState,
          isRunning,
          isRunStarting,
          activeStartedAt,
        ] as const;
        if (liveGraphCache && keysEqual(liveGraphCache.key, key)) {
          graph = liveGraphCache.value;
        } else {
          graph = buildGraph(snap.pipeline, liveState, {
            isRunning,
            isRunStarting,
            activeRunStartedAt: activeStartedAt,
          });
          liveGraphCache = { key, value: graph };
        }
      } else {
        const key: OverviewKey = [snap.pipeline, project.artDir] as const;
        if (overviewGraphCache && keysEqual(overviewGraphCache.key, key)) {
          graph = overviewGraphCache.value;
        } else {
          graph = buildTemplateOverview(snap.pipeline, project.artDir);
          overviewGraphCache = { key, value: graph };
        }
      }
      // Ship raw template files in both modes. Overview needs them for
      // inline-expansion; Live needs them so the inspector can resolve
      // authored config for stitched-lane stages (the post-stitch graph
      // exposes templateName + localName but not the underlying template
      // body, which is what L2/L3 actually render for un-executed lanes).
      let templates: ReturnType<typeof collectReferencedTemplates> | undefined;
      {
        const key: OverviewKey = [snap.pipeline, project.artDir] as const;
        if (templatesCache && keysEqual(templatesCache.key, key)) {
          templates = templatesCache.value;
        } else {
          templates = collectReferencedTemplates(snap.pipeline, project.artDir);
          templatesCache = { key, value: templates };
        }
      }
      send('snapshot', {
        projectDir: project.projectDir,
        pipeline: snap.pipeline,
        pipelineError: snap.pipelineError,
        // Ship the merged state for live mode so anything client-side
        // that reads `snapshot.state` (currentStage, completedStages,
        // dispatch tree) sees the same picture the graph was built from.
        state: liveState,
        latestRun: snap.latestRun,
        graph,
        graphMode: showLive ? 'live' : 'template-overview',
        templates,
        isRunning,
        isRunStarting,
        isStopping,
      });
    };

    sendSnapshot();

    const onSnapshot = () => sendSnapshot();
    const onRunLog = (payload: { projectDir: string; kind: string; line: string }) => {
      const cur = projectState.current;
      if (!cur || cur.projectDir !== payload.projectDir) return;
      send('run-log', payload);
    };
    const onRunLogReset = (payload: { projectDir: string; source: 'local' | 'chat'; startedAt: number }) => {
      const cur = projectState.current;
      if (!cur || cur.projectDir !== payload.projectDir) return;
      send('run-log-reset', payload);
    };
    const onRunStart = (payload: { projectDir: string; pid: number; startedAt: number }) => {
      const cur = projectState.current;
      if (!cur || cur.projectDir !== payload.projectDir) return;
      sendSnapshot();
    };
    const onRunStarting = (payload: { projectDir: string; startedAt: number }) => {
      const cur = projectState.current;
      if (!cur || cur.projectDir !== payload.projectDir) return;
      sendSnapshot();
    };
    const onRunExit = (payload: { projectDir: string; code: number | null; signal: string | null }) => {
      const cur = projectState.current;
      if (!cur || cur.projectDir !== payload.projectDir) return;
      send('run-exit', payload);
      cur.refreshNow(false);
      sendSnapshot();
    };
    const onRunStopping = (payload: { projectDir: string }) => {
      const cur = projectState.current;
      if (!cur || cur.projectDir !== payload.projectDir) return;
      // Push immediately so the UI flips Stop → Stopping… before the
      // runner actually finishes cleanup.
      sendSnapshot();
    };

    const onLogLine = (payload: { line: string; kind: 'stdout' | 'stderr' }) => {
      send('run-log', { kind: payload.kind, line: payload.line });
    };
    const onNodeLogLine = (payload: NodeLogLine) => {
      const cur = projectState.current;
      if (!cur) return;
      send('node-log', { ...payload, projectDir: cur.projectDir });
    };

    let currentProject = projectState.current;
    currentProject?.on('snapshot', onSnapshot);
    currentProject?.on('log-line', onLogLine);
    currentProject?.on('node-log-line', onNodeLogLine);
    runController.on('starting', onRunStarting);
    runController.on('start', onRunStart);
    runController.on('stopping', onRunStopping);
    runController.on('log-reset', onRunLogReset);
    runController.on('log', onRunLog);
    runController.on('exit', onRunExit);

    // If the project changes during the lifetime of this stream, re-bind.
    const checkProjectChange = setInterval(() => {
      if (projectState.current !== currentProject) {
        currentProject?.off('snapshot', onSnapshot);
        currentProject?.off('log-line', onLogLine);
        currentProject?.off('node-log-line', onNodeLogLine);
        currentProject = projectState.current;
        currentProject?.on('snapshot', onSnapshot);
        currentProject?.on('log-line', onLogLine);
        currentProject?.on('node-log-line', onNodeLogLine);
        sendSnapshot();
      }
    }, 500);

    // Heartbeat
    const heartbeat = setInterval(() => {
      debugStats.sseWritesTotal += 1;
      const ok = reply.raw.write(': heartbeat\n\n');
      if (!ok) debugStats.sseWritesBackpressured += 1;
    }, 15000);

    req.raw.on('close', () => {
      debugStats.sseConnections = Math.max(0, debugStats.sseConnections - 1);
      clearInterval(heartbeat);
      clearInterval(checkProjectChange);
      currentProject?.off('snapshot', onSnapshot);
      currentProject?.off('log-line', onLogLine);
      currentProject?.off('node-log-line', onNodeLogLine);
      runController.off('starting', onRunStarting);
      runController.off('start', onRunStart);
      runController.off('stopping', onRunStopping);
      runController.off('log-reset', onRunLogReset);
      runController.off('log', onRunLog);
      runController.off('exit', onRunExit);
    });
  });
}
