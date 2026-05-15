import { useState } from 'react';

import { api, type RunDetail } from '../lib/api.ts';

function fmtDuration(ms?: number): string {
  if (typeof ms !== 'number') return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

function outcomeClass(run: RunDetail): string {
  if (run.state === 'live') return 'outcome-live';
  if (run.state === 'crashed') return 'outcome-crashed';
  if (run.outcome === 'success') return 'outcome-success';
  if (run.outcome === 'error') return 'outcome-error';
  return '';
}

export function RunDetailHeader({ run }: { run: RunDetail }) {
  return (
    <header className={`inspector-header ${outcomeClass(run)}`}>
      <div className="inspector-cell">
        <span className="label">run id</span>
        <span className="value large">{run.runId}</span>
      </div>
      <Cell label="state" value={run.state.toUpperCase()} />
      <Cell label="provider" value={(run.provider ?? '—').toUpperCase()} />
      <Cell
        label="outcome"
        value={(run.outcome ?? '—').toUpperCase()}
      />
      <Cell label="duration" value={fmtDuration(run.durationMs)} />
      <Cell label="host" value={run.hostname ?? '—'} />
      {run.state === 'live' && <StopButton />}
    </header>
  );
}

function StopButton() {
  // `api.stop()` targets whichever run is active in the server's
  // currently-loaded project. The RunDetail page only shows Live
  // state for that same active run (sealed/crashed runs don't
  // re-enter Live), so the click semantics match the visible run.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function onClick() {
    if (busy) return;
    if (!window.confirm('Send SIGTERM to the running pipeline?')) return;
    setBusy(true);
    setError(null);
    try {
      await api.stop();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="inspector-cell">
      <span className="label">control</span>
      <button
        className="run-detail-stop"
        onClick={onClick}
        disabled={busy}
        title="SIGTERM the active pipeline runner"
      >
        {busy ? 'stopping…' : '■ stop'}
      </button>
      {error && (
        <span className="error" style={{ fontSize: 10 }}>
          {error}
        </span>
      )}
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="inspector-cell">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
    </div>
  );
}
