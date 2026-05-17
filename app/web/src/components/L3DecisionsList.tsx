import { Fragment, useMemo, useState } from 'react';

interface Props {
  events: Array<Record<string, unknown>>;
}

export function L3DecisionsList({ events }: Props) {
  const decisions = useMemo(
    () =>
      events.filter(
        (e) => typeof e.type === 'string' && e.type.startsWith('decision.'),
      ),
    [events],
  );
  const types = useMemo(() => {
    const set = new Set<string>();
    for (const d of decisions) {
      if (typeof d.type === 'string') set.add(d.type);
    }
    return [...set].sort();
  }, [decisions]);

  const [filter, setFilter] = useState<string | null>(null);
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  const filtered = useMemo(
    () => (filter ? decisions.filter((d) => d.type === filter) : decisions),
    [decisions, filter],
  );

  if (decisions.length === 0) {
    return <p className="muted">No decision events for this stage.</p>;
  }

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
            <th>type</th>
            <th>message</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((d, i) => {
            const isOpen = openIdx === i;
            const t = typeof d.time === 'string' ? d.time : '';
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
                    <td colSpan={3}>
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
