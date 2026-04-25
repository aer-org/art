import { describe, it, expect, vi } from 'vitest';

vi.mock('./logger.js', () => ({
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
  joinNameFor,
  renamedStage,
  stitchParallel,
  stitchSingle,
} from './stitch.js';
import type { PipelineTemplate } from './pipeline-template.js';
import type { PipelineConfig } from './pipeline-runner.js';

function baseConfig(): PipelineConfig {
  return {
    stages: [
      {
        name: 'start',
        mounts: {},
        transitions: [{ marker: 'OK', next: 'review' }],
      },
      {
        name: 'review',
        mounts: {},
        transitions: [
          { marker: 'STAGE_KEEP', template: 'continue-tpl', next: 'finalize' },
          { marker: 'STAGE_RESET', template: 'revert-tpl', next: 'finalize' },
        ],
      },
      {
        name: 'finalize',
        mounts: {},
        transitions: [{ marker: 'OK', next: null }],
      },
    ],
    entryStage: 'start',
  };
}

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
        prompt: 'hello {{insertId}} idx={{index}}',
        env: { SCOPE: '{{insertId}}', IDX: '{{index}}' },
        transitions: [{ marker: 'OK', next: null }],
      },
    ],
  };
}

function stitchSingleDefaults(
  template: PipelineTemplate,
  overrides: Partial<Parameters<typeof stitchSingle>[0]> = {},
) {
  return stitchSingle({
    config: baseConfig(),
    originStage: 'review',
    originTransitionIdx: 1,
    template,
    downstreamNext: 'finalize',
    joinPolicy: 'all_success',
    ...overrides,
  });
}

function stitchParallelDefaults(
  template: PipelineTemplate,
  overrides: Partial<Parameters<typeof stitchParallel>[0]> = {},
) {
  return stitchParallel({
    config: baseConfig(),
    originStage: 'review',
    originTransitionIdx: 1,
    template,
    downstreamNext: 'finalize',
    joinPolicy: 'all_success',
    count: 2,
    ...overrides,
  });
}

