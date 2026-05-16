/**
 * LivePage — live run monitoring + chat panel.
 *
 * Pipeline state (snapshot, runLog, nodeLogs, SSE subscription) is owned
 * by App via `usePipelineState` and threaded in as `props.pipeline`. This
 * way the SSE feed and log buffers survive navigation between Live and
 * Runs — earlier the hook lived here, so switching tabs unmounted the
 * subscription and dropped any logs that arrived while the user was on
 * the Runs page.
 */
import { useEffect, useMemo, useState } from 'react';

import { ChatPanel } from '../components/ChatPanel.tsx';
import { DirectoryPicker } from '../components/DirectoryPicker.tsx';
import { L3Panel } from '../components/L3Panel.tsx';
import { NodeLogPanel } from '../components/NodeLogPanel.tsx';
import { NodeModal } from '../components/NodeModal.tsx';
import { PipelineGraph } from '../components/PipelineGraph.tsx';
import { RunBar } from '../components/RunBar.tsx';
import { RunLogTray } from '../components/RunLogTray.tsx';
import { SetupModal } from '../components/SetupModal.tsx';
import {
  StageSidebar,
  type L3PanelKind,
} from '../components/StageSidebar.tsx';
import type { usePipelineState } from '../hooks/usePipelineState.ts';
import { useStaticStageDetail } from '../hooks/useStaticStageDetail.ts';
import {
  api,
  type PipelineSnapshot,
  type PreflightResponse,
} from '../lib/api.ts';
import { buildTemplateOverviewGraph } from '../lib/templateOverview.ts';

// L3 panel kinds that make sense in overview mode (no run yet).
const OVERVIEW_L3_KINDS: L3PanelKind[] = ['prompt', 'command', 'mounts'];

