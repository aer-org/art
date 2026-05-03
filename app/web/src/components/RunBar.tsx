import { useState } from 'react';
import { api, type PipelineSnapshot, type PreflightResponse } from '../lib/api.ts';
import type { RunLogLine } from '../hooks/usePipelineState.ts';

interface Props {
  snapshot: PipelineSnapshot;
  preflight: PreflightResponse | null;
  onChange: () => void;
  onSetup: () => void;
  onRunLog: (line: RunLogLine) => void;
  onRunStarting: () => void;
}

export function RunBar({ snapshot, preflight, onChange, onSetup, onRunLog, onRunStarting }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = snapshot.state?.status;
  const isRunning = !!snapshot.isRunning;
  const isRunStarting = !!snapshot.isRunStarting;
  const isRunBusy = isRunning || isRunStarting;
  const setupNeeded =
    preflight?.auth?.present === false ||
    (!!snapshot.projectDir && preflight?.auth?.chatReady === false) ||
    preflight?.debuggerSandbox?.present === false;
  const dotClass = isRunBusy
    ? 'running'
    : status === 'success'
      ? 'success'
      : status === 'error'
        ? 'error'
        : '';
  const statusLabel = isRunStarting
    ? 'Starting'
    : isRunning
      ? 'Running'
      : status === 'success'
        ? 'Success'
        : status === 'error'
          ? 'Error'
          : 'Idle';

  async function run() {
    setBusy(true);
    setError(null);
    onRunStarting();
    try {
      await api.run();
      onChange();
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      onRunLog({ kind: 'stderr', line: message });
      onChange();
    } finally {
      setBusy(false);
    }
  }
  async function stop() {
    setBusy(true);
    setError(null);
    try {
      await api.stop();
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="run-bar">
        <span className={`status-dot ${dotClass}`} title={statusLabel} />
        <span className="run-state-label">{statusLabel}</span>
        <span className="project-path">{snapshot.projectDir ?? '(no project loaded)'}</span>
        {isRunning ? (
          <button className="danger" disabled={busy} onClick={stop}>Stop</button>
        ) : isRunStarting ? (
          <button className="primary" disabled>Starting...</button>
        ) : (
          <button
            className="primary"
            disabled={busy || !snapshot.projectDir}
            onClick={run}
            title={setupNeeded ? 'Run with setup warning and visible logs' : 'Run pipeline'}
          >
            Run
          </button>
        )}
        <button
          className={setupNeeded ? 'warn' : ''}
          disabled={busy}
          onClick={onSetup}
        >
          Initial Setup
        </button>
      </div>
      {error && <div className="banner">{error}</div>}
    </>
  );
}
