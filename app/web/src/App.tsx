import { useEffect, useState } from 'react';
import { ChatPanel } from './components/ChatPanel.tsx';
import { DirectoryPicker } from './components/DirectoryPicker.tsx';
import { NodeModal } from './components/NodeModal.tsx';
import { NodeLogPanel } from './components/NodeLogPanel.tsx';
import { PipelineGraph } from './components/PipelineGraph.tsx';
import { RunBar } from './components/RunBar.tsx';
import { RunLogTray } from './components/RunLogTray.tsx';
import { SetupModal } from './components/SetupModal.tsx';
import { usePipelineState } from './hooks/usePipelineState.ts';
import { api, type PipelineSnapshot, type PreflightResponse } from './lib/api.ts';

export function App() {
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
  } = usePipelineState();
  const [selectedStage, setSelectedStage] = useState<string | null>(null);
  const [detailStage, setDetailStage] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(true);
  const [showSetup, setShowSetup] = useState(false);
  const [preflight, setPreflight] = useState<PreflightResponse | null>(null);
  const [loadNotice, setLoadNotice] = useState<string | null>(null);

  useEffect(() => {
    api.preflight().then(setPreflight).catch(() => {});
  }, []);

  useEffect(() => {
    // Hide picker after a project is loaded.
    if (snapshot.projectDir) setShowPicker(false);
  }, [snapshot.projectDir]);

  const selectedNode =
    snapshot.graph?.nodes.find((node) => node.name === selectedStage || node.id === selectedStage) ?? null;
  const runningNode = snapshot.graph?.nodes.find((node) => node.status === 'running') ?? null;

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
      api.stage(selectedStage)
        .then((info) => {
          if (!cancelled) setNodeLog(selectedStage, info.logs.nodeTail ?? []);
        })
        .catch(() => {
          if (!cancelled) setNodeLog(selectedStage, []);
        });
    };

    loadNodeLog();
    const interval =
      selectedNode.status === 'running' ? window.setInterval(loadNodeLog, 1000) : null;

    return () => {
      cancelled = true;
      if (interval !== null) window.clearInterval(interval);
    };
  }, [selectedStage, selectedNode?.status, snapshot.projectDir, snapshot.latestRun?.runId]);

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
    setLoadNotice(loaded.initialized ? 'Initialized __art__ and loaded project.' : 'Loaded project.');
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
      {!preflight.containerRuntime.present && ' No container runtime (docker/podman/udocker).'}
      {!preflight.debuggerSandbox.present && ' Debugger sandbox (`bwrap`) unavailable.'}
      {!preflight.auth.present && ' Claude auth is not configured. Open Initial Setup.'}
      {snapshot.projectDir && preflight.auth.chatReady === false && ' Left-panel Claude auth is not configured. Open Initial Setup.'}
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
        {showPicker && (
          <DirectoryPicker
            onLoad={handleLoad}
          />
        )}
        {!showPicker && (
          <div className="banner info" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{loadNotice ?? 'Loaded.'}</span>
            <button onClick={() => { setLoadNotice(null); setShowPicker(true); }}>Load another</button>
          </div>
        )}
        <PipelineGraph
          nodes={snapshot.graph?.nodes ?? []}
          edges={snapshot.graph?.edges ?? []}
          onNodeClick={(name) => setSelectedStage(name)}
        />
        <div className="log-dock has-node-log">
          <RunLogTray lines={runLog} onClear={clearRunLog} />
          <NodeLogPanel
            node={selectedNode}
            lines={selectedStage ? nodeLogs[selectedStage] ?? [] : []}
            onClear={clearNodeLog}
            onClose={() => setSelectedStage(null)}
            onDetails={setDetailStage}
          />
        </div>
        {detailStage && (
          <NodeModal name={detailStage} onClose={() => setDetailStage(null)} />
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