describe('stitchSingle', () => {
  it('inserts a template and rewires the host transition', () => {
    const result = stitchSingleDefaults(revertTemplate());

    expect(result.entryName).toBe('review__revert-tpl0__checkout');
    expect(result.joinName).toBe(joinNameFor('review', 'revert-tpl'));

    const review = result.updatedConfig.stages.find(
      (stage) => stage.name === 'review',
    )!;
    expect(review.transitions[1].next).toBe('review__revert-tpl0__checkout');
    expect(review.transitions[1].template).toBeUndefined();
    expect(review.transitions[0].template).toBe('continue-tpl');

    const stageNames = result.updatedConfig.stages.map((stage) => stage.name);
    expect(stageNames).toContain('review__revert-tpl0__checkout');
    expect(stageNames).toContain('review__revert-tpl0__rebuild');
    expect(stageNames).toContain(result.joinName);
  });

  it('rewires template terminal edges to the synthetic join', () => {
    const result = stitchSingleDefaults(revertTemplate());

    const checkout = result.updatedConfig.stages.find(
      (stage) => stage.name === 'review__revert-tpl0__checkout',
    )!;
    expect(checkout.transitions[0].next).toBe('review__revert-tpl0__rebuild');

    const rebuild = result.updatedConfig.stages.find(
      (stage) => stage.name === 'review__revert-tpl0__rebuild',
    )!;
    expect(rebuild.transitions[0].next).toBe(result.joinName);

    const join = result.updatedConfig.stages.find(
      (stage) => stage.name === result.joinName,
    )!;
    expect(join.join).toEqual({
      policy: 'all_success',
      expectedCopies: 1,
      copyPrefixes: ['review__revert-tpl0__'],
    });
    expect(join.transitions[0].next).toBe('finalize');
  });

  it('keeps nested template handoffs and rewires their downstream next', () => {
    const tpl: PipelineTemplate = {
      name: 'nesting-tpl',
      entry: 'a',
      stages: [
        {
          name: 'a',
          mounts: {},
          transitions: [{ marker: 'OK', template: 'child', next: null }],
        },
      ],
    };

    const result = stitchSingleDefaults(tpl);
    const stage = result.updatedConfig.stages.find(
      (value) => value.name === 'review__nesting-tpl0__a',
    )!;
    expect(stage.transitions[0].template).toBe('child');
    expect(stage.transitions[0].next).toBe(result.joinName);
  });

  it('applies substitutions to allowed fields', () => {
    const result = stitchSingleDefaults(substTemplate(), {
      substitutions: { custom: 'hi' },
    });

    const stage = result.updatedConfig.stages.find(
      (value) => value.name === 'review__subst-tpl0__s',
    )!;
    expect(stage.prompt).toBe('hello review__subst-tpl0 idx=0');
    expect(stage.env).toEqual({ SCOPE: 'review__subst-tpl0', IDX: '0' });
    expect(stage.mounts).toHaveProperty('scope-review__subst-tpl0', 'rw');
  });

  it('applies substitutions inside transition fields', () => {
    const tpl: PipelineTemplate = {
      name: 'trans-subst',
      entry: 'a',
      stages: [
        {
          name: 'a',
          mounts: {},
          transitions: [
            {
              marker: 'OK',
              next: null,
              prompt: 'done for {{id}} ({{kind}})',
            },
          ],
        },
      ],
    };

    const result = stitchSingleDefaults(tpl, {
      substitutions: { id: 'foo', kind: 'stimulus' },
    });
    const stage = result.updatedConfig.stages.find(
      (value) => value.name === 'review__trans-subst0__a',
    )!;
    expect(stage.transitions[0].prompt).toBe('done for foo (stimulus)');
  });

  it('drops template-specific control fields from the host transition', () => {
    const config = baseConfig();
    Object.assign(config.stages[1].transitions[1], {
      count: 3,
      countFrom: 'payload',
      substitutionsFrom: 'payload',
      joinPolicy: 'any_success',
    });

    const result = stitchSingle({
      config,
      originStage: 'review',
      originTransitionIdx: 1,
      template: revertTemplate(),
      downstreamNext: 'finalize',
      joinPolicy: 'all_success',
    });

    const review = result.updatedConfig.stages.find(
      (stage) => stage.name === 'review',
    )!;
    expect(review.transitions[1].count).toBeUndefined();
    expect(review.transitions[1].countFrom).toBeUndefined();
    expect(review.transitions[1].substitutionsFrom).toBeUndefined();
    expect(review.transitions[1].joinPolicy).toBeUndefined();
    expect(review.transitions[1].template).toBeUndefined();
  });

  it('throws on unknown origin stage', () => {
    expect(() =>
      stitchSingle({
        config: baseConfig(),
        originStage: 'missing',
        originTransitionIdx: 0,
        template: revertTemplate(),
        downstreamNext: 'finalize',
        joinPolicy: 'all_success',
      }),
    ).toThrow(/not found/);
  });

  it('throws on out-of-range transition idx', () => {
    expect(() =>
      stitchSingle({
        config: baseConfig(),
        originStage: 'review',
        originTransitionIdx: 99,
        template: revertTemplate(),
        downstreamNext: 'finalize',
        joinPolicy: 'all_success',
      }),
    ).toThrow(/out of range/);
  });

  it('rejects name collisions', () => {
    const config = baseConfig();
    config.stages.push({
      name: 'review__revert-tpl0__checkout',
      mounts: {},
      transitions: [{ marker: 'OK', next: null }],
    });

    expect(() =>
      stitchSingle({
        config,
        originStage: 'review',
        originTransitionIdx: 1,
        template: revertTemplate(),
        downstreamNext: 'finalize',
        joinPolicy: 'all_success',
      }),
    ).toThrow(/Duplicate/);
  });
});

describe('stitchParallel', () => {
  it('clones the template N times and synthesizes a join', () => {
    const result = stitchParallelDefaults(revertTemplate(), { count: 3 });

    expect(result.entryNames).toEqual([
      'review__revert-tpl0__checkout',
      'review__revert-tpl1__checkout',
      'review__revert-tpl2__checkout',
    ]);
    expect(result.joinName).toBe(joinNameFor('review', 'revert-tpl'));

    const join = result.updatedConfig.stages.find(
      (stage) => stage.name === result.joinName,
    )!;
    expect(join.join).toEqual({
      policy: 'all_success',
      expectedCopies: 3,
      copyPrefixes: [
        'review__revert-tpl0__',
        'review__revert-tpl1__',
        'review__revert-tpl2__',
      ],
    });
    expect(join.transitions[0].next).toBe('finalize');

    const review = result.updatedConfig.stages.find(
      (stage) => stage.name === 'review',
    )!;
    expect(review.transitions[1].next).toEqual(result.entryNames);
  });

  it('rewires each lane tail to the shared join', () => {
    const result = stitchParallelDefaults(revertTemplate(), { count: 2 });

    for (let i = 0; i < 2; i++) {
      const lastStage = result.updatedConfig.stages.find(
        (stage) => stage.name === `review__revert-tpl${i}__rebuild`,
      )!;
      expect(lastStage.transitions[0].next).toBe(result.joinName);
    }
  });

  it('applies per-copy substitutions', () => {
    const result = stitchParallelDefaults(substTemplate(), {
      perCopySubstitutions: [{ label: 'A' }, { label: 'B' }],
    });

    const s0 = result.updatedConfig.stages.find(
      (stage) => stage.name === 'review__subst-tpl0__s',
    )!;
    const s1 = result.updatedConfig.stages.find(
      (stage) => stage.name === 'review__subst-tpl1__s',
    )!;
    expect(s0.prompt).toContain('idx=0');
    expect(s1.prompt).toContain('idx=1');
    expect(s0.env?.SCOPE).toBe('review__subst-tpl0');
    expect(s1.env?.SCOPE).toBe('review__subst-tpl1');
  });

  it('rejects count=0', () => {
    expect(() =>
      stitchParallelDefaults(revertTemplate(), { count: 0 }),
    ).toThrow(/positive integer/);
  });

  it('accepts count=1 and still produces a join stage', () => {
    const result = stitchParallelDefaults(revertTemplate(), { count: 1 });
    expect(result.entryNames).toEqual(['review__revert-tpl0__checkout']);
    expect(
      result.updatedConfig.stages.find((stage) => stage.name === result.joinName),
    ).toBeTruthy();
  });
});

