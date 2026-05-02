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
});
