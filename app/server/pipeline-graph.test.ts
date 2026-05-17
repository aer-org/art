import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildGraph } from './pipeline-graph.ts';
import { buildTemplateOverview } from './pipeline-template-overview.ts';
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

function withTmpArtDir<T>(fn: (artDir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-graph-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  assert.deepEqual(flatEdges, [
    'A->B',
    'A->C',
    'B->D',
    'C->D',
  ]);
});

test('buildGraph: fan-out edges carry the source marker', () => {
  const config: PipelineConfig = {
    stages: [
      { ...stage('A', ['B', 'C']), transitions: [{ marker: 'A_OK', next: ['B', 'C'] }] },
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

test('buildTemplateOverview: base array next becomes parallel edges', () => {
  withTmpArtDir((artDir) => {
    const config: PipelineConfig = {
      stages: [
        stage('A', ['B', 'C']),
        stage('B', 'D'),
        stage('C', 'D'),
        stage('D', null),
      ],
    };

    const graph = buildTemplateOverview(config, artDir);
    const flatEdges = graph.edges.map((e) => `${e.source}->${e.target}`).sort();
    assert.deepEqual(flatEdges, [
      'A->B',
      'A->C',
      'B->D',
      'C->D',
    ]);
    // All emitted as plain (non-template) edges.
    for (const edge of graph.edges) {
      assert.notEqual(edge.isTemplate, true);
    }
  });
});

test('buildTemplateOverview: array next still emits edges alongside template references', () => {
  withTmpArtDir((artDir) => {
    fs.mkdirSync(path.join(artDir, 'templates'), { recursive: true });
    fs.writeFileSync(
      path.join(artDir, 'templates', 'lane.json'),
      JSON.stringify({
        entry: 'inner',
        stages: [
          {
            name: 'inner',
            prompt: 'inner',
            mounts: {},
            transitions: [{ marker: 'DONE', next: null }],
          },
        ],
      }),
    );
    const config: PipelineConfig = {
      stages: [
        // Plain fan-out from A to B and C; no template.
        stage('A', ['B', 'C']),
        // B then stitches a template before D.
        {
          name: 'B',
          prompt: 'B',
          mounts: {},
          transitions: [
            { marker: 'DONE', template: 'lane', next: 'D' },
          ],
        },
        stage('C', 'D'),
        stage('D', null),
      ],
    };

    const graph = buildTemplateOverview(config, artDir);
    const flat = graph.edges.map((e) => `${e.source}->${e.target}`).sort();
    assert.deepEqual(flat, [
      'A->B',
      'A->C',
      'B->tpl:lane',
      'C->D',
      'tpl:lane->D',
    ]);
  });
});
