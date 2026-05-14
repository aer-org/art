/**
 * L4CostView — per-stage cost / token breakdown. Pure SVG stacked bar
 * with one row per stage that recorded turns, plus aggregate totals.
 * Reads /api/runs/:id/stages (turnSum already aggregated server-side).
 */
import { useEffect, useMemo, useState } from 'react';

import { api, type AllStageRecord } from '../lib/api.ts';

interface Props {
  runId: string;
}

const ROW_H = 22;
const PAD_L = 220;
const PAD_R = 24;
const PAD_T = 32;
const PAD_B = 28;

export function L4CostView({ runId }: Props) {
  const [stages, setStages] = useState<AllStageRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'tokens' | 'cost' | 'latency'>('tokens');

  useEffect(() => {
    let cancelled = false;
    api
      .runStages(runId)
      .then((r) => {
        if (!cancelled) setStages(r.stages);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const filtered = useMemo(
    () => (stages ?? []).filter((s) => s.turnCount > 0),
    [stages],
  );

  const totals = useMemo(() => {
    let tokensIn = 0;
    let tokensOut = 0;
    let cacheReadTokens = 0;
    let costUsd = 0;
    let latency = 0;
    let turns = 0;
    for (const s of filtered) {
      tokensIn += s.turnSum.tokensIn;
      tokensOut += s.turnSum.tokensOut;
      cacheReadTokens += s.turnSum.cacheReadTokens;
      costUsd += s.turnSum.costUsd;
      latency += s.turnSum.latencyMs;
      turns += s.turnCount;
    }
    return { tokensIn, tokensOut, cacheReadTokens, costUsd, latency, turns };
  }, [filtered]);

  if (error) return <p className="error">{error}</p>;
  if (stages === null) return <p className="muted">Loading…</p>;
  if (filtered.length === 0)
    return (
      <p className="muted">No turn data — command-mode runs or pre-Phase 5 archives.</p>
    );

  const W = 880;
  const H = PAD_T + filtered.length * ROW_H + PAD_B;
  const max = filtered.reduce((m, s) => {
    if (mode === 'tokens')
      return Math.max(m, s.turnSum.tokensIn + s.turnSum.tokensOut);
    if (mode === 'cost') return Math.max(m, s.turnSum.costUsd);
    return Math.max(m, s.turnSum.latencyMs);
  }, 1);
  const scaleX = (v: number) =>
    PAD_L + (v / max) * (W - PAD_L - PAD_R);

  return (
    <div className="l3-text">
      <div className="l3-meta">
        <span>
          {totals.turns} turns · {totals.tokensIn.toLocaleString()}→
          {totals.tokensOut.toLocaleString()} tok
        </span>
        {totals.costUsd > 0 && (
          <span className="muted">· ${totals.costUsd.toFixed(4)}</span>
        )}
        {totals.latency > 0 && (
          <span className="muted">
            · {(totals.latency / 1000).toFixed(1)}s
          </span>
        )}
        <div className="mount-tabs" style={{ marginLeft: 'auto' }}>
          <button
            className={`mount-tab ${mode === 'tokens' ? 'active' : ''}`}
            onClick={() => setMode('tokens')}
          >
            tokens
          </button>
          <button
            className={`mount-tab ${mode === 'cost' ? 'active' : ''}`}
            onClick={() => setMode('cost')}
          >
            cost
          </button>
          <button
            className={`mount-tab ${mode === 'latency' ? 'active' : ''}`}
            onClick={() => setMode('latency')}
          >
            latency
          </button>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMinYMin meet"
        className="gantt-svg"
      >
        {filtered.map((s, i) => {
          const y = PAD_T + i * ROW_H;
          const tin = scaleX(s.turnSum.tokensIn);
          const tout = scaleX(s.turnSum.tokensIn + s.turnSum.tokensOut);
          const costX = scaleX(s.turnSum.costUsd);
          const latX = scaleX(s.turnSum.latencyMs);
          return (
            <g key={`${s.nodeId}/${s.stageName}`} className="gantt-row">
              <text
                x={PAD_L - 8}
                y={y + ROW_H / 2 + 4}
                textAnchor="end"
                className="gantt-label"
              >
                {ellipsize(s.stageName, 28)}
              </text>
              {mode === 'tokens' && (
                <>
                  <rect
                    x={PAD_L}
                    y={y + 4}
                    width={Math.max(0, tin - PAD_L)}
                    height={ROW_H - 8}
                    className="gantt-bar cost-in"
                  >
                    <title>{`tokensIn: ${s.turnSum.tokensIn.toLocaleString()}`}</title>
                  </rect>
                  <rect
                    x={tin}
                    y={y + 4}
                    width={Math.max(0, tout - tin)}
                    height={ROW_H - 8}
                    className="gantt-bar cost-out"
                  >
                    <title>{`tokensOut: ${s.turnSum.tokensOut.toLocaleString()}`}</title>
                  </rect>
                  <text
                    x={tout + 6}
                    y={y + ROW_H / 2 + 4}
                    className="gantt-tick-label"
                  >
                    {(
                      s.turnSum.tokensIn + s.turnSum.tokensOut
                    ).toLocaleString()}
                  </text>
                </>
              )}
              {mode === 'cost' && (
                <>
                  <rect
                    x={PAD_L}
                    y={y + 4}
                    width={Math.max(0, costX - PAD_L)}
                    height={ROW_H - 8}
                    className="gantt-bar cost-cost"
                  >
                    <title>{`$${s.turnSum.costUsd.toFixed(4)}`}</title>
                  </rect>
                  <text
                    x={costX + 6}
                    y={y + ROW_H / 2 + 4}
                    className="gantt-tick-label"
                  >
                    ${s.turnSum.costUsd.toFixed(4)}
                  </text>
                </>
              )}
              {mode === 'latency' && (
                <>
                  <rect
                    x={PAD_L}
                    y={y + 4}
                    width={Math.max(0, latX - PAD_L)}
                    height={ROW_H - 8}
                    className="gantt-bar cost-lat"
                  >
                    <title>{`${(s.turnSum.latencyMs / 1000).toFixed(2)}s`}</title>
                  </rect>
                  <text
                    x={latX + 6}
                    y={y + ROW_H / 2 + 4}
                    className="gantt-tick-label"
                  >
                    {(s.turnSum.latencyMs / 1000).toFixed(1)}s
                  </text>
                </>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function ellipsize(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
