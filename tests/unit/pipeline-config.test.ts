import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  formatPipelineConfigLoadError,
  getLastPipelineConfigLoadError,
  loadPipelineConfig,
} from '../../src/pipeline-config.js';

describe('pipeline config load diagnostics', () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    for (const root of tmpRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-pipeline-config-'));
    tmpRoots.push(dir);
    return dir;
  }

  it('records missing pipeline files separately from invalid files', () => {
    const dir = makeTmpDir();

    expect(loadPipelineConfig('test', dir)).toBeNull();

    const error = getLastPipelineConfigLoadError();
    expect(error).toMatchObject({
      kind: 'missing',
      path: path.join(dir, 'PIPELINE.json'),
    });
    expect(formatPipelineConfigLoadError(error)).toBe(
      `No ${path.join(dir, 'PIPELINE.json')} found`,
    );
  });

  it('records the validation reason for removed fan_in fields', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(
      path.join(dir, 'PIPELINE.json'),
      JSON.stringify({
        stages: [
          {
            name: 'summarize',
            prompt: 'Summarize results',
            fan_in: 'all',
            transitions: [{ marker: 'DONE', next: null }],
          },
        ],
      }),
    );

    expect(loadPipelineConfig('test', dir)).toBeNull();

    const error = getLastPipelineConfigLoadError();
    expect(error).toMatchObject({
      kind: 'invalid',
      path: path.join(dir, 'PIPELINE.json'),
      message:
        'Stage "fan_in" is no longer supported; multi-predecessor fan-in is automatic',
      details: {
        stage: 'summarize',
        fan_in: 'all',
      },
    });
    expect(formatPipelineConfigLoadError(error)).toContain(
      `${path.join(dir, 'PIPELINE.json')} is invalid: Stage "fan_in" is no longer supported`,
    );
    expect(formatPipelineConfigLoadError(error)).toContain(
      'stage: "summarize"',
    );
    expect(formatPipelineConfigLoadError(error)).toContain('fan_in: "all"');
  });

  it('records JSON parse errors with the parser message', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, 'PIPELINE.json'), '{ "stages": [');

    expect(loadPipelineConfig('test', dir)).toBeNull();

    const error = getLastPipelineConfigLoadError();
    expect(error).toMatchObject({
      kind: 'parse',
      path: path.join(dir, 'PIPELINE.json'),
      message: 'Failed to parse PIPELINE.json',
    });
    expect(formatPipelineConfigLoadError(error)).toContain(
      `${path.join(dir, 'PIPELINE.json')} is invalid: Failed to parse PIPELINE.json`,
    );
    expect(formatPipelineConfigLoadError(error)).toContain('error: ');
  });

  it('clears the previous diagnostic after a successful load', () => {
    const missingDir = makeTmpDir();
    expect(loadPipelineConfig('test', missingDir)).toBeNull();
    expect(getLastPipelineConfigLoadError()).not.toBeNull();

    const validDir = makeTmpDir();
    fs.writeFileSync(
      path.join(validDir, 'PIPELINE.json'),
      JSON.stringify({
        stages: [
          {
            name: 'done',
            prompt: 'Finish',
            transitions: [{ marker: 'DONE', next: null }],
          },
        ],
      }),
    );

    expect(loadPipelineConfig('test', validDir)).not.toBeNull();
    expect(getLastPipelineConfigLoadError()).toBeNull();
  });

  it('resolves local agent prompts without leaving a registry ref behind', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'agents'));
    fs.writeFileSync(
      path.join(dir, 'agents', 'summarize.md'),
      'Local summary prompt',
    );
    fs.writeFileSync(
      path.join(dir, 'PIPELINE.json'),
      JSON.stringify({
        stages: [
          {
            name: 'summarize',
            agent: 'summarize',
            transitions: [{ marker: 'DONE', next: null }],
          },
        ],
      }),
    );

    const config = loadPipelineConfig('test', dir);

    expect(config?.stages[0].prompt).toBe('Local summary prompt');
    expect(config?.stages[0].agent).toBeUndefined();
    expect(getLastPipelineConfigLoadError()).toBeNull();
  });

  it('accepts multi-target next arrays for heterogeneous fan-out', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(
      path.join(dir, 'PIPELINE.json'),
      JSON.stringify({
        stages: [
          {
            name: 'A',
            prompt: 'start',
            transitions: [{ marker: 'DONE', next: ['B', 'C'] }],
          },
          {
            name: 'B',
            prompt: 'branch b',
            transitions: [{ marker: 'DONE', next: 'D' }],
          },
          {
            name: 'C',
            prompt: 'branch c',
            transitions: [{ marker: 'DONE', next: 'D' }],
          },
          {
            name: 'D',
            prompt: 'join',
            transitions: [{ marker: 'DONE', next: null }],
          },
        ],
      }),
    );

    const config = loadPipelineConfig('test', dir);
    expect(getLastPipelineConfigLoadError()).toBeNull();
    expect(config?.stages[0].transitions[0].next).toEqual(['B', 'C']);
  });

  it('rejects multi-target next that introduces a cycle', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(
      path.join(dir, 'PIPELINE.json'),
      JSON.stringify({
        stages: [
          {
            name: 'A',
            prompt: 'start',
            transitions: [{ marker: 'DONE', next: ['B', 'A'] }],
          },
          {
            name: 'B',
            prompt: 'branch',
            transitions: [{ marker: 'DONE', next: null }],
          },
        ],
      }),
    );

    expect(loadPipelineConfig('test', dir)).toBeNull();
    const error = getLastPipelineConfigLoadError();
    expect(error?.message).toBe(
      'PIPELINE.json contains a cycle — pipelines must be DAGs',
    );
  });

  it('rejects next array entries that do not reference existing stages', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(
      path.join(dir, 'PIPELINE.json'),
      JSON.stringify({
        stages: [
          {
            name: 'A',
            prompt: 'start',
            transitions: [{ marker: 'DONE', next: ['B', 'GHOST'] }],
          },
          {
            name: 'B',
            prompt: 'branch',
            transitions: [{ marker: 'DONE', next: null }],
          },
        ],
      }),
    );

    expect(loadPipelineConfig('test', dir)).toBeNull();
    expect(getLastPipelineConfigLoadError()?.message).toBe(
      'Transition "next" array entry "GHOST" does not reference an existing stage in this pipeline',
    );
  });

  it('rejects empty next arrays', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(
      path.join(dir, 'PIPELINE.json'),
      JSON.stringify({
        stages: [
          {
            name: 'A',
            prompt: 'start',
            transitions: [{ marker: 'DONE', next: [] }],
          },
        ],
      }),
    );

    expect(loadPipelineConfig('test', dir)).toBeNull();
    expect(getLastPipelineConfigLoadError()?.message).toBe(
      'Transition "next" array must contain at least one target (use null to end the current scope)',
    );
  });

  it('rejects duplicate entries inside a next array', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(
      path.join(dir, 'PIPELINE.json'),
      JSON.stringify({
        stages: [
          {
            name: 'A',
            prompt: 'start',
            transitions: [{ marker: 'DONE', next: ['B', 'B'] }],
          },
          {
            name: 'B',
            prompt: 'branch',
            transitions: [{ marker: 'DONE', next: null }],
          },
        ],
      }),
    );

    expect(loadPipelineConfig('test', dir)).toBeNull();
    expect(getLastPipelineConfigLoadError()?.message).toBe(
      'Transition "next" array contains duplicate target "B"',
    );
  });

  it('rejects combining template stitch with a multi-target next array', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, 'templates'));
    fs.writeFileSync(
      path.join(dir, 'templates', 'lane.json'),
      JSON.stringify({
        entry: 'inner',
        stages: [
          {
            name: 'inner',
            prompt: 'inner',
            transitions: [{ marker: 'DONE', next: null }],
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'PIPELINE.json'),
      JSON.stringify({
        stages: [
          {
            name: 'A',
            prompt: 'start',
            transitions: [
              { marker: 'DONE', template: 'lane', next: ['B', 'C'] },
            ],
          },
          {
            name: 'B',
            prompt: 'b',
            transitions: [{ marker: 'DONE', next: null }],
          },
          {
            name: 'C',
            prompt: 'c',
            transitions: [{ marker: 'DONE', next: null }],
          },
        ],
      }),
    );

    expect(loadPipelineConfig('test', dir)).toBeNull();
    expect(getLastPipelineConfigLoadError()?.message).toBe(
      'Transition "next" array cannot be combined with "template" — template stitch produces its own per-lane downstream',
    );
  });
});
