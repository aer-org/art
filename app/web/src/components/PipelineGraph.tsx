import { useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  type Edge,
  type Node,
} from '@xyflow/react';
import dagre from 'dagre';
import '@xyflow/react/dist/style.css';

import { RetryEdge } from './RetryEdge.tsx';
import { StageNode } from './StageNode.tsx';
import { TemplateGroupNode } from './TemplateGroupNode.tsx';
import type { GraphEdge, GraphNode } from '../lib/api.ts';

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeClick: (name: string) => void;
}

const nodeTypes = { stage: StageNode, templateGroup: TemplateGroupNode };
const edgeTypes = { retry: RetryEdge };

const STAGE_W = 220;
const STAGE_H = 70;
// Barriers are compact sync points, not full nodes — tooltip carries
// joinPolicy / lane count detail.
const BARRIER_W = 120;
const BARRIER_H = 22;
const TEMPLATE_W = 240;
const TEMPLATE_H = 64;
const GROUP_PAD = 16;
const GROUP_LABEL_H = 22;

// Dagre reads `width`/`height` (not `w`/`h`) off the node value object.
function dimsOf(n: GraphNode): { width: number; height: number } {
  if (n.kind === 'barrier') return { width: BARRIER_W, height: BARRIER_H };
  if (n.kind === 'template') return { width: TEMPLATE_W, height: TEMPLATE_H };
  return { width: STAGE_W, height: STAGE_H };
}

// Tell dagre how much space each edge label needs. With this set dagre
// pushes ranks apart instead of dropping the label onto an adjacent
// node. Retry edges follow a hand-drawn arc (RetryEdge) so they don't
// need to participate in dagre's label sizing.
function edgeAttrs(e: GraphEdge): Record<string, unknown> {
  if (e.isRetry || !e.marker) return {};
  // ~7.5 px per char for the 10 px mono label + 16 px of horizontal
  // padding so the pill background has breathing room.
  const width = Math.max(60, e.marker.length * 7.5 + 16);
  return { label: e.marker, width, height: 18, labelpos: 'c' };
}

function isExpandedLaneStage(n: GraphNode): boolean {
  return (
    (n.kind === 'agent' || n.kind === 'command') &&
    !!n.isStitched &&
    !!n.templateName
  );
}

interface Bbox {
  w: number;
  h: number;
}

