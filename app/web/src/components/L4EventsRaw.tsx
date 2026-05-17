/**
 * L4EventsRaw — escape hatch for the events.jsonl tail. Useful for
 * debugging the recorder shim itself. Filter by type prefix; one event
 * per line.
 */
import { useEffect, useMemo, useState } from 'react';

import { api } from '../lib/api.ts';

interface Props {
  runId: string;
}

export function L4EventsRaw({ runId }: Props) {
  const [events, setEvents] = useState<Array<Record<string, unknown>> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState('');
  const [limit, setLimit] = useState(1000);

  useEffect(() => {
    let cancelled = false;
    api
      .runEvents(runId, { limit })
      .then((r) => {
        if (!cancelled) setEvents(r.events);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, limit]);

  const filtered = useMemo(() => {
    if (!events) return [];
    if (!typeFilter) return events;
    return events.filter(
      (e) => typeof e.type === 'string' && e.type.includes(typeFilter),
    );
  }, [events, typeFilter]);

  if (error) return <p className="error">{error}</p>;
  if (events === null) return <p className="muted">Loading…</p>;

  return (
    <div className="l3-text">
      <div className="l3-meta">
        <span>{filtered.length} / {events.length} events</span>
        <span className="muted">type contains</span>
        <input
          className="raw-filter"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          placeholder="e.g. decision."
          spellCheck={false}
        />
        <span className="muted">limit</span>
        <select
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          className="tail-select"
        >
          <option value={500}>500</option>
          <option value={1000}>1000</option>
          <option value={5000}>5000</option>
        </select>
      </div>
      <pre className="l3-pre l3-stream">
        {filtered.map((e) => JSON.stringify(e)).join('\n')}
      </pre>
    </div>
  );
}
