/**
 * LivePage — live run monitoring + chat panel.
 *
 * Pipeline state (snapshot, runLog, nodeLogs, SSE subscription) is owned
 * by App via `usePipelineState` and threaded in as `props.pipeline`. This
 * way the SSE feed and log buffers survive navigation between Live and
 * Runs — earlier the hook lived here, so switching tabs unmounted the
 * subscription and dropped any logs that arrived while the user was on
 * the Runs page.
 *
 * Inspector data model (see app/web/src/components/StageSidebar.tsx):
 *   The selected stage's information has two independent sources:
 *     - Authored  (Tier 1) — resolved from the snapshot's pipeline +
 *                            templates via the selected GraphNode's
 *                            templateName + localName fields.
 *     - Execution (Tier 2c) — fetched per-run from
 *                            /api/runs/<liveRunId>/stages/<nodeId>/<name>.
 *   Both are passed independently to StageSidebar / L3Panel; neither
 *   pretends to be the other.
 */
import { useEffect, useMemo, useState } from 'react';

import { ChatPanel } from '../components/ChatPanel.tsx';
import { DirectoryPicker } from '../components/DirectoryPicker.tsx';
import { L3Panel } from '../components/L3Panel.tsx';
import { PipelineGraph } from '../components/PipelineGraph.tsx';
import { RunBar } from '../components/RunBar.tsx';
import { RunLogTray } from '../components/RunLogTray.tsx';
import { SetupModal } from '../components/SetupModal.tsx';
import {
  StageSidebar,
  type L3PanelKind,
} from '../components/StageSidebar.tsx';
import type { usePipelineState } from '../hooks/usePipelineState.ts';
import { useAuthoredStage } from '../hooks/useAuthoredStage.ts';
import { useInspectorEscape } from '../hooks/useInspectorEscape.ts';
import { useStageDetail } from '../hooks/useStageDetail.ts';
import {
  api,
  type GraphNode,
  type PipelineSnapshot,
  type PreflightResponse,
  type RunDetail,
} from '../lib/api.ts';
import { buildTemplateOverviewGraph } from '../lib/templateOverview.ts';

