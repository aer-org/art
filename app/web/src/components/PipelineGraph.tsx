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

import { StageNode } from './StageNode.tsx';
import type { GraphEdge, GraphNode } from '../lib/api.ts';

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeClick: (name: string) => void;
}

const nodeTypes = { stage: StageNode };

const NODE_WIDTH = 180;
const NODE_HEIGHT = 70;

function layout(nodes: GraphNode[], edges: GraphEdge[]) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 70 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);

  const rfNodes: Node[] = nodes.map((n) => {
    const p = g.node(n.id);
    return {
      id: n.id,
      type: 'stage',
      data: { stage: n },
      position: { x: p.x - NODE_WIDTH / 2, y: p.y - NODE_HEIGHT / 2 },
    };
  });
  const rfEdges: Edge[] = edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.marker,
    className: e.isTemplate ? 'template' : '',
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
