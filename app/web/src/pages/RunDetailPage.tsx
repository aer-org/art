/**
 * RunDetailPage — inspector view of an archived (or live) run.
 *
 * Layout (CSS grid): header / toolbar / [canvas | sidebar? | (L3 | L4)?]
 *
 * - L2 sidebar opens on stage click
 * - L3 panel opens from sidebar "view X" links
 * - L4 panel opens from the toolbar (Info / Timeline / Decisions / Cost
 *   / Events). L4 is mutually exclusive with the sidebar+L3 stack — opens
 *   in the same right slot.
 */
import { useEffect, useMemo, useState } from 'react';

import { L3Panel } from '../components/L3Panel.tsx';
import { L4CostView } from '../components/L4CostView.tsx';
import { L4DecisionsCrossStage } from '../components/L4DecisionsCrossStage.tsx';
import { L4EventsRaw } from '../components/L4EventsRaw.tsx';
import { L4RunInfo } from '../components/L4RunInfo.tsx';
import { L4Timeline } from '../components/L4Timeline.tsx';
import { PipelineGraph } from '../components/PipelineGraph.tsx';
import { RunDetailHeader } from '../components/RunDetailHeader.tsx';
import {
  StageSidebar,
  type L3PanelKind,
} from '../components/StageSidebar.tsx';
import { useStageDetail } from '../hooks/useStageDetail.ts';
import {
  api,
  type GraphEdge,
  type GraphNode,
  type RunDetail,
} from '../lib/api.ts';

const LIVE_POLL_MS = 5000;

type L4Kind = 'info' | 'timeline' | 'decisions' | 'cost' | 'events';

const L4_TITLES: Record<L4Kind, string> = {
  info: 'Run info',
  timeline: 'Timeline',
  decisions: 'Decisions',
  cost: 'Cost',
  events: 'Events (raw)',
};

export function RunDetailPage(props: { runId: string }): JSX.Element {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [graph, setGraph] = useState<{
    nodes: GraphNode[];
    edges: GraphEdge[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedStage, setSelectedStage] = useState<string | null>(null);
  const [l3, setL3] = useState<{ kind: L3PanelKind; mount?: string } | null>(
    null,
  );
  const [l4, setL4] = useState<L4Kind | null>(null);

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

  const selectedNodeId = useMemo(() => {
    if (!selectedStage || !graph) return null;
    const node = graph.nodes.find((n) => n.name === selectedStage);
    return node?.nodeId ?? 'root';
  }, [selectedStage, graph]);

  const stageData = useStageDetail(detail, selectedNodeId, selectedStage);

  // Esc cascade: L4 → L3 → sidebar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (l4) setL4(null);
      else if (l3) setL3(null);
      else if (selectedStage) setSelectedStage(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedStage, l3, l4]);

  useEffect(() => {
    if (!selectedStage) setL3(null);
  }, [selectedStage]);

  function openL4(kind: L4Kind) {
    // L4 takes the right slot; close the stage stack while it's up.
    setSelectedStage(null);
    setL3(null);
    setL4(kind);
  }

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
  const l3Open = sidebarOpen && l3 !== null;
  const l4Open = l4 !== null;

  const layoutClass = l4Open
    ? 'inspector-with-l4'
    : l3Open
      ? 'inspector-with-l3'
      : sidebarOpen
        ? 'inspector-with-sidebar'
        : '';

  return (
    <div className={`inspector ${layoutClass}`}>
      <RunDetailHeader run={detail} />
      <nav className="inspector-toolbar">
        {(['info', 'timeline', 'decisions', 'cost', 'events'] as L4Kind[]).map(
          (k) => (
            <button
              key={k}
              className={`toolbar-btn ${l4 === k ? 'active' : ''}`}
              onClick={() => (l4 === k ? setL4(null) : openL4(k))}
            >
              {L4_TITLES[k]}
            </button>
          ),
        )}
      </nav>
      <div className="inspector-body">
        <div className="inspector-canvas">
          {graph && graph.nodes.length > 0 ? (
            <PipelineGraph
              nodes={graph.nodes}
              edges={graph.edges}
              onNodeClick={(name) => {
                setSelectedStage(name);
                setL3(null);
                setL4(null);
              }}
            />
          ) : (
            <div className="inspector-empty">
              <p className="muted">
                No graph data archived for this run (missing pipeline.snap.json).
              </p>
            </div>
          )}
        </div>
        {sidebarOpen && (
          <StageSidebar
            nodeId={selectedNodeId!}
            stageName={selectedStage!}
            data={stageData}
            onClose={() => setSelectedStage(null)}
            onOpenPanel={(kind, mount) => setL3({ kind, mount })}
          />
        )}
        {l3Open && selectedStage && selectedNodeId && (
          <L3Panel
            runId={props.runId}
            nodeId={selectedNodeId}
            stageName={selectedStage}
            kind={l3!.kind}
            mount={l3!.mount}
            stage={stageData.stage}
            events={stageData.events}
            turns={stageData.turns}
            diffSummary={stageData.diffSummary}
            onClose={() => setL3(null)}
          />
        )}
        {l4Open && (
          <aside className="l4-panel inspector">
            <header className="l3-header">
              <div>
                <div className="label">overlay</div>
                <div className="value large">{L4_TITLES[l4!]}</div>
              </div>
              <button
                className="sidebar-close"
                onClick={() => setL4(null)}
                title="Close (Esc)"
              >
                ✕
              </button>
            </header>
            <div className="l3-body">
              {l4 === 'info' && <L4RunInfo runId={props.runId} />}
              {l4 === 'timeline' && (
                <L4Timeline
                  runId={props.runId}
                  onSelectStage={(name) => {
                    setL4(null);
                    setSelectedStage(name);
                  }}
                />
              )}
              {l4 === 'decisions' && (
                <L4DecisionsCrossStage
                  runId={props.runId}
                  onSelectStage={(name) => {
                    setL4(null);
                    setSelectedStage(name);
                  }}
                />
              )}
              {l4 === 'cost' && <L4CostView runId={props.runId} />}
              {l4 === 'events' && <L4EventsRaw runId={props.runId} />}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
