import { Fragment, useState } from 'react';

interface Props {
  turns: Array<Record<string, unknown>>;
}

export function L3TurnsTable({ turns }: Props) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  if (turns.length === 0) {
    return <p className="muted">No turns recorded.</p>;
  }

  const tot = aggregate(turns);

  return (
    <div className="l3-text">
      <div className="l3-meta">
        <span>
          {turns.length} turns · {tot.tokensIn}→{tot.tokensOut} tok
          {tot.latency > 0 && (
            <span className="muted"> · {(tot.latency / 1000).toFixed(1)}s</span>
          )}
          {tot.cost > 0 && (
            <span className="muted"> · ${tot.cost.toFixed(4)}</span>
          )}
        </span>
      </div>
      <table className="l3-table turns-table">
        <thead>
          <tr>
            <th>#</th>
            <th>model</th>
            <th className="num">in</th>
            <th className="num">out</th>
            <th className="num">cache</th>
            <th className="num">latency</th>
            <th>finish</th>
          </tr>
        </thead>
        <tbody>
          {turns.map((t, i) => {
            const isOpen = openIdx === i;
            return (
              <Fragment key={i}>
                <tr
                  className={`turn-row ${isOpen ? 'open' : ''}`}
                  onClick={() => setOpenIdx(isOpen ? null : i)}
                >
                  <td>
                    <code>{pad(i + 1)}</code>
                  </td>
                  <td>
                    <code>{strOr(t.model, '—')}</code>
                  </td>
                  <td className="num">{numOr(t.tokensIn)}</td>
                  <td className="num">{numOr(t.tokensOut)}</td>
                  <td className="num muted">{numOr(t.cacheReadTokens)}</td>
                  <td className="num">{fmtLatency(t.latencyMs)}</td>
                  <td>{strOr(t.finishReason, '—')}</td>
                </tr>
                {isOpen && (
                  <tr className="turn-detail">
                    <td colSpan={7}>
                      <pre className="l3-pre">
                        {JSON.stringify(t, null, 2)}
                      </pre>
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

function aggregate(turns: Array<Record<string, unknown>>) {
  let tokensIn = 0;
  let tokensOut = 0;
  let latency = 0;
  let cost = 0;
  for (const t of turns) {
    if (typeof t.tokensIn === 'number') tokensIn += t.tokensIn;
    if (typeof t.tokensOut === 'number') tokensOut += t.tokensOut;
    if (typeof t.latencyMs === 'number') latency += t.latencyMs;
    if (typeof t.costUsd === 'number') cost += t.costUsd;
  }
  return { tokensIn, tokensOut, latency, cost };
}

function pad(n: number): string {
  return String(n).padStart(3, '0');
}

function strOr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function numOr(v: unknown): string {
  return typeof v === 'number' ? v.toLocaleString() : '—';
}

function fmtLatency(ms: unknown): string {
  if (typeof ms !== 'number') return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
