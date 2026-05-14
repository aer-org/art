/**
 * RunsListPage — archived run list (newest first).
 *
 * Reads /api/runs once on mount + every 5s while the page is open so a
 * live run that becomes sealed reflects without a manual refresh. Static
 * sealed runs would only refresh on hashchange + back-nav anyway.
 *
 * No filters yet; sort is server-side (newest first). Phase J adds search
 * + filter chips.
 */
import { useEffect, useState } from 'react';

import { api, type RunHeader } from '../lib/api.ts';
import { hrefFor } from '../router.tsx';

const POLL_MS = 5000;

export function RunsListPage(props: { projectDir: string | null }): JSX.Element {
  const [runs, setRuns] = useState<RunHeader[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.projectDir) return;
    let cancelled = false;
    const load = () => {
      api
        .listRuns()
        .then((r) => {
          if (!cancelled) {
            setRuns(r.runs);
            setError(null);
          }
        })
        .catch((err: Error) => {
          if (!cancelled) setError(err.message);
        });
    };
    load();
    const t = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [props.projectDir]);

  if (!props.projectDir) {
    return (
      <div className="runs-page">
        <p className="muted">No project loaded. Go to Live tab to pick a project.</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="runs-page">
        <p className="error">Failed to load runs: {error}</p>
      </div>
    );
  }

  if (runs === null) {
    return (
      <div className="runs-page">
        <p className="muted">Loading runs…</p>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="runs-page">
        <p className="muted">
          No runs archived yet. Trigger one from the Live tab.
        </p>
      </div>
    );
  }

  return (
    <div className="runs-page">
      <table className="runs-table">
        <thead>
          <tr>
            <th>Run ID</th>
            <th>State</th>
            <th>Started</th>
            <th>Duration</th>
            <th>Outcome</th>
            <th>Stages</th>
            <th>Provider</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.runId}>
              <td>
                <a href={hrefFor(`/runs/${encodeURIComponent(r.runId)}`)}>
                  <code>{r.runId}</code>
                </a>
              </td>
              <td>
                <StateChip state={r.state} />
              </td>
              <td>
                <code>{r.startTime ?? '-'}</code>
              </td>
              <td>{formatDuration(r.durationMs)}</td>
              <td>
                <OutcomeChip outcome={r.outcome} />
              </td>
              <td>{formatStages(r)}</td>
              <td>{r.provider ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StateChip({ state }: { state: RunHeader['state'] }): JSX.Element {
  const cls =
    state === 'live'
      ? 'state-live'
      : state === 'sealed'
        ? 'state-sealed'
        : 'state-crashed';
  return <span className={`chip ${cls}`}>{state}</span>;
}

function OutcomeChip({
  outcome,
}: {
  outcome: RunHeader['outcome'];
}): JSX.Element {
  if (!outcome) return <span className="muted">-</span>;
  const cls = outcome === 'success' ? 'outcome-success' : 'outcome-error';
  return <span className={`chip ${cls}`}>{outcome}</span>;
}

function formatDuration(ms: number | undefined): string {
  if (typeof ms !== 'number') return '-';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}m` : `${m}m${r}s`;
}

function formatStages(r: RunHeader): string {
  if (typeof r.totalStages !== 'number') return '-';
  const failed = r.failedStages ?? 0;
  return `${r.totalStages - failed}/${r.totalStages}`;
}
