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
  const eventSourceRef = useRef<EventSource | null>(null);

  const fetchState = useCallback(() => {
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
        if (data.type === 'run_stopped') {
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

  const stop = useCallback(async () => {
    try {
      await fetch('/api/runs/stop', { method: 'POST' });
    } catch { /* best effort */ }
  }, []);

  return { isRunning, start, stop };
}