export function LivePage(props: {
  preflight: PreflightResponse | null;
  setPreflight: (p: PreflightResponse | null) => void;
  pipeline: ReturnType<typeof usePipelineState>;
}): JSX.Element {
  const {
    snapshot,
    setSnapshot,
    runLog,
    appendRunLog,
    markRunStarting,
    resetRunLog,
    clearRunLog,
    clearNodeLog,
  } = props.pipeline;
  const [selectedStage, setSelectedStage] = useState<string | null>(null);
  const [l3, setL3] = useState<{ kind: L3PanelKind; mount?: string } | null>(
    null,
  );
  // RunDetail for the active run; polled while live so per-stage fetches
  // see fresh archive contents (stage.json, turns, diff, …).
  const [liveDetail, setLiveDetail] = useState<RunDetail | null>(null);
  // Chat-pane collapse, persisted across reloads. ChatPanel stays
  // mounted while collapsed so useChat's session + messages survive
  // toggling without round-tripping through localStorage rehydration.
  const [chatCollapsed, setChatCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('art:chatCollapsed') === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('art:chatCollapsed', chatCollapsed ? '1' : '0');
    } catch {
      /* ignore quota / private-mode errors */
    }
  }, [chatCollapsed]);
  const [showPicker, setShowPicker] = useState(true);
  const [showSetup, setShowSetup] = useState(false);
  const [loadNotice, setLoadNotice] = useState<string | null>(null);
  // Which template-overview pills the user has inline-expanded. Only
  // meaningful when graphMode === 'template-overview'; cleared on switch
  // back to live mode so we don't leak stale stage tags.
  const [expandedTemplates, setExpandedTemplates] = useState<Set<string>>(
    () => new Set(),
  );
  const { preflight, setPreflight } = props;

  useEffect(() => {
    if (snapshot.projectDir) setShowPicker(false);
  }, [snapshot.projectDir]);

  useEffect(() => {
    if (snapshot.graphMode !== 'template-overview') {
      setExpandedTemplates(new Set());
    }
  }, [snapshot.graphMode]);

  const displayGraph = useMemo(() => {
    // In template-overview mode we always rebuild the graph from
    // pipeline + templates (server's `graph` is now just a fallback for
    // clients that haven't been updated). Live mode keeps using the
    // server-built barrier graph.
    if (snapshot.graphMode === 'template-overview' && snapshot.templates) {
      return buildTemplateOverviewGraph(snapshot, expandedTemplates);
    }
    return snapshot.graph ?? { nodes: [], edges: [] };
    // Deps are narrowed to the fields buildTemplateOverviewGraph /
    // snapshot.graph actually consume. Snapshot object identity churns
    // on every SSE tick because the whole envelope is re-parsed; pinning
    // these specific refs lets the layout cache in PipelineGraph hit
    // when the structural shape hasn't changed.
  }, [
    snapshot.graph,
    snapshot.graphMode,
    snapshot.templates,
    snapshot.pipeline,
    expandedTemplates,
  ]);

  // Resolve the selected GraphNode from displayGraph. Single source —
  // both overview and live graphs put templateName + localName on
  // every node, so the inspector lookups can be uniform.
  const selectedNode: GraphNode | null = useMemo(() => {
    if (!selectedStage) return null;
    return displayGraph.nodes.find((n) => n.id === selectedStage) ?? null;
  }, [displayGraph.nodes, selectedStage]);

  const authored = useAuthoredStage(snapshot, selectedNode);

  const isOverview = snapshot.graphMode === 'template-overview';

  // === Live-mode execution data ===========================================
  // While a run is active, fetch the same RunDetail RunDetailPage uses so
  // the StageSidebar / L3Panel see fresh stage.json / turns / diff data.
  const liveRunId =
    !isOverview && snapshot.isRunning
      ? (snapshot.latestRun?.runId ?? null)
      : null;
  useEffect(() => {
    if (!liveRunId) {
      setLiveDetail(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      api
        .runDetail(liveRunId)
        .then((d) => {
          if (!cancelled) setLiveDetail(d);
        })
        .catch(() => {});
    };
    load();
    const id = window.setInterval(load, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [liveRunId]);

  const executionNodeId = selectedNode?.nodeId ?? null;
  const execution = useStageDetail(
    liveDetail,
    isOverview ? null : executionNodeId,
    isOverview ? null : (selectedStage ?? null),
  );

  // Sidebar opens whenever there's something to show — either an
  // authored config or an execution record (or both). We do not
  // pre-require either: a still-loading state renders "Loading…"
  // inside the sidebar instead of refusing to open.
  const hasExecution = execution.stage !== null;
  const inspectorOpen =
    !!selectedStage && (authored !== null || hasExecution || execution.loading);
  const l3Open = inspectorOpen && l3 !== null;
  const layoutClass = l3Open
    ? 'inspector-with-l3'
    : inspectorOpen
      ? 'inspector-with-sidebar'
      : '';

  // Esc cascade: L3 → sidebar.
  useInspectorEscape([
    { open: l3, close: () => setL3(null) },
    { open: selectedStage, close: () => setSelectedStage(null) },
  ]);

  // Close L3 if stage selection changes.
  useEffect(() => {
    if (!selectedStage) setL3(null);
  }, [selectedStage]);

  function handleGraphNodeClick(nodeId: string): void {
    const node = displayGraph.nodes.find((n) => n.id === nodeId);
    // In template-overview mode, the stitch entity for a template has
    // two visual forms — `template` (collapsed card) and `barrier`
    // (expanded sync marker). Clicking either toggles the expansion
    // of the underlying template.
    if (
      snapshot.graphMode === 'template-overview' &&
      (node?.kind === 'template' || node?.kind === 'barrier') &&
      node.templateName
    ) {
      const name = node.templateName;
      setExpandedTemplates((cur) => {
        const next = new Set(cur);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });
      return;
    }
    setSelectedStage(nodeId);
  }

  async function refresh() {
    const cur = await api.current().catch(() => null);
    if (cur) setSnapshot(cur);
  }

  function handleLoad(loaded: PipelineSnapshot) {
    clearRunLog();
    clearNodeLog();
    setSelectedStage(null);
    setL3(null);
    setSnapshot(loaded);
    setLoadNotice(
      loaded.initialized
        ? 'Initialized __art__ and loaded project.'
        : 'Loaded project.',
    );
    setShowPicker(false);
    api
      .preflightForce()
      .then(setPreflight)
      .catch(() => {});
  }

  function handleRunStarting() {
    resetRunLog();
    markRunStarting();
  }

  const preflightBanner = preflight && !preflight.ok && (
    <div className="banner">
      Preflight failed:
      {!preflight.art.present && ' `art` not on PATH.'}
      {!preflight.claude.present && ' `claude` not on PATH.'}
      {!preflight.containerRuntime.present &&
        ' No container runtime (docker/podman/udocker).'}
      {!preflight.debuggerSandbox.present &&
        ' Debugger sandbox (`bwrap`) unavailable.'}
      {!preflight.auth.present &&
        ' Claude auth is not configured. Open Initial Setup.'}
      {snapshot.projectDir &&
        preflight.auth.chatReady === false &&
        ' Left-panel Claude auth is not configured. Open Initial Setup.'}
    </div>
  );

  return (
    <div className={`app-root${chatCollapsed ? ' chat-collapsed' : ''}`}>
      <div className="left-pane">
        {preflightBanner}
        {snapshot.pipelineError && (
          <div className="banner warn">{snapshot.pipelineError}</div>
        )}
        <ChatPanel projectDir={snapshot.projectDir} />
      </div>
      <div className="chat-toggle-bar">
        <button
          type="button"
          onClick={() => setChatCollapsed((c) => !c)}
          aria-label={chatCollapsed ? 'Expand debugger' : 'Collapse debugger'}
          title={chatCollapsed ? 'Expand debugger' : 'Collapse debugger'}
        >
          {chatCollapsed ? '›' : '‹'}
        </button>
        {chatCollapsed && <span className="label">Debugger</span>}
      </div>
      <div className="right-pane">
        <RunBar
          snapshot={snapshot}
          preflight={preflight}
          onChange={refresh}
          onSetup={() => setShowSetup(true)}
          onRunLog={appendRunLog}
          onRunStarting={handleRunStarting}
        />
        {showPicker && (
          <DirectoryPicker
            onLoad={handleLoad}
            onCancel={
              snapshot.projectDir ? () => setShowPicker(false) : undefined
            }
          />
        )}
        {!showPicker && (
          <div
            className="banner info"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>{loadNotice ?? 'Loaded.'}</span>
            <button
              onClick={() => {
                setLoadNotice(null);
                setShowPicker(true);
              }}
            >
              Load another
            </button>
          </div>
        )}
        <div className={`inspector ${layoutClass}`}>
          <div className="inspector-body">
            <div className="inspector-canvas">
              <PipelineGraph
                nodes={displayGraph.nodes}
                edges={displayGraph.edges}
                onNodeClick={handleGraphNodeClick}
              />
            </div>
            {inspectorOpen && selectedStage && (
              <StageSidebar
                nodeId={executionNodeId ?? undefined}
                stageName={selectedStage}
                authored={authored}
                execution={execution}
                onClose={() => setSelectedStage(null)}
                onOpenPanel={(kind, mount) => setL3({ kind, mount })}
              />
            )}
            {l3Open && selectedStage && (
              <L3Panel
                runId={liveRunId}
                nodeId={executionNodeId ?? undefined}
                stageName={selectedStage}
                authored={authored}
                execution={execution}
                kind={l3!.kind}
                mount={l3?.mount}
                onClose={() => setL3(null)}
              />
            )}
          </div>
          <RunLogTray lines={runLog} onClear={clearRunLog} />
        </div>
        {showSetup && (
          <SetupModal
            preflight={preflight}
            onClose={() => setShowSetup(false)}
            onSaved={setPreflight}
          />
        )}
      </div>
    </div>
  );
}
