import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { scaffoldArtDir } from '../../../src/cli/init.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('scaffoldArtDir', () => {
  it('creates the default pipeline scaffold in tests/unit-compatible layout', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-init-test-'));
    tmpRoots.push(projectDir);

    scaffoldArtDir(projectDir);

    const artDir = path.join(projectDir, '__art__');
    const pipelinePath = path.join(artDir, 'PIPELINE.json');
    const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8')) as {
      entryStage: string;
      stages: Array<{
        name: string;
        transitions: Array<{ marker: string; next: string | null }>;
      }>;
    };

    expect(pipeline.entryStage).toBe('build');
    expect(pipeline.stages.map((stage) => stage.name)).toEqual([
      'build',
      'test',
      'review',
      'history',
    ]);
    expect(
      pipeline.stages
        .map(
          (stage) =>
            stage.transitions.find(
              (transition) => transition.marker === '[STAGE_COMPLETE]',
            )?.next,
        )
        .slice(0, 4),
    ).toEqual(['test', 'review', 'history', null]);

    for (const dir of [
      'plan',
      'src',
      'logs',
      'metrics',
      'insights',
      'memory',
      'outputs',
      'tests',
    ]) {
      expect(fs.existsSync(path.join(artDir, dir))).toBe(true);
    }
  });
});