function layout(nodes: GraphNode[], edges: GraphEdge[]) {
  // Hierarchical layout: each expanded template is laid out in its own
  // sub-dagre to produce a tight stage DAG, then the outer dagre places
  // each template (as a single block) alongside the base stages, pills,
  // and barriers. ReactFlow renders the original leaf-level edges; the
  // group box is a purely visual decoration around the lane stages.
  //
  // We chose hierarchical over dagre's `compound: true` because compound
  // graphs in dagre don't reliably accept the parent itself as an edge
  // endpoint, and our `group:X → summarize` edges need exactly that.

  // 1) Bucket lane stages by template.
  const tplGroups = new Map<string, GraphNode[]>();
  const looseNodes: GraphNode[] = [];
  for (const n of nodes) {
    if (isExpandedLaneStage(n)) {
      const arr = tplGroups.get(n.templateName!) ?? [];
      arr.push(n);
      tplGroups.set(n.templateName!, arr);
    } else {
      looseNodes.push(n);
    }
  }

  // 2) Sub-dagre per expanded template → relative positions + bbox.
  const subPositions = new Map<string, { x: number; y: number }>();
  const groupBboxes = new Map<string, Bbox>();
  for (const [tplName, stages] of tplGroups) {
    const sub = new dagre.graphlib.Graph();
    sub.setGraph({ rankdir: 'LR', nodesep: 30, ranksep: 90 });
    sub.setDefaultEdgeLabel(() => ({}));
    const inTpl = new Set(stages.map((s) => s.id));
    for (const s of stages) sub.setNode(s.id, dimsOf(s));
    for (const e of edges) {
      if (inTpl.has(e.source) && inTpl.has(e.target)) {
        sub.setEdge(e.source, e.target, edgeAttrs(e));
      }
    }
    dagre.layout(sub);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s of stages) {
      const p = sub.node(s.id);
      const { width: w, height: h } = dimsOf(s);
      minX = Math.min(minX, p.x - w / 2);
      minY = Math.min(minY, p.y - h / 2);
      maxX = Math.max(maxX, p.x + w / 2);
      maxY = Math.max(maxY, p.y + h / 2);
    }
    const groupW = maxX - minX + GROUP_PAD * 2;
    const groupH = maxY - minY + GROUP_PAD * 2 + GROUP_LABEL_H;
    groupBboxes.set(tplName, { w: groupW, h: groupH });

    for (const s of stages) {
      const p = sub.node(s.id);
      const { width: w, height: h } = dimsOf(s);
      subPositions.set(s.id, {
        x: p.x - w / 2 - minX + GROUP_PAD,
        y: p.y - h / 2 - minY + GROUP_PAD + GROUP_LABEL_H,
      });
    }
  }

  // 3) Outer dagre over loose nodes + per-template group blocks.
  const outer = new dagre.graphlib.Graph();
  outer.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 110 });
  outer.setDefaultEdgeLabel(() => ({}));
  for (const n of looseNodes) outer.setNode(n.id, dimsOf(n));
  for (const [tplName, bbox] of groupBboxes) {
    outer.setNode(`group:${tplName}`, { width: bbox.w, height: bbox.h });
  }

  // Map any lane-stage id to its containing group; everything else passes
  // through (base stages, collapsed pills, barriers, group ids already).
  const idToTpl = new Map<string, string>();
  for (const [tpl, stages] of tplGroups) {
    for (const s of stages) idToTpl.set(s.id, tpl);
  }
  function outerEndpoint(id: string): string {
    if (id.startsWith('group:')) return id;
    const tpl = idToTpl.get(id);
    return tpl ? `group:${tpl}` : id;
  }
  for (const e of edges) {
    const s = outerEndpoint(e.source);
    const t = outerEndpoint(e.target);
    if (s === t) continue; // intra-group edges live in the sub-layout only
    outer.setEdge(s, t, edgeAttrs(e));
  }
  dagre.layout(outer);

  // 4) Assemble ReactFlow nodes — groups first (low z-index) so stages
  //    paint on top.
  const rfNodes: Node[] = [];
  for (const [tplName, bbox] of groupBboxes) {
    const p = outer.node(`group:${tplName}`);
    rfNodes.push({
      id: `group:${tplName}`,
      type: 'templateGroup',
      data: { templateName: tplName },
      position: { x: p.x - bbox.w / 2, y: p.y - bbox.h / 2 },
      style: { width: bbox.w, height: bbox.h },
      zIndex: -1,
      selectable: false,
      focusable: false,
      draggable: false,
    });
  }

  for (let idx = 0; idx < nodes.length; idx++) {
    const n = nodes[idx];
    if (isExpandedLaneStage(n)) {
      const groupP = outer.node(`group:${n.templateName}`);
      const bbox = groupBboxes.get(n.templateName!)!;
      const rel = subPositions.get(n.id)!;
      rfNodes.push({
        id: n.id,
        type: 'stage',
        data: { stage: n, revealIndex: idx },
        position: {
          x: groupP.x - bbox.w / 2 + rel.x,
          y: groupP.y - bbox.h / 2 + rel.y,
        },
      });
    } else {
      const p = outer.node(n.id);
      if (!p) continue;
      const { width: w, height: h } = dimsOf(n);
      rfNodes.push({
        id: n.id,
        type: 'stage',
        data: { stage: n, revealIndex: idx },
        position: { x: p.x - w / 2, y: p.y - h / 2 },
      });
    }
  }

  const rfEdges: Edge[] = edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.marker,
    className: [
      e.isTemplate ? 'template' : '',
      e.isRetry ? 'retry' : '',
    ]
      .filter(Boolean)
      .join(' '),
    type: e.isRetry ? 'retry' : undefined,
    animated: false,
  }));
  return { rfNodes, rfEdges };
}

export function PipelineGraph({ nodes, edges, onNodeClick }: Props) {
  const { rfNodes, rfEdges } = useMemo(() => layout(nodes, edges), [nodes, edges]);

  if (nodes.length === 0) {
    return (
      <div className="graph-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fg-dim)', padding: 32, textAlign: 'center' }}>
        Load a project directory to see its pipeline.
      </div>
    );
  }

  return (
    <div className="graph-container">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n) => onNodeClick(n.id)}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
      >
        <Background color="#2a2f3d" gap={20} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
