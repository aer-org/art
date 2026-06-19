import { useEffect, useRef, useState } from 'react';
import {
  api,
  subscribeSSE,
  type NodeLogLine,
  type PipelineSnapshot,
} from '../lib/api.ts';

export interface RunLogLine {
  kind: 'stdout' | 'stderr';
  line: string;
  /** Monotonic counter assigned at append time. Stable across array
   * shifts (slice(-1000)) so RunLogTray can use it as a React key
   * without triggering whole-list re-reconciliation on append.
   * Callers may omit `seq` when appending; `appendRunLog` stamps it. */
  seq?: number;
}

const MAX_RUN_LOG = 1000;
const MAX_NODE_LOG = 1000;

export function usePipelineState() {
  const [snapshot, setSnapshot] = useState<PipelineSnapshot>({
    projectDir: null,
  });
  const [runLog, setRunLog] = useState<RunLogLine[]>([]);
  const [nodeLogs, setNodeLogs] = useState<Record<string, NodeLogLine[]>>({});
  const runLogSeqRef = useRef(0);

  function appendRunLog(line: RunLogLine) {
    const stamped: RunLogLine =
      typeof line.seq === 'number'
        ? line
        : { ...line, seq: ++runLogSeqRef.current };
    setRunLog((prev) => {
      const next = [...prev, stamped];
      return next.length > MAX_RUN_LOG ? next.slice(-MAX_RUN_LOG) : next;
    });
  }

  function resetRunLog() {
    setRunLog([]);
  }

  function appendNodeLog(line: NodeLogLine) {
    setNodeLogs((prev) => {
      const current = prev[line.stage] ?? [];
      const nextLines = [...current, line];
      return {
        ...prev,
        [line.stage]:
          nextLines.length > MAX_NODE_LOG
            ? nextLines.slice(-MAX_NODE_LOG)
            : nextLines,
      };
    });
  }

  function setNodeLog(stage: string, lines: NodeLogLine[]) {
    setNodeLogs((prev) => ({
      ...prev,
      [stage]: lines.slice(-MAX_NODE_LOG),
    }));
  }

  function clearNodeLog(stage?: string) {
    if (!stage) {
      setNodeLogs({});
      return;
    }
    setNodeLogs((prev) => ({ ...prev, [stage]: [] }));
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
    api
      .current()
      .then(setSnapshot)
      .catch(() => {});

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
    // appendRunLog / appendNodeLog / setNodeLog / clearNodeLog are
    // freshly created each render but capture only refs and the stable
    // useState setters, so binding them once is safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
