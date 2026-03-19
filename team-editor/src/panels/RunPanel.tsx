import { useState, useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export interface RunManifest {
  runId: string;
  pid: number;
  startTime: string;
  endTime?: string;
  status: 'running' | 'success' | 'error' | 'cancelled';
  stages: Array<{ name: string; status: string; duration?: number }>;
  logFile?: string;
  outputLogFile?: string;
}

interface CurrentRunInfo {
  runId: string;
  pid: number;
  startTime: string;
}

type OutputListener = (chunk: string) => void;

export function useRunControls() {
  const [isRunning, setIsRunning] = useState(false);
  const [showPanel, setShowPanel] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const graceUntilRef = useRef(0);
  // Listeners for raw output chunks (xterm subscribes here)
  const outputListenersRef = useRef<Set<OutputListener>>(new Set());
  const onOutputChunk = useCallback((fn: OutputListener) => {
    outputListenersRef.current.add(fn);
    return () => { outputListenersRef.current.delete(fn); };
  }, []);
  // Signal to clear terminal on new run
  const [clearSignal, setClearSignal] = useState(0);

  const fetchState = useCallback(() => {
    if (Date.now() < graceUntilRef.current) return;
    fetch('/api/runs/current')
      .then((r) => r.json())
      .then((data: CurrentRunInfo | null) => {
        setIsRunning(!!data);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchState();
    const interval = setInterval(fetchState, 5000);
    return () => clearInterval(interval);
  }, [fetchState]);

  const connectStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    const es = new EventSource('/api/runs/stream');
    eventSourceRef.current = es;
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'stdout' || data.type === 'stderr') {
          for (const fn of outputListenersRef.current) fn(data.content);
        } else if (data.type === 'run_stopped') {
          graceUntilRef.current = 0;
          setIsRunning(false);
          fetchState();
          es.close();
          eventSourceRef.current = null;
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [fetchState]);

  const start = useCallback(async () => {
    setClearSignal((n) => n + 1);
    setShowPanel(true);
    setIsRunning(true);
    graceUntilRef.current = Date.now() + 60_000;
    try {
      const resp = await fetch('/api/runs/start', { method: 'POST' });
      if (resp.status === 409) {
        graceUntilRef.current = 0;
        const data = await resp.json();
        alert(`이미 실행 중: ${data.runId}`);
        return;
      }
      if (!resp.ok) {
        graceUntilRef.current = 0;
        setIsRunning(false);
        throw new Error(`HTTP ${resp.status}`);
      }
      connectStream();
    } catch (err) {
      graceUntilRef.current = 0;
      setIsRunning(false);
      alert('Failed to start run: ' + (err as Error).message);
    }
  }, [connectStream]);

  const stop = useCallback(async () => {
    try {
      await fetch('/api/runs/stop', { method: 'POST' });
    } catch { /* best effort */ }
  }, []);

  return { isRunning, showPanel, setShowPanel, start, stop, onOutputChunk, clearSignal };
}

/** xterm.js terminal component */
function XtermOutput({ onOutputChunk, clearSignal }: {
  onOutputChunk: (fn: OutputListener) => () => void;
  clearSignal: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      fontSize: 12,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: {
        background: '#11111b',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
        selectionBackground: '#45475a',
        black: '#45475a',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#cba6f7',
        cyan: '#94e2d5',
        white: '#bac2de',
        brightBlack: '#585b70',
        brightRed: '#f38ba8',
        brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af',
        brightBlue: '#89b4fa',
        brightMagenta: '#cba6f7',
        brightCyan: '#94e2d5',
        brightWhite: '#a6adc8',
      },
      convertEol: true,
      scrollback: 10000,
      disableStdin: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const unsub = onOutputChunk((chunk) => {
      term.write(chunk);
    });

    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(containerRef.current);

    return () => {
      unsub();
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [onOutputChunk]);

  // Clear terminal on new run
  useEffect(() => {
    if (clearSignal > 0 && termRef.current) {
      termRef.current.clear();
      termRef.current.reset();
    }
  }, [clearSignal]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}

/** Bottom panel showing live run output and history */
export function RunOutputPanel({ isRunning, onClose, onOutputChunk, clearSignal }: {
  isRunning: boolean;
  onClose: () => void;
  onOutputChunk: (fn: OutputListener) => () => void;
  clearSignal: number;
}) {
  const detailedRef = useRef<HTMLDivElement>(null);
  const detailedAtBottomRef = useRef(true);
  const [runs, setRuns] = useState<RunManifest[]>([]);
  const [selectedLog, setSelectedLog] = useState<string | null>(null);
  const [logContent, setLogContent] = useState('');
  const [outputContent, setOutputContent] = useState('');
  const [historyTab, setHistoryTab] = useState<'output' | 'detailed'>('output');
  const [detailedLog, setDetailedLog] = useState('');
  const [tab, setTab] = useState<'output' | 'detailed' | 'history'>('output');
  const liveLogEsRef = useRef<EventSource | null>(null);

  // Auto-scroll detailed only when user is at the bottom
  useEffect(() => {
    if (detailedRef.current && detailedAtBottomRef.current) {
      detailedRef.current.scrollTop = detailedRef.current.scrollHeight;
    }
  }, [detailedLog]);

  // Reset to bottom when first opening detailed tab
  useEffect(() => {
    if (tab === 'detailed') {
      detailedAtBottomRef.current = true;
      if (detailedRef.current) {
        detailedRef.current.scrollTop = detailedRef.current.scrollHeight;
      }
    }
  }, [tab]);

  const handleDetailedScroll = useCallback(() => {
    const el = detailedRef.current;
    if (!el) return;
    // Consider "at bottom" if within 30px of the end
    detailedAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  }, []);

  // Switch to output tab when running
  useEffect(() => {
    if (isRunning) setTab('output');
  }, [isRunning]);

  // Connect/disconnect live-log SSE when detailed tab is active
  useEffect(() => {
    if (tab !== 'detailed') {
      if (liveLogEsRef.current) {
        liveLogEsRef.current.close();
        liveLogEsRef.current = null;
      }
      return;
    }
    setDetailedLog('');
    const es = new EventSource('/api/runs/live-log');
    liveLogEsRef.current = es;
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'log' && data.content) {
          setDetailedLog((prev) => prev + data.content);
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => {
      es.close();
      liveLogEsRef.current = null;
    };
    return () => {
      es.close();
      liveLogEsRef.current = null;
    };
  }, [tab]);

  // Fetch history
  useEffect(() => {
    fetch('/api/runs')
      .then((r) => r.json())
      .then((data: RunManifest[]) => setRuns(data))
      .catch(() => {});
  }, [isRunning]);

  const handleViewLog = useCallback(async (runId: string) => {
    setSelectedLog(runId);
    setHistoryTab('output');
    // Fetch both logs in parallel
    const [outputResp, detailedResp] = await Promise.all([
      fetch(`/api/runs/${runId}/output`).catch(() => null),
      fetch(`/api/runs/${runId}/log`).catch(() => null),
    ]);
    setOutputContent(
      outputResp?.ok ? await outputResp.text() : 'Output log not available.',
    );
    setLogContent(
      detailedResp?.ok ? await detailedResp.text() : 'Detailed log not available.',
    );
  }, []);

  const statusIcon = (status: string) => {
    switch (status) {
      case 'success': return '✅';
      case 'error': return '❌';
      case 'cancelled': return '⚠️';
      case 'running': return '🔄';
      default: return '⬜';
    }
  };

  const formatDuration = (ms?: number) => {
    if (!ms) return '-';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  const formatTime = (iso?: string) => {
    if (!iso) return '-';
    return new Date(iso).toLocaleTimeString();
  };

  const tabStyle = (t: string) => ({
    background: tab === t ? '#313244' : 'transparent',
    color: tab === t ? '#cdd6f4' : '#6c7086',
    border: 'none', padding: '4px 12px', borderRadius: '4px', cursor: 'pointer' as const, fontSize: '12px',
  });

  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      height: '280px',
      background: '#181825',
      borderTop: '2px solid #313244',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 100,
    }}>
      {/* Tab bar */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '4px 12px', gap: '4px', borderBottom: '1px solid #313244' }}>
        <button onClick={() => setTab('output')} style={tabStyle('output')}>
          Output {isRunning && '●'}
        </button>
        <button onClick={() => setTab('detailed')} style={tabStyle('detailed')}>
          Detailed
        </button>
        <button onClick={() => setTab('history')} style={tabStyle('history')}>
          History ({runs.length})
        </button>
        <div style={{ flex: 1 }} />
        <button
          onClick={onClose}
          style={{ background: 'transparent', border: 'none', color: '#6c7086', cursor: 'pointer', fontSize: '14px' }}
        >
          ✕
        </button>
      </div>

      {/* Content */}
      {/* xterm is always mounted but hidden when not active — prevents losing terminal state on tab switch */}
      <div style={{ flex: 1, overflow: 'hidden', display: tab === 'output' ? 'block' : 'none' }}>
        <XtermOutput onOutputChunk={onOutputChunk} clearSignal={clearSignal} />
      </div>
      <div
        ref={tab === 'detailed' ? detailedRef : undefined}
        onScroll={tab === 'detailed' ? handleDetailedScroll : undefined}
        style={{ flex: 1, overflow: 'auto', padding: '8px 12px', display: tab !== 'output' ? 'block' : 'none' }}
      >
        {tab === 'detailed' && (
          <pre
            style={{ margin: 0, color: '#a6e3a1', fontSize: '10px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'monospace' }}
          >
            {detailedLog || (isRunning ? 'Waiting for container logs...' : 'No pipeline log available. Run a pipeline first.')}
          </pre>
        )}

        {tab === 'history' && !selectedLog && (
          <div>
            {runs.map((run) => (
              <div
                key={run.runId}
                onClick={() => handleViewLog(run.runId)}
                style={{
                  padding: '6px 8px',
                  marginBottom: '2px',
                  background: '#1e1e2e',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '11px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>{statusIcon(run.status)} {run.runId.slice(4, 20)}</span>
                  <span style={{ color: '#6c7086' }}>{formatTime(run.startTime)}</span>
                </div>
                {run.stages.length > 0 && (
                  <div style={{ color: '#6c7086', marginTop: '2px' }}>
                    {run.stages.map((s) => `${statusIcon(s.status)}${s.name}(${formatDuration(s.duration)})`).join(' → ')}
                  </div>
                )}
              </div>
            ))}
            {runs.length === 0 && (
              <div style={{ color: '#6c7086', textAlign: 'center', padding: '16px' }}>No runs yet</div>
            )}
          </div>
        )}

        {tab === 'history' && selectedLog && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '8px' }}>
              <button
                onClick={() => { setSelectedLog(null); setLogContent(''); setOutputContent(''); }}
                style={{ background: 'transparent', border: '1px solid #45475a', color: '#a6adc8', borderRadius: '3px', cursor: 'pointer', fontSize: '11px', padding: '2px 8px' }}
              >
                ← Back
              </button>
              <button
                onClick={() => setHistoryTab('output')}
                style={{
                  background: historyTab === 'output' ? '#313244' : 'transparent',
                  color: historyTab === 'output' ? '#cdd6f4' : '#6c7086',
                  border: 'none', padding: '2px 10px', borderRadius: '3px', cursor: 'pointer', fontSize: '11px',
                }}
              >
                Output
              </button>
              <button
                onClick={() => setHistoryTab('detailed')}
                style={{
                  background: historyTab === 'detailed' ? '#313244' : 'transparent',
                  color: historyTab === 'detailed' ? '#cdd6f4' : '#6c7086',
                  border: 'none', padding: '2px 10px', borderRadius: '3px', cursor: 'pointer', fontSize: '11px',
                }}
              >
                Detailed
              </button>
            </div>
            <pre style={{ margin: 0, color: historyTab === 'detailed' ? '#a6e3a1' : '#cdd6f4', fontSize: '10px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'monospace' }}>
              {historyTab === 'output' ? outputContent : logContent}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
