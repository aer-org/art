/**
 * L4Timeline — horizontal Gantt of stage executions.
 *
 * Each stage gets one bar: start = finishedAt - durationMs, end =
 * finishedAt, colored by result. Y-axis = stage name (one row per stage),
 * X-axis = relative time from run start. Hovering a bar surfaces the
 * marker + duration. Pure SVG; no chart library.
 */
import { useEffect, useMemo, useState } from 'react';

import { api, type AllStageRecord } from '../lib/api.ts';

interface Props {
  runId: string;
  onSelectStage?: (stageName: string) => void;
}

const ROW_H = 22;
const PAD_L = 220;
const PAD_R = 24;
const PAD_T = 32;
const PAD_B = 28;

interface Bar {
  rec: AllStageRecord;
  startMs: number;
  endMs: number;
}

export function L4Timeline({ runId, onSelectStage }: Props) {
  const [stages, setStages] = useState<AllStageRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const bars = useMemo(() => buildBars(stages ?? []), [stages]);
  const range = useMemo(() => computeRange(bars), [bars]);

  if (error) return <p className="error">{error}</p>;
  if (stages === null) return <p className="muted">Loading…</p>;
  if (bars.length === 0)
    return (
      <p className="muted">
        No stages with durationMs + finishedAt — timeline needs sealed runs.
      </p>
    );

  const W = 880;
  const H = PAD_T + bars.length * ROW_H + PAD_B;
  const scaleX = (ms: number) =>
    PAD_L + ((ms - range.startMs) / range.totalMs) * (W - PAD_L - PAD_R);
  const ticks = makeTicks(range.totalMs);

  return (
    <div className="l3-text">
      <div className="l3-meta">
        <span>{bars.length} stages</span>
        <span className="muted">·</span>
        <span>{fmtDur(range.totalMs)} total</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMinYMin meet"
        className="gantt-svg"
      >
        {/* x-axis ticks */}
        {ticks.map((t, i) => {
          const x = scaleX(range.startMs + t);
          return (
            <g key={i}>
              <line
                x1={x}
                x2={x}
                y1={PAD_T - 8}
                y2={H - PAD_B + 4}
                className="gantt-grid"
              />
              <text
                x={x}
                y={PAD_T - 12}
                className="gantt-tick-label"
                textAnchor="middle"
              >
                {fmtDur(t)}
              </text>
            </g>
          );
        })}
        {/* bars */}
        {bars.map((bar, i) => {
          const y = PAD_T + i * ROW_H;
          const x1 = scaleX(bar.startMs);
          const x2 = scaleX(bar.endMs);
          const width = Math.max(2, x2 - x1);
          const result = (bar.rec.stage as { result?: string } | null)?.result;
          const cls =
            result === 'success'
              ? 'success'
              : result === 'error'
                ? 'error'
                : 'unknown';
          const marker = (
            bar.rec.stage as { matchedMarker?: string } | null
          )?.matchedMarker;
          return (
            <g
              key={`${bar.rec.nodeId}/${bar.rec.stageName}`}
              className="gantt-row"
              onClick={() => onSelectStage?.(bar.rec.stageName)}
              style={{ cursor: onSelectStage ? 'pointer' : 'default' }}
            >
              <text
                x={PAD_L - 8}
                y={y + ROW_H / 2 + 4}
                textAnchor="end"
                className="gantt-label"
              >
                {ellipsize(bar.rec.stageName, 28)}
              </text>
              <rect
                x={x1}
                y={y + 4}
                width={width}
                height={ROW_H - 8}
                className={`gantt-bar ${cls}`}
              >
                <title>{`${bar.rec.stageName} · ${fmtDur(bar.endMs - bar.startMs)}${marker ? ` · [${marker}]` : ''}`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function buildBars(records: AllStageRecord[]): Bar[] {
  const bars: Bar[] = [];
  for (const rec of records) {
    const stage = rec.stage as
      | { finishedAt?: string; durationMs?: number }
      | null;
    if (!stage) continue;
    const endIso = stage.finishedAt;
    const dur = stage.durationMs;
    if (!endIso || typeof dur !== 'number') continue;
    const endMs = Date.parse(endIso);
    if (!Number.isFinite(endMs)) continue;
    bars.push({ rec, startMs: endMs - dur, endMs });
  }
  return bars;
}

function computeRange(bars: Bar[]): {
  startMs: number;
  endMs: number;
  totalMs: number;
} {
  if (bars.length === 0) return { startMs: 0, endMs: 1, totalMs: 1 };
  let start = Infinity;
  let end = -Infinity;
  for (const b of bars) {
    if (b.startMs < start) start = b.startMs;
    if (b.endMs > end) end = b.endMs;
  }
  return { startMs: start, endMs: end, totalMs: Math.max(1, end - start) };
}

function makeTicks(totalMs: number): number[] {
  const target = 5;
  const raw = totalMs / target;
  const niceSteps = [
    100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 300_000, 600_000,
    1_800_000, 3_600_000,
  ];
  const step = niceSteps.find((s) => s >= raw) ?? niceSteps[niceSteps.length - 1];
  const out: number[] = [];
  for (let v = 0; v <= totalMs; v += step) out.push(v);
  return out;
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function ellipsize(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
