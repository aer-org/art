import { useEffect, useState } from 'react';
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

// Mirrors app/server/chat-controller.ts:MODEL_OPTIONS so the run-bar
// dropdown stays in sync with the debugger's. Updated together when a
// new Claude release lands.
const MODEL_OPTIONS = [
  { id: '', label: 'Default' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];
const MODEL_LS_KEY = 'art:run:model';

export function RunBar({ snapshot, preflight, onChange, onSetup, onRunLog, onRunStarting }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<string>(() => {
    try {
      return localStorage.getItem(MODEL_LS_KEY) ?? '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(MODEL_LS_KEY, model);
    } catch {
      /* private mode etc. — ignore */
    }
  }, [model]);

  const status = snapshot.state?.status;
  const isRunning = !!snapshot.isRunning;
  const isRunStarting = !!snapshot.isRunStarting;
  const isStopping = !!snapshot.isStopping;
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
      await api.run(model ? { model } : undefined);
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
          <button className="danger" disabled={busy || isStopping} onClick={stop}>
            {isStopping ? 'Stopping…' : 'Stop'}
          </button>
        ) : isRunStarting ? (
          <button className="primary" disabled>Starting...</button>
        ) : (
          <>
            <select
              className="model-select"
              value={model}
              disabled={busy || !snapshot.projectDir}
              onChange={(e) => setModel(e.target.value)}
              title="Override the agent model for this run"
            >
              {MODEL_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button
              className="primary"
              disabled={busy || !snapshot.projectDir}
              onClick={run}
              title={setupNeeded ? 'Run with setup warning and visible logs' : 'Run pipeline'}
            >
              Run
            </button>
          </>
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
