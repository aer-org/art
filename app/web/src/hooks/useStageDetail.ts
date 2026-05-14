/**
 * useStageDetail — lazy fetch of every L2 summary widget for one stage.
 *
 * Loads in parallel:
 *   - stage.json + container.json (via /api/runs/:id/stages/:n/:s)
 *   - events filtered to this stage (for decision counts)
 *   - turns summary (count + aggregate, not the full meta JSON)
 *   - diff summary (mounts changed/unchanged)
 *
 * L3 panels (full prompt text, raw diff, per-turn meta) are NOT fetched
 * here — they're loaded on demand when the user clicks into a panel.
 */
import { useEffect, useState } from 'react';

import {
  api,
  type RunDetail,
  type StageDetail,
} from '../lib/api.ts';

export interface StageSidebarData {
  stage: StageDetail | null;
  events: Array<Record<string, unknown>>;
  turns: Array<Record<string, unknown>>;
  diffSummary: Record<string, unknown> | null;
  loading: boolean;
  error: string | null;
}

const EMPTY: StageSidebarData = {
  stage: null,
  events: [],
  turns: [],
  diffSummary: null,
  loading: false,
  error: null,
};

export function useStageDetail(
  run: RunDetail | null,
  nodeId: string | null,
  stageName: string | null,
): StageSidebarData {
  const [data, setData] = useState<StageSidebarData>(EMPTY);

  useEffect(() => {
    if (!run || !nodeId || !stageName) {
      setData(EMPTY);
      return;
    }
    let cancelled = false;
    setData({ ...EMPTY, loading: true });

    Promise.all([
      api.stageDetail(run.runId, nodeId, stageName).catch(() => null),
      api
        .runEvents(run.runId, { stage: stageName, limit: 1000 })
        .then((r) => r.events)
        .catch((): Array<Record<string, unknown>> => []),
      api
        .stageTurns(run.runId, nodeId, stageName)
        .then((r) => r.turns)
        .catch((): Array<Record<string, unknown>> => []),
      api.stageDiffSummary(run.runId, nodeId, stageName).catch(() => null),
    ])
      .then(([stage, events, turns, diffSummary]) => {
        if (cancelled) return;
        setData({
          stage,
          events,
          turns,
          diffSummary,
          loading: false,
          error: null,
        });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setData({ ...EMPTY, error: err.message });
      });

    return () => {
      cancelled = true;
    };
  }, [run?.runId, nodeId, stageName]);

  return data;
}
