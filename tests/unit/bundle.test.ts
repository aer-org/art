import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  contentHash,
  loadBundleMeta,
  saveBundleMeta,
  readBundleFiles,
  classifyFile,
  type BundleMetadata,
} from '../../src/bundle.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-bundle-test-'));
  tmpDirs.push(dir);
  return dir;
}

describe('contentHash', () => {
  it('produces a sha256-prefixed hash', () => {
    const hash = contentHash('hello world');
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('produces deterministic output', () => {
    expect(contentHash('test')).toBe(contentHash('test'));
  });

  it('produces different hashes for different content', () => {
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });
});

describe('bundle metadata', () => {
  it('returns null when no .art-bundle.json exists', () => {
    const dir = makeTmp();
    expect(loadBundleMeta(dir)).toBeNull();
  });

  it('round-trips metadata', () => {
    const dir = makeTmp();
    const meta: BundleMetadata = {
      remote: 'origin',
      pipeline_name: 'test-pipe',
      tag: 'latest',
      pulled_at: '2026-04-27T00:00:00Z',
      hashes: {
        'pipeline.json': 'sha256:abc',
        'agents/test.md': 'sha256:def',
      },
    };
    saveBundleMeta(dir, meta);
    expect(loadBundleMeta(dir)).toEqual(meta);
  });
});

describe('readBundleFiles', () => {
  it('reads all files recursively, skipping .art-bundle.json', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'pipeline.json'), '{}');
    fs.mkdirSync(path.join(dir, 'agents'));
    fs.writeFileSync(path.join(dir, 'agents', 'bot.md'), '# Bot prompt');
    fs.writeFileSync(
      path.join(dir, '.art-bundle.json'),
      '{"should":"be_skipped"}',
    );

    const files = readBundleFiles(dir);
    const paths = files.map((f) => f.relPath).sort();
    expect(paths).toEqual(['agents/bot.md', 'pipeline.json']);
    expect(files.every((f) => f.hash.startsWith('sha256:'))).toBe(true);
  });
});

describe('classifyFile', () => {
  it('classifies agent files', () => {
    expect(classifyFile('agents/scope-analyzer.md')).toEqual({
      kind: 'agent',
      name: 'scope-analyzer',
    });
  });

  it('classifies template files', () => {
    expect(classifyFile('templates/per-section.json')).toEqual({
      kind: 'template',
      name: 'per-section',
    });
  });

  it('classifies dockerfile files', () => {
    expect(classifyFile('dockerfiles/art-codex-vcs.Dockerfile')).toEqual({
      kind: 'dockerfile',
      name: 'art-codex-vcs',
    });
  });

  it('classifies pipeline.json', () => {
    expect(classifyFile('pipeline.json')).toEqual({
      kind: 'pipeline',
      name: 'pipeline',
    });
  });

  it('returns unknown for unrecognized files', () => {
    expect(classifyFile('README.md')).toEqual({
      kind: 'unknown',
      name: 'README.md',
    });
  });
});
