import type { RunDetail } from '../lib/api.ts';
import { hrefFor } from '../router.tsx';

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
      <div className="inspector-cell run-id-cell">
        <a className="inspector-back" href={hrefFor('/runs')}>
          ← runs
        </a>
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
    </header>
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
