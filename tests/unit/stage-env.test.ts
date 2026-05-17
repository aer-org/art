import { describe, expect, it } from 'vitest';

import { buildArtEnv, mergeStageEnv } from '../../src/stage-env.js';
import type { PipelineStage } from '../../src/pipeline-types.js';

function bareStage(overrides: Partial<PipelineStage> = {}): PipelineStage {
  return {
    name: 'probe',
    mounts: {},
    transitions: [{ marker: 'STAGE_COMPLETE', next: null }],
    ...overrides,
  };
}

describe('buildArtEnv', () => {
  it('non-stitched stage gets sensible defaults', () => {
    const env = buildArtEnv(bareStage({ name: 'iter_init' }));
    expect(env).toEqual({
      ART_STAGE_NAME: 'iter_init',
      ART_INSERT_ID: 'root',
      ART_LANE_INDEX: '0',
      ART_DISPATCH_NODE_ID: 'root',
    });
  });

  it('stitched lane uses dispatch metadata', () => {
    const env = buildArtEnv(
      bareStage({
        name: 'probe__d_abc123_2',
        dispatch: {
          nodeId: 'd_abc123_2',
          parentNodeId: 'root',
          invocationId: 'd_abc123',
          copyIndex: 2,
          localName: 'probe',
          substitutions: { insertId: 'd_abc123_2', index: 2 },
        },
      }),
    );
    expect(env).toEqual({
      ART_STAGE_NAME: 'probe',
      ART_INSERT_ID: 'd_abc123',
      ART_LANE_INDEX: '2',
      ART_DISPATCH_NODE_ID: 'd_abc123_2',
    });
  });

  it('payload-driven lane gets ART_<UPPER_KEY> for each extra field', () => {
    const env = buildArtEnv(
      bareStage({
        dispatch: {
          nodeId: 'd_xx_0',
          parentNodeId: 'root',
          invocationId: 'd_xx',
          copyIndex: 0,
          localName: 'probe',
          substitutions: {
            insertId: 'd_xx_0',
            index: 0,
            variant: 'alpha',
            seed: 42,
            enabled: true,
          },
        },
      }),
    );
    expect(env.ART_VARIANT).toBe('alpha');
    expect(env.ART_SEED).toBe('42');
    expect(env.ART_ENABLED).toBe('true');
    // built-ins still correct
    expect(env.ART_INSERT_ID).toBe('d_xx');
    expect(env.ART_LANE_INDEX).toBe('0');
  });

  it('insertId / index substitution keys do not leak as ART_INSERTID', () => {
    const env = buildArtEnv(
      bareStage({
        dispatch: {
          nodeId: 'd_x_0',
          parentNodeId: 'root',
          invocationId: 'd_x',
          copyIndex: 0,
          localName: 'probe',
          substitutions: { insertId: 'd_x_0', index: 0 },
        },
      }),
    );
    expect(env).not.toHaveProperty('ART_INSERTID');
    expect(env).not.toHaveProperty('ART_INDEX');
  });
});

describe('mergeStageEnv', () => {
  it('combines author env with ART_* (ART_* wins on conflict)', () => {
    const merged = mergeStageEnv(
      bareStage({
        env: { OTHER: 'keep', ART_LANE_INDEX: 'attempt-override' },
      }),
    );
    expect(merged.OTHER).toBe('keep');
    expect(merged.ART_LANE_INDEX).toBe('0');
  });

  it('emits ART_<UPPER> alongside author env for payload lanes', () => {
    const merged = mergeStageEnv(
      bareStage({
        env: { LOG_LEVEL: 'debug' },
        dispatch: {
          nodeId: 'd_x_1',
          parentNodeId: 'root',
          invocationId: 'd_x',
          copyIndex: 1,
          localName: 'probe',
          substitutions: { insertId: 'd_x_1', index: 1, variant: 'beta' },
        },
      }),
    );
    expect(merged.LOG_LEVEL).toBe('debug');
    expect(merged.ART_VARIANT).toBe('beta');
    expect(merged.ART_LANE_INDEX).toBe('1');
  });
});
