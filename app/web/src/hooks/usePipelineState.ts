import { useEffect, useRef, useState } from 'react';
import { api, subscribeSSE, type NodeLogLine, type PipelineSnapshot } from '../lib/api.ts';

export interface RunLogLine {
  kind: 'stdout' | 'stderr';
  line: string;
}

export function usePipelineState() {
  const [snapshot, setSnapshot] = useState<PipelineSnapshot>({ projectDir: null });
  const [runLog, setRunLog] = useState<RunLogLine[]>([]);
  const [nodeLogs, setNodeLogs] = useState<Record<string, NodeLogLine[]>>({});
  const runLogRef = useRef<RunLogLine[]>([]);
  const nodeLogsRef = useRef<Record<string, NodeLogLine[]>>({});

  function appendRunLog(line: RunLogLine) {
    const next = [...runLogRef.current, line];
    runLogRef.current = next.length > 1000 ? next.slice(-1000) : next;
    setRunLog([...runLogRef.current]);
  }

  function resetRunLog() {
    runLogRef.current = [];
    setRunLog([]);
  }

  function appendNodeLog(line: NodeLogLine) {
    const current = nodeLogsRef.current[line.stage] ?? [];
    const nextLines = [...current, line];
    nodeLogsRef.current = {
      ...nodeLogsRef.current,
      [line.stage]: nextLines.length > 1000 ? nextLines.slice(-1000) : nextLines,
    };
    setNodeLogs({ ...nodeLogsRef.current });
  }

  function setNodeLog(stage: string, lines: NodeLogLine[]) {
    nodeLogsRef.current = {
      ...nodeLogsRef.current,
      [stage]: lines.slice(-1000),
    };
    setNodeLogs({ ...nodeLogsRef.current });
  }

  function clearNodeLog(stage?: string) {
    if (!stage) {
      nodeLogsRef.current = {};
      setNodeLogs({});
      return;
    }
    nodeLogsRef.current = {
      ...nodeLogsRef.current,
      [stage]: [],
    };
    setNodeLogs({ ...nodeLogsRef.current });
  }

  function markRunStarting() {
    setSnapshot((current) => ({
      ...current,
      isRunning: false,
      isRunStarting: true,
      graph: current.graph
        ? {
            ...current.graph,
            nodes: current.graph.nodes.map((node) => ({
              ...node,
              status: 'pending' as const,
            })),
          }
        : current.graph,
    }));
  }

  useEffect(() => {
    api.current().then(setSnapshot).catch(() => {});

    const dispose = subscribeSSE('/api/events', {
      snapshot: (data) => setSnapshot(data),
      'run-log-reset': () => {
        resetRunLog();
        clearNodeLog();
      },
      'run-log': (data) => {
        appendRunLog({ kind: data.kind, line: data.line });
      },
      'node-log': (data) => {
        appendNodeLog({
          stage: data.stage,
          kind: data.kind,
          line: data.line,
          sourceFile: data.sourceFile,
        });
      },
      'run-exit': () => {
        appendRunLog({ kind: 'stdout', line: '--- run event closed ---' });
      },
    });
    return dispose;
  }, []);

  return {
    snapshot,
    setSnapshot,
    runLog,
    nodeLogs,
    appendRunLog,
    appendNodeLog,
    setNodeLog,
    clearNodeLog,
    markRunStarting,
    resetRunLog,
    clearRunLog: resetRunLog,
  };
}
