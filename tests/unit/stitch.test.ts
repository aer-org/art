import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  assertConfigAcyclic,
  assertNoNameCollision,
  buildStitchInvocation,
  dispatchChildNodeId,
  dispatchInvocationIdFor,
  dispatchStageName,
  ROOT_DISPATCH_NODE_ID,
} from '../../src/stitch.js';
import type { PipelineTemplate } from '../../src/pipeline-template.js';
import type { PipelineConfig } from '../../src/pipeline-runner.js';

function revertTemplate(): PipelineTemplate {
  return {
    name: 'revert-tpl',
    entry: 'checkout',
    stages: [
      {
        name: 'checkout',
        mounts: {},
        transitions: [{ marker: 'OK', next: 'rebuild' }],
      },
      {
        name: 'rebuild',
        mounts: {},
        transitions: [{ marker: 'OK', next: null }],
      },
    ],
  };
}

function substTemplate(): PipelineTemplate {
  return {
    name: 'subst-tpl',
    entry: 's',
    stages: [
      {
        name: 's',
        mounts: { 'scope-{{insertId}}': 'rw' },
        prompt: 'hello {{insertId}} idx={{index}} {{label}}',
        env: { SCOPE: '{{insertId}}', IDX: '{{index}}' },
        transitions: [
          { marker: 'OK', next: null, prompt: 'done for {{label}}' },
        ],
      },
    ],
  };
}

function invocationId(templateName: string): string {
  return dispatchInvocationIdFor(
    ROOT_DISPATCH_NODE_ID,
    'review',
    1,
    templateName,
  );
}

function stageName(
  templateName: string,
  copyIndex: number,
  localName: string,
): string {
  return dispatchStageName(invocationId(templateName), copyIndex, localName);
}

function childNode(templateName: string, copyIndex: number): string {
  return dispatchChildNodeId(invocationId(templateName), copyIndex);
}

describe('buildStitchInvocation', () => {
  it('materializes child run nodes and a parent-owned barrier', () => {
    const result = buildStitchInvocation({
      originStage: 'review',
      originTransitionIdx: 1,
      template: revertTemplate(),
      downstreamNext: 'finalize',
      joinPolicy: 'all_success',
      parentDispatchNodeId: ROOT_DISPATCH_NODE_ID,
      mode: 'parallel',
      count: 2,
    });

    expect(result.barrier).toEqual(
      expect.objectContaining({
        ownerNodeId: ROOT_DISPATCH_NODE_ID,
        originStage: 'review',
        template: 'revert-tpl',
        childNodeIds: [childNode('revert-tpl', 0), childNode('revert-tpl', 1)],
        downstreamNext: 'finalize',
        joinPolicy: 'all_success',
        settlements: {},
        status: 'running',
      }),
    );
    expect(result.children).toHaveLength(2);
    expect(result.children[0].node).toEqual(
      expect.objectContaining({
        id: childNode('revert-tpl', 0),
        parentId: ROOT_DISPATCH_NODE_ID,
        entryStage: stageName('revert-tpl', 0, 'checkout'),
        status: 'pending',
      }),
    );
  });

  it('keeps template terminal edges local to the child node', () => {
    const result = buildStitchInvocation({
      originStage: 'review',
      originTransitionIdx: 1,
      template: revertTemplate(),
      downstreamNext: 'finalize',
      joinPolicy: 'all_success',
      parentDispatchNodeId: ROOT_DISPATCH_NODE_ID,
      mode: 'single',
    });

    const stages = result.children[0].config.stages;
    expect(stages.map((stage) => stage.name)).toEqual([
      stageName('revert-tpl', 0, 'checkout'),
      stageName('revert-tpl', 0, 'rebuild'),
    ]);
    expect(stages[0].transitions[0].next).toBe(
      stageName('revert-tpl', 0, 'rebuild'),
    );
    expect(stages[1].transitions[0].next).toBeNull();
  });

  it('applies per-copy substitutions to allowed fields', () => {
    const result = buildStitchInvocation({
      originStage: 'review',
      originTransitionIdx: 1,
      template: substTemplate(),
      downstreamNext: 'finalize',
      joinPolicy: 'all_success',
      parentDispatchNodeId: ROOT_DISPATCH_NODE_ID,
      mode: 'parallel',
      count: 2,
      perCopySubstitutions: [{ label: 'A' }, { label: 'B' }],
    });

    const first = result.children[0].config.stages[0];
    const second = result.children[1].config.stages[0];
    expect(first.prompt).toBe(`hello ${childNode('subst-tpl', 0)} idx=0 A`);
    expect(second.prompt).toBe(`hello ${childNode('subst-tpl', 1)} idx=1 B`);
    expect(first.env).toEqual({ SCOPE: childNode('subst-tpl', 0), IDX: '0' });
    expect(first.mounts).toHaveProperty(
      `scope-${childNode('subst-tpl', 0)}`,
      'rw',
    );
    expect(first.transitions[0].prompt).toBe('done for A');
  });

  it('rejects count=0', () => {
    expect(() =>
      buildStitchInvocation({
        originStage: 'review',
        originTransitionIdx: 1,
        template: revertTemplate(),
        downstreamNext: 'finalize',
        joinPolicy: 'all_success',
        parentDispatchNodeId: ROOT_DISPATCH_NODE_ID,
        mode: 'parallel',
        count: 0,
      }),
    ).toThrow(/positive integer/);
  });
});

describe('assertConfigAcyclic', () => {
  it('accepts a DAG', () => {
    const cfg: PipelineConfig = {
      stages: [
        { name: 'a', mounts: {}, transitions: [{ marker: 'x', next: 'b' }] },
        { name: 'b', mounts: {}, transitions: [{ marker: 'x', next: null }] },
      ],
    };
    expect(() => assertConfigAcyclic(cfg)).not.toThrow();
  });

  it('detects a cycle', () => {
    const cfg: PipelineConfig = {
      stages: [
        { name: 'a', mounts: {}, transitions: [{ marker: 'x', next: 'b' }] },
        { name: 'b', mounts: {}, transitions: [{ marker: 'x', next: 'a' }] },
      ],
    };
    expect(() => assertConfigAcyclic(cfg)).toThrow(/Cycle/);
  });
});

describe('assertNoNameCollision', () => {
  it('flags duplicate stage names', () => {
    const cfg: PipelineConfig = {
      stages: [
        { name: 'a', mounts: {}, transitions: [] },
        { name: 'a', mounts: {}, transitions: [] },
      ],
    };
    expect(() => assertNoNameCollision(cfg)).toThrow(/Duplicate/);
  });
});

describe('unresolved placeholder detection', () => {
  it('throws when a template uses a placeholder not in the substitution map', () => {
    const tpl: PipelineTemplate = {
      name: 'typo-tpl',
      entry: 'a',
      stages: [
        {
          name: 'a',
          prompt: 'handle {{id}} of {{tpye}}',
          mounts: {},
          transitions: [{ marker: 'OK', next: null }],
        },
      ],
    };

    expect(() =>
      buildStitchInvocation({
        originStage: 'review',
        originTransitionIdx: 1,
        template: tpl,
        downstreamNext: 'finalize',
        joinPolicy: 'all_success',
        parentDispatchNodeId: ROOT_DISPATCH_NODE_ID,
        mode: 'single',
        substitutions: { id: 'alpha' },
      }),
    ).toThrow(/Unresolved placeholder.*\{\{tpye\}\}.*field "prompt"/);
  });
});