export function LivePage(props: {
  preflight: PreflightResponse | null;
  setPreflight: (p: PreflightResponse | null) => void;
  pipeline: ReturnType<typeof usePipelineState>;
}): JSX.Element {
  const {
    snapshot,
    setSnapshot,
    runLog,
    nodeLogs,
    appendRunLog,
    markRunStarting,
    resetRunLog,
    clearRunLog,
    setNodeLog,
    clearNodeLog,
  } = props.pipeline;
  const [selectedStage, setSelectedStage] = useState<string | null>(null);
  const [detailStage, setDetailStage] = useState<string | null>(null);
  const [overviewL3, setOverviewL3] = useState<L3PanelKind | null>(null);
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
  }, [snapshot, expandedTemplates]);

  const selectedNode =
    displayGraph.nodes.find(
      (node) => node.name === selectedStage || node.id === selectedStage,
    ) ?? null;
  const runningNode =
    displayGraph.nodes.find((node) => node.status === 'running') ?? null;

  // Overview mode = no live run; sidebar/L3 inspector replaces the log
  // dock for stage clicks. Live mode keeps the existing NodeLogPanel.
  const isOverview = snapshot.graphMode === 'template-overview';
  const selectedConfigStage = useMemo(() => {
    if (!isOverview || !selectedStage) return null;
    const stages = (snapshot.pipeline?.stages ?? []) as Array<{
      name: string;
      [k: string]: unknown;
    }>;
    return stages.find((s) => s.name === selectedStage) ?? null;
  }, [isOverview, selectedStage, snapshot.pipeline]);
  const staticStageData = useStaticStageDetail(selectedConfigStage);
  const overviewSidebarOpen =
    isOverview && !!selectedStage && staticStageData.stage !== null;
  const overviewL3Open = overviewSidebarOpen && overviewL3 !== null;
  const overviewLayoutClass = overviewL3Open
    ? 'inspector-with-l3'
    : overviewSidebarOpen
      ? 'inspector-with-sidebar'
      : '';
  const overviewStaticTexts = useMemo(() => {
    if (!selectedConfigStage) return undefined;
    const s = selectedConfigStage as {
      prompt?: string;
      command?: string;
      successMarker?: string;
      errorMarker?: string;
      timeout?: number;
      env?: Record<string, string>;
    };
    return {
      prompt: s.prompt ?? null,
      command: s.command ?? null,
      commandMeta: s.command
        ? {
            shell: 'sh -c',
            timeoutMs: s.timeout,
            successMarker: s.successMarker,
            errorMarker: s.errorMarker,
            env: s.env ?? {},
          }
        : null,
    };
  }, [selectedConfigStage]);

  // Esc cascade for overview inspector: L3 → sidebar.
  useEffect(() => {
    if (!isOverview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (overviewL3) setOverviewL3(null);
      else if (selectedStage) setSelectedStage(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOverview, selectedStage, overviewL3]);

  // Close L3 if stage selection changes.
  useEffect(() => {
    if (!selectedStage) setOverviewL3(null);
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

  useEffect(() => {
    if (!selectedStage && runningNode) setSelectedStage(runningNode.name);
  }, [selectedStage, runningNode?.name]);

  useEffect(() => {
    if (!selectedStage || !selectedNode) return;

    if (selectedNode.status === 'pending') {
      setNodeLog(selectedStage, []);
      return;
    }

    let cancelled = false;
    const loadNodeLog = () => {
      api
        .stage(selectedStage)
        .then((info) => {
          if (!cancelled) setNodeLog(selectedStage, info.logs.nodeTail ?? []);
        })
        .catch(() => {
          if (!cancelled) setNodeLog(selectedStage, []);
        });
    };

    loadNodeLog();
    const interval =
      selectedNode.status === 'running'
        ? window.setInterval(loadNodeLog, 1000)
        : null;

    return () => {
      cancelled = true;
      if (interval !== null) window.clearInterval(interval);
    };
  }, [
    selectedStage,
    selectedNode?.status,
    snapshot.projectDir,
    snapshot.latestRun?.runId,
  ]);

  async function refresh() {
    const cur = await api.current().catch(() => null);
    if (cur) setSnapshot(cur);
  }

  function handleLoad(loaded: PipelineSnapshot) {
    clearRunLog();
    clearNodeLog();
    setSelectedStage(null);
    setDetailStage(null);
    setSnapshot(loaded);
    setLoadNotice(
      loaded.initialized
        ? 'Initialized __art__ and loaded project.'
        : 'Loaded project.',
    );
    setShowPicker(false);
    api.preflightForce().then(setPreflight).catch(() => {});
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
    <div className="app-root">
      <div className="left-pane">
        {preflightBanner}
        {snapshot.pipelineError && (
          <div className="banner warn">{snapshot.pipelineError}</div>
        )}
        <ChatPanel projectDir={snapshot.projectDir} />
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
        {showPicker && <DirectoryPicker onLoad={handleLoad} />}
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
        {isOverview ? (
          <div className={`inspector ${overviewLayoutClass}`}>
            <div className="inspector-body">
              <div className="inspector-canvas">
                <PipelineGraph
                  nodes={displayGraph.nodes}
                  edges={displayGraph.edges}
                  onNodeClick={handleGraphNodeClick}
                />
              </div>
              {overviewSidebarOpen && (
                <StageSidebar
                  nodeId="root"
                  stageName={selectedStage!}
                  data={staticStageData}
                  onClose={() => setSelectedStage(null)}
                  onOpenPanel={(kind) => {
                    if (OVERVIEW_L3_KINDS.includes(kind)) setOverviewL3(kind);
                  }}
                  overview
                />
              )}
              {overviewL3Open && selectedStage && (
                <L3Panel
                  runId=""
                  nodeId="root"
                  stageName={selectedStage}
                  kind={overviewL3!}
                  stage={staticStageData.stage}
                  events={[]}
                  turns={[]}
                  diffSummary={null}
                  onClose={() => setOverviewL3(null)}
                  staticTexts={overviewStaticTexts}
                />
              )}
            </div>
            <RunLogTray lines={runLog} onClear={clearRunLog} />
          </div>
        ) : (
          <>
            <PipelineGraph
              nodes={displayGraph.nodes}
              edges={displayGraph.edges}
              onNodeClick={handleGraphNodeClick}
            />
            <div className="log-dock has-node-log">
              <RunLogTray lines={runLog} onClear={clearRunLog} />
              <NodeLogPanel
                node={selectedNode}
                lines={selectedStage ? (nodeLogs[selectedStage] ?? []) : []}
                onClear={clearNodeLog}
                onClose={() => setSelectedStage(null)}
                onDetails={setDetailStage}
              />
            </div>
            {detailStage && (
              <NodeModal
                name={detailStage}
                onClose={() => setDetailStage(null)}
              />
            )}
          </>
        )}
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
