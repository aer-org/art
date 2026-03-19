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

export function RunPanel() {
  const [runs, setRuns] = useState<RunManifest[]>([]);
  const [current, setCurrent] = useState<CurrentRunInfo | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [output, setOutput] = useState('');
  const [selectedLog, setSelectedLog] = useState<string | null>(null);
  const [logContent, setLogContent] = useState('');
  const outputRef = useRef<HTMLPreElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const fetchState = useCallback(() => {
    fetch('/api/runs/current')
      .then((r) => r.json())
      .then((data: CurrentRunInfo | null) => {
        setCurrent(data);
        setIsRunning(!!data);
      })
      .catch(() => {});
    fetch('/api/runs')
      .then((r) => r.json())
      .then((data: RunManifest[]) => setRuns(data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchState();
    const interval = setInterval(fetchState, 5000);
    return () => clearInterval(interval);
  }, [fetchState]);

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

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

  const handleStart = useCallback(async () => {
    setOutput('');
    setSelectedLog(null);
    try {
      const resp = await fetch('/api/runs/start', { method: 'POST' });
      if (resp.status === 409) {
        const data = await resp.json();
        alert(`이미 실행 중: ${data.runId}`);
        return;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setIsRunning(true);
      connectStream();
    } catch (err) {
      alert('Failed to start run: ' + (err as Error).message);
    }
  }, [connectStream]);

  const handleStop = useCallback(async () => {
    try {
      await fetch('/api/runs/stop', { method: 'POST' });
    } catch { /* best effort */ }
  }, []);

  const handleViewLog = useCallback(async (runId: string) => {
    setSelectedLog(runId);
    try {
      const resp = await fetch(`/api/runs/${runId}/log`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      setLogContent(text);
    } catch {
      setLogContent('Log not available.');
    }
  }, []);

  const formatDuration = (ms?: number) => {
    if (!ms) return '-';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case 'success': return '✅';
      case 'error': return '❌';
      case 'cancelled': return '⚠️';
      case 'running': return '🔄';
      default: return '⬜';
    }
  };

  const formatTime = (iso?: string) => {
    if (!iso) return '-';
    return new Date(iso).toLocaleString();
  };

  return (
    <div className="panel" style={{ maxHeight: '60vh', overflow: 'auto' }}>
      <div className="panel-header">
        <span>Pipeline Run</span>
      </div>
      <div className="panel-body" style={{ padding: '8px' }}>
        {/* Controls */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
          {isRunning ? (
            <button onClick={handleStop} style={{ background: '#ef4444', color: '#fff', border: 'none', padding: '6px 16px', borderRadius: '4px', cursor: 'pointer' }}>
              Stop
            </button>
          ) : (
            <button onClick={handleStart} style={{ background: '#22c55e', color: '#fff', border: 'none', padding: '6px 16px', borderRadius: '4px', cursor: 'pointer' }}>
              ▶ Run
            </button>
          )}
          {current && (
            <span style={{ fontSize: '12px', color: '#a6adc8', alignSelf: 'center' }}>
              {current.runId}
            </span>
          )}
        </div>

        {/* Live output */}
        {(isRunning || output) && (
          <pre
            ref={outputRef}
            style={{
              background: '#11111b',
              color: '#cdd6f4',
              padding: '8px',
              borderRadius: '4px',
              fontSize: '11px',
              maxHeight: '200px',
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              marginBottom: '8px',
            }}
          >
            {output || 'Starting...'}
          </pre>
        )}

        {/* Run history */}
        <div style={{ fontSize: '12px', color: '#a6adc8', marginBottom: '4px' }}>
          History ({runs.length})
        </div>
        <div style={{ maxHeight: '200px', overflow: 'auto' }}>
          {runs.map((run) => (
            <div
              key={run.runId}
              onClick={() => handleViewLog(run.runId)}
              style={{
                padding: '6px 8px',
                marginBottom: '2px',
                background: selectedLog === run.runId ? '#313244' : '#1e1e2e',
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
            <div style={{ color: '#6c7086', textAlign: 'center', padding: '8px' }}>
              No runs yet
            </div>
          )}
        </div>

        {/* Log viewer */}
        {selectedLog && (
          <div style={{ marginTop: '8px' }}>
            <div style={{ fontSize: '12px', color: '#a6adc8', marginBottom: '4px' }}>
              Log: {selectedLog}
              <button
                onClick={() => { setSelectedLog(null); setLogContent(''); }}
                style={{ marginLeft: '8px', fontSize: '10px', background: 'transparent', border: '1px solid #45475a', color: '#a6adc8', borderRadius: '3px', cursor: 'pointer' }}
              >
                close
              </button>
            </div>
            <pre
              style={{
                background: '#11111b',
                color: '#cdd6f4',
                padding: '8px',
                borderRadius: '4px',
                fontSize: '10px',
                maxHeight: '200px',
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {logContent}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