describe('assertConfigAcyclic', () => {
  it('accepts a DAG', () => {
    expect(() => assertConfigAcyclic(baseConfig())).not.toThrow();
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

  it('detects a self-loop', () => {
    const cfg: PipelineConfig = {
      stages: [{ name: 'a', mounts: {}, transitions: [{ marker: 'x', next: 'a' }] }],
    };
    expect(() => assertConfigAcyclic(cfg)).toThrow(/Cycle/);
  });
});

describe('assertNoNameCollision', () => {
  it('accepts unique names', () => {
    expect(() => assertNoNameCollision(baseConfig())).not.toThrow();
  });

  it('flags duplicates', () => {
    const cfg: PipelineConfig = {
      stages: [
        { name: 'a', mounts: {}, transitions: [] as never },
        { name: 'a', mounts: {}, transitions: [] as never },
      ],
    };
    expect(() => assertNoNameCollision(cfg)).toThrow(/Duplicate/);
  });
});

describe('renamedStage', () => {
  it('composes origin, template name, index, and stage name', () => {
    expect(renamedStage('review', 'revert-tpl', 2, 'checkout')).toBe(
      'review__revert-tpl2__checkout',
    );
  });
});

describe('unresolved placeholder detection', () => {
  it('throws when a template uses a placeholder not in the subs map', () => {
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
      stitchSingleDefaults(tpl, { substitutions: { id: 'alpha' } }),
    ).toThrow(/Unresolved placeholder.*\{\{tpye\}\}.*field "prompt"/);
  });

  it('throws when a placeholder is in a mount key', () => {
    const tpl: PipelineTemplate = {
      name: 'mount-tpl',
      entry: 'a',
      stages: [
        {
          name: 'a',
          mounts: { 'scope-{{missing}}': 'rw' },
          transitions: [{ marker: 'OK', next: null }],
        },
      ],
    };

    expect(() => stitchSingleDefaults(tpl)).toThrow(
      /Unresolved placeholder.*\{\{missing\}\}.*field "mounts"/,
    );
  });

  it('throws when a placeholder is in a transition prompt', () => {
    const tpl: PipelineTemplate = {
      name: 'trans-tpl',
      entry: 'a',
      stages: [
        {
          name: 'a',
          mounts: {},
          transitions: [{ marker: 'OK', next: null, prompt: 'done for {{kind}}' }],
        },
      ],
    };

    expect(() =>
      stitchSingleDefaults(tpl, { substitutions: { id: 'alpha' } }),
    ).toThrow(/Unresolved placeholder.*\{\{kind\}\}.*field "transitions"/);
  });

  it('throws at stitchParallel time too', () => {
    const tpl: PipelineTemplate = {
      name: 'par-tpl',
      entry: 'a',
      stages: [
        {
          name: 'a',
          prompt: 'lane for {{id}} kind={{kind}}',
          mounts: {},
          transitions: [{ marker: 'OK', next: null }],
        },
      ],
    };

    expect(() =>
      stitchParallelDefaults(tpl, {
        perCopySubstitutions: [
          { id: 'alpha', kind: 'fast' },
          { id: 'beta' },
        ],
      }),
    ).toThrow(/Unresolved placeholder.*\{\{kind\}\}/);
  });

  it('does not throw when every placeholder is satisfied', () => {
    const tpl: PipelineTemplate = {
      name: 'ok-tpl',
      entry: 'a',
      stages: [
        {
          name: 'a',
          prompt: '{{id}} / {{insertId}} / {{index}}',
          mounts: { '{{id}}-dir': 'rw' },
          transitions: [{ marker: 'OK', next: null, prompt: 'for {{id}}' }],
        },
      ],
    };

    expect(() =>
      stitchSingleDefaults(tpl, { substitutions: { id: 'alpha' } }),
    ).not.toThrow();
  });
});
