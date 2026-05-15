import type { FastifyInstance } from 'fastify';

import { projectState } from '../project-state.ts';
import { buildGraph } from '../pipeline-graph.ts';
import {
  buildTemplateOverview,
  collectReferencedTemplates,
} from '../pipeline-template-overview.ts';
import { readPipelineStateForRun } from '../run-reader.ts';
import { runController } from '../run-controller.ts';
import type { NodeLogLine, PipelineState } from '../types.ts';

const RUN_STARTING_CLOCK_SKEW_MS = 1000;

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

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
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
      const graph = showLive
        ? buildGraph(snap.pipeline, liveState, {
            isRunning,
            isRunStarting,
            activeRunStartedAt:
              activeRun?.startedAt ??
              (isRunStarting ? runStarting?.startedAt : null) ??
              null,
          })
        : buildTemplateOverview(snap.pipeline, project.artDir);
      // Ship raw template files alongside the overview so the client can
      // inline-expand a template without a server round-trip. Skipped in
      // live mode (graph already contains per-stage detail).
      const templates = showLive
        ? undefined
        : collectReferencedTemplates(snap.pipeline, project.artDir);
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
      reply.raw.write(': heartbeat\n\n');
    }, 15000);

    req.raw.on('close', () => {
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
