/**
 * RunDetailPage — inspector view of an archived (or live) run.
 *
 * Layout (CSS grid): header / [canvas | sidebar?].
 *   - Header: runId + state + outcome + duration + host.
 *   - Canvas: ReactFlow DAG from runs/<id>/pipeline.snap.json + state.
 *   - Sidebar: opens when a stage is clicked; grid-push, never overlay.
 *
 * Live runs poll every 5s for header + graph; sealed/crashed runs load
 * once. Stage detail in the sidebar refetches whenever the selection
 * changes.
 */
import { useEffect, useMemo, useState } from 'react';

import { PipelineGraph } from '../components/PipelineGraph.tsx';
import { RunDetailHeader } from '../components/RunDetailHeader.tsx';
import { StageSidebar } from '../components/StageSidebar.tsx';
import { useStageDetail } from '../hooks/useStageDetail.ts';
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

  // Resolve nodeId for the selected stage via the graph augmentation.
  const selectedNodeId = useMemo(() => {
    if (!selectedStage || !graph) return null;
    const node = graph.nodes.find((n) => n.name === selectedStage);
    return node?.nodeId ?? 'root';
  }, [selectedStage, graph]);

  const stageData = useStageDetail(detail, selectedNodeId, selectedStage);

  // Esc closes the sidebar.
  useEffect(() => {
    if (!selectedStage) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedStage(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedStage]);

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

  const sidebarOpen =
    !!selectedStage && !!selectedNodeId && stageData.stage !== null;

  return (
    <div
      className={`inspector ${sidebarOpen ? 'inspector-with-sidebar' : ''}`}
    >
      <RunDetailHeader run={detail} />
      <div className="inspector-body">
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
        {selectedStage && selectedNodeId && (
          <StageSidebar
            nodeId={selectedNodeId}
            stageName={selectedStage}
            data={stageData}
            onClose={() => setSelectedStage(null)}
          />
        )}
      </div>
    </div>
  );
}
