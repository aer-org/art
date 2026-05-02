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
  it('creates a minimal pipeline authoring scaffold', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-init-test-'));
    tmpRoots.push(projectDir);

    scaffoldArtDir(projectDir);

    const artDir = path.join(projectDir, '__art__');
    const pipelinePath = path.join(artDir, 'PIPELINE.json');
    const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8')) as {
      stages: unknown[];
    };

    expect(pipeline.stages).toEqual([]);

    for (const dir of ['agents', 'templates', 'logs']) {
      expect(fs.existsSync(path.join(artDir, dir))).toBe(true);
    }
    for (const dir of ['plan', 'metrics', 'insights', 'memory', 'outputs']) {
      expect(fs.existsSync(path.join(artDir, dir))).toBe(false);
    }
  });
});
