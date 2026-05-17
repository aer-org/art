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
import { useEffect, useMemo, useState } from 'react';

import { api, type RunHeader, type RunState } from '../lib/api.ts';
import { hrefFor } from '../router.tsx';

const POLL_MS = 5000;
const STATES: RunState[] = ['live', 'crashed', 'sealed'];

export function RunsListPage(props: { projectDir: string | null }): JSX.Element {
  const [runs, setRuns] = useState<RunHeader[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState<Set<RunState>>(
    () => new Set(STATES),
  );

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
      <RunsFilterBar
        query={query}
        setQuery={setQuery}
        stateFilter={stateFilter}
        setStateFilter={setStateFilter}
        total={runs.length}
      />
      <RunsTable
        runs={runs}
        query={query}
        stateFilter={stateFilter}
      />
    </div>
  );
}

function RunsFilterBar({
  query,
  setQuery,
  stateFilter,
  setStateFilter,
  total,
}: {
  query: string;
  setQuery: (s: string) => void;
  stateFilter: Set<RunState>;
  setStateFilter: (s: Set<RunState>) => void;
  total: number;
}): JSX.Element {
  return (
    <div className="runs-filter">
      <input
        className="runs-search"
        placeholder="search runId / provider / outcome…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        spellCheck={false}
      />
      <div className="runs-state-chips">
        {STATES.map((s) => (
          <button
            key={s}
            className={`mount-tab ${stateFilter.has(s) ? 'active' : ''}`}
            onClick={() => {
              const next = new Set(stateFilter);
              if (next.has(s)) next.delete(s);
              else next.add(s);
              setStateFilter(next);
            }}
          >
            {s}
          </button>
        ))}
      </div>
      <span className="muted" style={{ marginLeft: 'auto', fontSize: 11 }}>
        {total} total
      </span>
    </div>
  );
}

function RunsTable({
  runs,
  query,
  stateFilter,
}: {
  runs: RunHeader[];
  query: string;
  stateFilter: Set<RunState>;
}): JSX.Element {
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return runs.filter((r) => {
      if (!stateFilter.has(r.state)) return false;
      if (!q) return true;
      return (
        r.runId.toLowerCase().includes(q) ||
        (r.provider ?? '').toLowerCase().includes(q) ||
        (r.outcome ?? '').toLowerCase().includes(q)
      );
    });
  }, [runs, query, stateFilter]);

  if (filtered.length === 0) {
    return <p className="muted">No runs match the current filter.</p>;
  }

  return (
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
        {filtered.map((r) => (
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
