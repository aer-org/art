import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGraph } from './pipeline-graph.ts';
import type { PipelineConfig, PipelineStage } from './types.ts';

function stage(
  name: string,
  next: string | string[] | null,
  marker = 'DONE',
): PipelineStage {
  return {
    name,
    prompt: name,
    mounts: {},
    transitions: [{ marker, next }],
  };
}

test('buildGraph: array next emits one edge per target', () => {
  const config: PipelineConfig = {
    stages: [
      stage('A', ['B', 'C']),
      stage('B', 'D'),
      stage('C', 'D'),
      stage('D', null),
    ],
  };

  const graph = buildGraph(config, null);
  const ids = new Set(graph.nodes.map((n) => n.id));
  assert.deepEqual([...ids].sort(), ['A', 'B', 'C', 'D']);

  const flatEdges = graph.edges.map((e) => `${e.source}->${e.target}`).sort();
  assert.deepEqual(flatEdges, ['A->B', 'A->C', 'B->D', 'C->D']);
});

test('buildGraph: fan-out edges carry the source marker', () => {
  const config: PipelineConfig = {
    stages: [
      {
        ...stage('A', ['B', 'C']),
        transitions: [{ marker: 'A_OK', next: ['B', 'C'] }],
      },
      stage('B', null),
      stage('C', null),
    ],
  };

  const graph = buildGraph(config, null);
  const aEdges = graph.edges.filter((e) => e.source === 'A');
  assert.equal(aEdges.length, 2);
  for (const edge of aEdges) {
    assert.equal(edge.marker, 'A_OK');
  }
});
