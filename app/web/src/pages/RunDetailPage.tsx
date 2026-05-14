/**
 * RunDetailPage — inspector view of an archived (or live) run.
 *
 * - Top header: runId + state + outcome + duration + host (with a 1px
 *   colored hairline above keyed to outcome).
 * - Body: ReactFlow DAG reconstructed from runs/<id>/pipeline.snap.json +
 *   PIPELINE_STATE.json, with stage nodes augmented from per-stage
 *   stage.json (retry pip, exit-code awareness, dispatch nodeId).
 *
 * Live runs poll every 5s; sealed/crashed runs load once. L2 sidebar +
 * L3 panels arrive in Phase D.
 */
import { useEffect, useState } from 'react';

import { PipelineGraph } from '../components/PipelineGraph.tsx';
import { RunDetailHeader } from '../components/RunDetailHeader.tsx';
import {
  api,
  type GraphEdge,
  type GraphNode,
  type RunDetail,
} from '../lib/api.ts';

const LIVE_POLL_MS = 5000;

export function RunDetailPage(props: { runId: string }): JSX.Element {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [graph, setGraph] = useState<{
    nodes: GraphNode[];
    edges: GraphEdge[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedStage, setSelectedStage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: number | null = null;

    const load = async () => {
      try {
        const [d, g] = await Promise.all([
          api.runDetail(props.runId),
          api.runGraph(props.runId).catch(() => null),
        ]);
        if (cancelled) return;
        setDetail(d);
        setGraph(g);
        setError(null);
        // Poll only while the run is still moving.
        if (d.state === 'live') {
          pollTimer = window.setTimeout(load, LIVE_POLL_MS);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };
    load();

    return () => {
      cancelled = true;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
    };
  }, [props.runId]);

  if (error) {
    return (
      <div className="inspector">
        <div className="inspector-empty">
          <p className="error">Failed to load: {error}</p>
        </div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="inspector">
        <div className="inspector-empty">
          <p className="muted">Loading run…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="inspector">
      <RunDetailHeader run={detail} />
      <div className="inspector-canvas">
        {graph && graph.nodes.length > 0 ? (
          <PipelineGraph
            nodes={graph.nodes}
            edges={graph.edges}
            onNodeClick={setSelectedStage}
          />
        ) : (
          <div className="inspector-empty">
            <p className="muted">
              No graph data archived for this run (missing pipeline.snap.json).
            </p>
          </div>
        )}
      </div>
      {selectedStage && (
        <div className="inspector-selection-hint">
          Selected: <code>{selectedStage}</code> · sidebar arrives in Phase D
        </div>
      )}
    </div>
  );
}
