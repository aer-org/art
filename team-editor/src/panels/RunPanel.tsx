import { useState, useEffect, useRef, useCallback } from 'react';

export interface RunManifest {
  runId: string;
  pid: number;
  startTime: string;
  endTime?: string;
  status: 'running' | 'success' | 'error' | 'cancelled';
  stages: Array<{ name: string; status: string; duration?: number }>;
  logFile?: string;
}

interface CurrentRunInfo {
  runId: string;
  pid: number;
  startTime: string;
}

export function useRunControls() {
  const [isRunning, setIsRunning] = useState(false);
  const [output, setOutput] = useState('');
  const [showPanel, setShowPanel] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  // Grace period: skip polling right after start (Docker takes time to spin up)
  const graceUntilRef = useRef(0);

  const fetchState = useCallback(() => {
    if (Date.now() < graceUntilRef.current) return; // skip during grace
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
          setOutput((prev) => prev + data.content);
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
    setOutput('');
    setShowPanel(true);
    setIsRunning(true);
    graceUntilRef.current = Date.now() + 60_000; // 60s grace for Docker startup
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

  return { isRunning, output, showPanel, setShowPanel, start, stop };
}

/** Bottom panel showing live run output and history */
export function RunOutputPanel({ output, isRunning, onClose }: {
  output: string;
  isRunning: boolean;
  onClose: () => void;
}) {
  const outputRef = useRef<HTMLPreElement>(null);
  const [runs, setRuns] = useState<RunManifest[]>([]);
  const [selectedLog, setSelectedLog] = useState<string | null>(null);
  const [logContent, setLogContent] = useState('');
  const [tab, setTab] = useState<'output' | 'history'>('output');

  // Auto-scroll
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  // Switch to output tab when running
  useEffect(() => {
    if (isRunning) setTab('output');
  }, [isRunning]);

  // Fetch history
  useEffect(() => {
    fetch('/api/runs')
      .then((r) => r.json())
      .then((data: RunManifest[]) => setRuns(data))
      .catch(() => {});
  }, [isRunning]); // refresh when run finishes

  const handleViewLog = useCallback(async (runId: string) => {
    setSelectedLog(runId);
    try {
      const resp = await fetch(`/api/runs/${runId}/log`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setLogContent(await resp.text());
    } catch {
      setLogContent('Log not available.');
    }
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
      <div style={{ display: 'flex', alignItems: 'center', padding: '4px 12px', gap: '8px', borderBottom: '1px solid #313244' }}>
        <button
          onClick={() => setTab('output')}
          style={{
            background: tab === 'output' ? '#313244' : 'transparent',
            color: tab === 'output' ? '#cdd6f4' : '#6c7086',
            border: 'none', padding: '4px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
          }}
        >
          Output {isRunning && '●'}
        </button>
        <button
          onClick={() => setTab('history')}
          style={{
            background: tab === 'history' ? '#313244' : 'transparent',
            color: tab === 'history' ? '#cdd6f4' : '#6c7086',
            border: 'none', padding: '4px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
          }}
        >
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
      <div style={{ flex: 1, overflow: 'auto', padding: '8px 12px' }}>
        {tab === 'output' && (
          <pre
            ref={outputRef}
            style={{
              margin: 0,
              color: '#cdd6f4',
              fontSize: '11px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              fontFamily: 'monospace',
            }}
          >
            {output || (isRunning ? 'Starting...' : 'No output yet. Click Run to start.')}
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
            <button
              onClick={() => { setSelectedLog(null); setLogContent(''); }}
              style={{ background: 'transparent', border: '1px solid #45475a', color: '#a6adc8', borderRadius: '3px', cursor: 'pointer', fontSize: '11px', marginBottom: '8px', padding: '2px 8px' }}
            >
              ← Back
            </button>
            <pre style={{ margin: 0, color: '#cdd6f4', fontSize: '10px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'monospace' }}>
              {logContent}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
