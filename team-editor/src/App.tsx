import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  type Connection,
  BackgroundVariant,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { StageNode } from './nodes/StageNode';
import { PropertiesPanel } from './panels/PropertiesPanel';
import { AgentListPanel } from './panels/AgentListPanel';
import { FilesPanel, type ProjectFile } from './panels/FilesPanel';
import { ImagesPanel, type ImageRegistry } from './panels/ImagesPanel';
import { useRunControls, RunOutputPanel } from './panels/RunPanel';
import { Onboarding } from './components/Onboarding';
import { AgentChat } from './components/AgentChat';
import { useAgentChat } from './hooks/useAgentChat';
import { FileEditor } from './components/FileEditor';
import { TextEditor } from './components/TextEditor';
import { deserialize } from './utils/deserialize';
import { serialize, validate } from './utils/serialize';
import { exportTeamZip, importTeamZip, importTeamFolder } from './utils/zip';
import type { PipelineConfig, PipelineStage, AgentConfig, AgentFiles } from './types';
import { DEFAULT_STAGE, DEFAULT_PIPELINE, DEFAULT_AGENT_FILES } from './types';

const nodeTypes = { stageNode: StageNode };

const params = new URLSearchParams(window.location.search);
const mode = params.get('mode') || 'single';
const isSingleMode = mode === 'single' || mode === 'init';
const isInitMode = mode === 'init';

