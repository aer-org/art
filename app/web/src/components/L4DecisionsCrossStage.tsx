/**
 * L4DecisionsCrossStage — every decision event across the whole run,
 * filterable by type. Each row links to the stage's sidebar via
 * `onSelectStage`.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';

import { api } from '../lib/api.ts';

interface Props {
  runId: string;
  onSelectStage?: (stageName: string) => void;
}

export function L4DecisionsCrossStage({ runId, onSelectStage }: Props) {
  const [events, setEvents] = useState<Array<Record<string, unknown>> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .runEvents(runId, { type: 'decision.', limit: 5000 })
      .then((r) => {
        if (!cancelled) setEvents(r.events);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const types = useMemo(() => {
    const set = new Set<string>();
    for (const ev of events ?? []) {
      if (typeof ev.type === 'string') set.add(ev.type);
    }
    return [...set].sort();
  }, [events]);

  const filtered = useMemo(
    () => (filter ? (events ?? []).filter((e) => e.type === filter) : events ?? []),
    [events, filter],
  );

  if (error) return <p className="error">{error}</p>;
  if (events === null) return <p className="muted">Loading…</p>;
  if (events.length === 0)
    return <p className="muted">No decision events recorded.</p>;

  return (
    <div className="l3-text">
      <div className="l3-meta">
        <span>{filtered.length} events</span>
        <span className="muted">filter:</span>
        <button
          className={`mount-tab ${filter === null ? 'active' : ''}`}
          onClick={() => setFilter(null)}
        >
          all
        </button>
        {types.map((t) => (
          <button
            key={t}
            className={`mount-tab ${filter === t ? 'active' : ''}`}
            onClick={() => setFilter(t)}
          >
            {t.replace('decision.', '')}
          </button>
        ))}
      </div>
      <table className="l3-table">
        <thead>
          <tr>
            <th>time</th>
            <th>stage</th>
            <th>type</th>
            <th>message</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((d, i) => {
            const isOpen = openIdx === i;
            const t = typeof d.time === 'string' ? d.time : '';
            const stage = typeof d.stageName === 'string' ? d.stageName : null;
            return (
              <Fragment key={i}>
                <tr
                  className={`turn-row ${isOpen ? 'open' : ''}`}
                  onClick={() => setOpenIdx(isOpen ? null : i)}
                >
                  <td>
                    <code>{t.slice(11, 23)}</code>
                  </td>
                  <td>
                    {stage ? (
                      <button
                        className="link-btn"
                        style={{ marginLeft: 0 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectStage?.(stage);
                        }}
                      >
                        {stage}
                      </button>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <code>{(d.type as string).replace('decision.', '')}</code>
                  </td>
                  <td>
                    <span className="muted">
                      {typeof d.message === 'string' ? d.message : '—'}
                    </span>
                  </td>
                </tr>
                {isOpen && (
                  <tr className="turn-detail">
                    <td colSpan={4}>
                      <pre className="l3-pre">{JSON.stringify(d, null, 2)}</pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