export default function App() {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [selectedAgentIdx, setSelectedAgentIdx] = useState<number>(0);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<string>('');
  const [artDirs, setArtDirs] = useState<{ name: string; files: string[] }[]>([]);
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [dirsVersion, setDirsVersion] = useState(0);
  const [agentChatDone, setAgentChatDone] = useState(false);
  // Hook is always called (React rules) but only connects SSE in single mode
  const agentChatHook = useAgentChat();
  const agentChat = isSingleMode ? agentChatHook : null;
  const [imageRegistry, setImageRegistry] = useState<ImageRegistry>({});
  const [pipelineState, setPipelineState] = useState<{
    currentStage: string | null;
    completedStages: string[];
    status: string;
  } | null>(null);
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [promptEditor, setPromptEditor] = useState<{
    title: string;
    value: string;
    onChange: (value: string) => void;
  } | null>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const agentRunning = agentChat?.agentRunning ?? false;

  // Poll pipeline execution state for node highlighting
  useEffect(() => {
    if (!isSingleMode) return;
    const poll = () => {
      fetch('/api/pipeline-state')
        .then((r) => r.json())
        .then((state) => setPipelineState(state))
        .catch(() => {});
    };
    poll();
    const interval = setInterval(poll, 2000);
    return () => clearInterval(interval);
  }, []);

  const nodeTypes_ = useMemo(() => nodeTypes, []);

  const refreshDirs = useCallback(() => setDirsVersion((v) => v + 1), []);

  // Fetch __art__/ directory list in single mode
  useEffect(() => {
    if (!isSingleMode) return;
    fetch('/api/dirs')
      .then((r) => r.json())
      .then((dirs: { name: string; files: string[] }[]) => setArtDirs(dirs))
      .catch(() => {});
    fetch('/api/project-files')
      .then((r) => r.json())
      .then((files: ProjectFile[]) => setProjectFiles(files))
      .catch(() => {});
    fetch('/api/images')
      .then((r) => r.json())
      .then((reg: ImageRegistry) => setImageRegistry(reg))
      .catch(() => {});
  }, [dirsVersion]);

  const agent = agents[selectedAgentIdx] as AgentConfig | undefined;

  // Single-pipeline mode: load from API on mount
  useEffect(() => {
    if (!isSingleMode) return;
    fetch('/api/pipeline')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((pipeline: PipelineConfig) => {
        setAgents([{
          name: 'pipeline',
          folder: '',
          pipeline,
          files: { ...DEFAULT_AGENT_FILES },
        }]);
        setSelectedAgentIdx(0);
      })
      .catch((err) => {
        console.error('Failed to load pipeline:', err);
        // Start with empty pipeline so the user can still add stages
        setAgents([{
          name: 'pipeline',
          folder: '',
          pipeline: { ...DEFAULT_PIPELINE },
          files: { ...DEFAULT_AGENT_FILES },
        }]);
      });
  }, []);

  // nodes/edges as independent state — only deserialized on agent switch
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  useEffect(() => {
    if (!agent || agent.pipeline.stages.length === 0) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const result = deserialize(agent.pipeline);
    setNodes(result.nodes);
    setEdges(result.edges);
  }, [selectedAgentIdx, agents.length]);

  const syncPipeline = useCallback(
    (newNodes: Node[], newEdges: Edge[], overrideEntryStage?: string | undefined) => {
      setNodes(newNodes);
      setEdges(newEdges);
      setAgents((prev) => {
        const idx = selectedAgentIdx;
        if (idx >= prev.length) return prev;
        const a = prev[idx];
        const entryFromNodes = newNodes.find((n) => n.data.isEntry)?.id;
        const entry = overrideEntryStage !== undefined ? overrideEntryStage : (a.pipeline.entryStage || entryFromNodes);
        const pipeline = newNodes.length > 0
          ? serialize(newNodes, newEdges, entry)
          : { stages: [] };
        const next = [...prev];
        next[idx] = { ...a, pipeline };
        return next;
      });
    },
    [selectedAgentIdx],
  );

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      const hasRemoval = changes.some((c) => c.type === 'remove');
      const newNodes = applyNodeChanges(changes, nodesRef.current);
      setNodes(newNodes);
      if (hasRemoval) {
        const removedIds = new Set(
          changes.filter((c) => c.type === 'remove').map((c) => c.id),
        );
        const newEdges = edgesRef.current.filter(
          (e) => !removedIds.has(e.source) && !removedIds.has(e.target),
        );
        setEdges(newEdges);
        if (removedIds.has(selectedNodeId ?? '')) setSelectedNodeId(null);
        // If entry node was removed, reassign entry to first remaining node
        const entryRemoved = nodesRef.current.some(
          (n) => removedIds.has(n.id) && n.data.isEntry,
        );
        if (entryRemoved && newNodes.length > 0) {
          const updated = newNodes.map((n, i) => ({
            ...n,
            data: { ...n.data, isEntry: i === 0 },
          }));
          syncPipeline(updated, newEdges, updated[0].id);
        } else {
          syncPipeline(newNodes, newEdges);
        }
      }
    },
    [syncPipeline, selectedNodeId],
  );

  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      const hasRemoval = changes.some((c) => c.type === 'remove');
      const newEdges = applyEdgeChanges(changes, edgesRef.current);
      setEdges(newEdges);
      if (hasRemoval) {
        syncPipeline(nodesRef.current, newEdges);
      }
    },
    [syncPipeline],
  );

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      const filtered = edgesRef.current.filter(
        (e) => !(e.source === connection.source && e.sourceHandle === connection.sourceHandle),
      );
      const marker = connection.sourceHandle || 'STAGE_COMPLETE';
      // Find the source node to check if this is the first non-retry transition
      const sourceNode = nodesRef.current.find((n) => n.id === connection.source);
      const stage = sourceNode?.data?.stage as PipelineStage | undefined;
      const nonRetryTransitions = stage?.transitions?.filter((t) => !t.retry) || [];
      const isFirst = nonRetryTransitions.length > 0 && nonRetryTransitions[0].marker === marker;

      const color = isFirst ? '#22c55e' : '#ef4444';
      const newEdges = addEdge(
        {
          ...connection,
          type: 'default',
          style: isFirst
            ? { stroke: color, strokeWidth: 3, filter: 'drop-shadow(0 0 3px rgba(34, 197, 94, 0.4))' }
            : { stroke: color, strokeWidth: 3, strokeDasharray: '6 3', filter: 'drop-shadow(0 0 3px rgba(239, 68, 68, 0.4))' },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 20, height: 20 },
        },
        filtered,
      );
      syncPipeline(nodesRef.current, newEdges);
    },
    [syncPipeline],
  );

  const handleSetEntry = useCallback(
    (id: string) => {
      const newNodes = nodesRef.current.map((n) => ({
        ...n,
        data: { ...n.data, isEntry: n.id === id },
      }));
      syncPipeline(newNodes, edgesRef.current, id);
    },
    [syncPipeline],
  );

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) || null;

  const handleUpdateStage = useCallback(
    (id: string, stage: PipelineStage) => {
      const curNodes = nodesRef.current;
      const curEdges = edgesRef.current;
      const newNodes = curNodes.map((n) => {
        if (n.id !== id) return n;
        const oldId = n.id;
        const newId = stage.name;
        if (oldId !== newId) {
          setSelectedNodeId(newId);
          return { ...n, id: newId, data: { ...n.data, stage } };
        }
        return { ...n, data: { ...n.data, stage } };
      });
      // Update edges and entryStage if node was renamed
      const oldNode = curNodes.find((n) => n.id === id);
      let newEdges = curEdges;
      let renamedEntry: string | undefined;
      if (oldNode && oldNode.id !== stage.name) {
        newEdges = curEdges.map((e) => ({
          ...e,
          id: e.id.replace(id, stage.name),
          source: e.source === id ? stage.name : e.source,
          target: e.target === id ? stage.name : e.target,
        }));
        // If the renamed node was the entry, update entryStage
        if (oldNode.data.isEntry) {
          renamedEntry = stage.name;
        }
      }
      syncPipeline(newNodes, newEdges, renamedEntry);
    },
    [syncPipeline],
  );

  const handleDeleteStage = useCallback(
    (id: string) => {
      const deletedNode = nodesRef.current.find((n) => n.id === id);
      const newNodes = nodesRef.current.filter((n) => n.id !== id);
      const newEdges = edgesRef.current.filter((e) => e.source !== id && e.target !== id);
      setSelectedNodeId(null);
      // If deleting the entry node, clear entryStage (pass empty string to reset)
      if (deletedNode?.data?.isEntry) {
        syncPipeline(newNodes, newEdges, newNodes.length > 0 ? newNodes[0].id : undefined);
        // Mark new entry node
        if (newNodes.length > 0) {
          const updated = newNodes.map((n, i) => ({
            ...n,
            data: { ...n.data, isEntry: i === 0 },
          }));
          syncPipeline(updated, newEdges, updated[0].id);
          return;
        }
      }
      syncPipeline(newNodes, newEdges);
    },
    [syncPipeline],
  );

  const handleAddStage = useCallback(() => {
    const curNodes = nodesRef.current;
    const existingNames = new Set(curNodes.map((n) => n.id));
    let name = 'new_stage';
    let i = 1;
    while (existingNames.has(name)) name = `new_stage_${i++}`;

    const newStage: PipelineStage = { ...DEFAULT_STAGE, name };
    const maxX = curNodes.reduce((max, n) => Math.max(max, n.position.x), 0);
    const newNode: Node = {
      id: name,
      type: 'stageNode',
      position: { x: maxX + 300, y: 50 },
      data: { stage: newStage },
    };
    const newNodes = [...curNodes, newNode];
    setSelectedNodeId(name);
    syncPipeline(newNodes, edgesRef.current);
  }, [syncPipeline]);

  const handleAddAgent = useCallback((name: string, folder: string) => {
    setAgents((prev) => [
      ...prev,
      { name, folder, pipeline: { ...DEFAULT_PIPELINE }, files: { ...DEFAULT_AGENT_FILES } },
    ]);
    setSelectedAgentIdx(agents.length);
    setSelectedNodeId(null);
  }, [agents.length]);

  const handleDeleteAgent = useCallback(
    (idx: number) => {
      setAgents((prev) => prev.filter((_, i) => i !== idx));
      if (selectedAgentIdx >= agents.length - 1) {
        setSelectedAgentIdx(Math.max(0, agents.length - 2));
      }
      setSelectedNodeId(null);
    },
    [selectedAgentIdx, agents.length],
  );

  const handleSelectAgent = useCallback((idx: number) => {
    setSelectedAgentIdx(idx);
    setSelectedNodeId(null);
  }, []);

  const handleUpdateAgent = useCallback(
    (idx: number, partial: Partial<AgentConfig>) => {
      setAgents((prev) => {
        const next = [...prev];
        next[idx] = { ...next[idx], ...partial };
        return next;
      });
    },
    [],
  );

  const handleUpdateFiles = useCallback(
    (files: AgentFiles) => {
      setAgents((prev) => {
        const idx = selectedAgentIdx;
        if (idx >= prev.length) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx], files };
        return next;
      });
    },
    [selectedAgentIdx],
  );

  const handleSave = useCallback(async () => {
    if (!isSingleMode || !agent) return;
    const result_ = agent.pipeline.stages.length > 0
      ? deserialize(agent.pipeline)
      : null;
    if (result_) {
      const errors = validate(result_.nodes, result_.edges);
      if (errors.length > 0) {
        alert('Validation errors:\n' + errors.map((e) => '- ' + e.message).join('\n'));
        return;
      }
    }
    try {
      const resp = await fetch('/api/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(agent.pipeline, null, 2),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setSaveStatus('Saved');
      setTimeout(() => setSaveStatus(''), 2000);
    } catch (err) {
      alert('Failed to save: ' + (err as Error).message);
    }
  }, [agent]);

  const handleExport = useCallback(async () => {
    // Validate all agents
    for (const a of agents) {
      if (a.pipeline.stages.length > 0) {
        const result = deserialize(a.pipeline);
        const errors = validate(result.nodes, result.edges);
        if (errors.length > 0) {
          alert(`Validation errors in "${a.name}":\n` + errors.map((e) => '- ' + e.message).join('\n'));
          return;
        }
      }
    }
    if (agents.length === 0) {
      alert('Add at least one agent before exporting.');
      return;
    }
    await exportTeamZip(agents);
  }, [agents]);

  const handleLoadZip = useCallback(() => {
    zipInputRef.current?.click();
  }, []);

  const handleLoadFolder = useCallback(() => {
    folderInputRef.current?.click();
  }, []);

  const handleFolderChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    try {
      const loaded = await importTeamFolder(files);
      setAgents(loaded);
      setSelectedAgentIdx(0);
      setSelectedNodeId(null);
    } catch (err) {
      alert('Failed to load folder: ' + (err as Error).message);
    }
    e.target.value = '';
  }, []);

  const handleZipFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const loaded = await importTeamZip(file);
      setAgents(loaded);
      setSelectedAgentIdx(0);
      setSelectedNodeId(null);
    } catch (err) {
      alert('Failed to load project: ' + (err as Error).message);
    }
    e.target.value = '';
  }, []);

  const handleOpenChat = useCallback(() => {
    setAgentChatDone(false);
    // If agent is not running but we have a session, restart it
    if (agentChat && !agentChat.agentRunning) {
      agentChat.startAgent();
    }
  }, [agentChat]);
  const runControls = useRunControls();

  const hasHistory = agentChat ? agentChat.segments.length > 0 : false;
  const showAgentChat = isSingleMode && (agentRunning || hasHistory) && !agentChatDone;
  const showStaticOnboarding = isInitMode && !agentRunning && !hasHistory;

  return (
    <div className="app">
      {showAgentChat && agentChat && (
        <AgentChat onComplete={() => { setAgentChatDone(true); refreshDirs(); }} chat={agentChat} />
      )}
      {showStaticOnboarding && <Onboarding onPlanSaved={refreshDirs} />}
      {promptEditor && (
        <TextEditor
          title={promptEditor.title}
          initialValue={promptEditor.value}
          onSave={promptEditor.onChange}
          onClose={() => setPromptEditor(null)}
        />
      )}
      {editingFile && (
        <FileEditor
          filePath={editingFile}
          onClose={() => setEditingFile(null)}
          onSaved={refreshDirs}
        />
      )}
      <div className="toolbar">
        <span className="toolbar-title">{isSingleMode ? 'Pipeline Editor' : 'Team Editor'}</span>
        {agent && <button onClick={handleAddStage}>+ Stage</button>}
        {isSingleMode ? (
          <>
            <button onClick={handleSave}>Save</button>
            {saveStatus && <span className="save-status">{saveStatus}</span>}
            <button onClick={() => { runControls.setShowPanel((v) => !v); runControls.setInitialTab(null); }} style={{ background: '#313244', color: '#cdd6f4' }}>Terminal</button>
            {runControls.isRunning ? (
              <button onClick={runControls.stop} style={{ background: '#ef4444', color: '#fff' }}>Stop</button>
            ) : (
              <button onClick={async () => { await handleSave(); runControls.start(); }} style={{ background: '#22c55e', color: '#fff' }}>Run</button>
            )}
          </>
        ) : (
          <>
            <button onClick={handleLoadZip}>Load ZIP</button>
            <button onClick={handleLoadFolder}>Load Folder</button>
            <button onClick={handleExport}>Export</button>
            <input
              ref={zipInputRef}
              type="file"
              accept=".zip"
              style={{ display: 'none' }}
              onChange={handleZipFileChange}
            />
            <input
              ref={(el) => {
                (folderInputRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
                if (el) el.setAttribute('webkitdirectory', '');
              }}
              type="file"
              style={{ display: 'none' }}
              onChange={handleFolderChange}
            />
          </>
        )}
      </div>

      <div className="main">
        {!isSingleMode && (
          <AgentListPanel
            agents={agents}
            selectedIdx={selectedAgentIdx}
            onSelect={handleSelectAgent}
            onAdd={handleAddAgent}
            onDelete={handleDeleteAgent}
            onUpdate={handleUpdateAgent}
          />
        )}

        <div className="canvas">
          {agent ? (
            <ReactFlow
              key={selectedAgentIdx}
              nodes={nodes.map((n) => {
                if (!pipelineState || pipelineState.status !== 'running') return n;
                let runStatus: string | undefined;
                if (n.id === pipelineState.currentStage) runStatus = 'running';
                else if (pipelineState.completedStages?.includes(n.id)) runStatus = 'completed';
                if (!runStatus) return n;
                return { ...n, data: { ...n.data, runStatus } };
              })}
              edges={edges}
              nodeTypes={nodeTypes_}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={(_, node) => setSelectedNodeId(node.id)}
              onPaneClick={() => setSelectedNodeId(null)}
              onInit={(instance) => {
                setTimeout(() => instance.fitView(), 0);
              }}
              defaultEdgeOptions={{ type: 'default' }}
              deleteKeyCode={['Delete', 'Backspace']}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} color="#45475a" gap={20} />
              <Controls />
              <MiniMap
                nodeColor="#313244"
                maskColor="rgba(30, 30, 46, 0.7)"
                style={{ background: '#181825' }}
              />
            </ReactFlow>
          ) : (
            <div className="empty-canvas">
              {isSingleMode ? 'Add a stage to get started' : 'Add an agent to get started'}
            </div>
          )}
        </div>

        <div className="sidebar">
          <PropertiesPanel
            node={selectedNode}
            onUpdate={handleUpdateStage}
            onDelete={handleDeleteStage}
            onSetEntry={handleSetEntry}
            artDirs={artDirs.map((d) => d.name)}
            imageKeys={Object.keys(imageRegistry)}
            onEditPrompt={(stageId, prompt, onChange) =>
              setPromptEditor({ title: `Prompt: ${stageId}`, value: prompt, onChange })
            }
          />
          {agent && (
            <>
              <FilesPanel files={agent.files} onChange={handleUpdateFiles} artDirs={artDirs} projectFiles={isSingleMode ? projectFiles : undefined} onOpenChat={handleOpenChat} onOpenFile={isSingleMode ? setEditingFile : undefined} />
              {isSingleMode && <ImagesPanel registry={imageRegistry} onRefresh={refreshDirs} />}
            </>
          )}
        </div>
      </div>
      {isSingleMode && runControls.showPanel && (
        <RunOutputPanel
          isRunning={runControls.isRunning}
          onClose={() => { runControls.setShowPanel(false); runControls.setInitialTab(null); }}
          onOutputChunk={runControls.onOutputChunk}
          clearSignal={runControls.clearSignal}
          initialTab={runControls.initialTab}
        />
      )}
    </div>
  );
}
