import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  captureStagePreState,
  classifyDiffMounts,
  diffStagePostState,
  diffHostBinariesAvailable,
  dirSizeBytes,
} from '../../src/run-diff.js';

let tmpDir: string;
let stageDir: string;
let mountDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-diff-test-'));
  stageDir = path.join(tmpDir, 'stage');
  mountDir = path.join(tmpDir, 'src');
  fs.mkdirSync(stageDir, { recursive: true });
  fs.mkdirSync(mountDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('captureStagePreState + diffStagePostState', () => {
  it('returns null when there are no rw mounts', () => {
    const r = captureStagePreState(stageDir, []);
    expect(r).toBeNull();
  });

  it('skips snapshot when the mount dir does not exist', () => {
    const r = captureStagePreState(stageDir, [
      { name: 'missing', hostPath: path.join(tmpDir, 'nope') },
    ]);
    // .pre dir still created but no per-mount subdir
    expect(r).toBe(path.join(stageDir, '.pre'));
    expect(fs.existsSync(path.join(r!, 'missing'))).toBe(false);
  });

  it('snapshots mount via hardlinks and detects new file as added', () => {
    fs.writeFileSync(path.join(mountDir, 'before.txt'), 'before\n');

    const pre = captureStagePreState(stageDir, [
      { name: 'src', hostPath: mountDir },
    ]);
    expect(pre).not.toBeNull();
    expect(fs.existsSync(path.join(pre!, 'src', 'before.txt'))).toBe(true);

    // Simulate the stage running and writing a new file in the rw mount.
    fs.writeFileSync(path.join(mountDir, 'after.txt'), 'new content\n');

    diffStagePostState(stageDir, pre!, [{ name: 'src', hostPath: mountDir }]);

    const diffFile = path.join(stageDir, 'diff', 'src.diff');
    expect(fs.existsSync(diffFile)).toBe(true);
    const diff = fs.readFileSync(diffFile, 'utf-8');
    expect(diff).toContain('after.txt');
    expect(diff).toContain('new content');

    // Snapshot dir is removed after diff.
    expect(fs.existsSync(pre!)).toBe(false);

    // summary.json captures per-mount changed status.
    const summary = JSON.parse(
      fs.readFileSync(path.join(stageDir, 'diff', 'summary.json'), 'utf-8'),
    );
    expect(summary.schemaVersion).toBe(1);
    expect(summary.mounts).toEqual([
      expect.objectContaining({ mount: 'src', changed: true }),
    ]);
  });

  it('detects in-place file modification', () => {
    fs.writeFileSync(path.join(mountDir, 'file.txt'), 'original\n');

    const pre = captureStagePreState(stageDir, [
      { name: 'src', hostPath: mountDir },
    ]);

    // Simulate the stage rewriting the file (write-then-rename pattern, which
    // breaks the hardlink; the snapshot keeps the original inode).
    fs.unlinkSync(path.join(mountDir, 'file.txt'));
    fs.writeFileSync(path.join(mountDir, 'file.txt'), 'updated\n');

    diffStagePostState(stageDir, pre!, [{ name: 'src', hostPath: mountDir }]);

    const diff = fs.readFileSync(
      path.join(stageDir, 'diff', 'src.diff'),
      'utf-8',
    );
    expect(diff).toContain('-original');
    expect(diff).toContain('+updated');
  });

  it('records unchanged mount with changed:false', () => {
    fs.writeFileSync(path.join(mountDir, 'stable.txt'), 'unchanged\n');

    const pre = captureStagePreState(stageDir, [
      { name: 'src', hostPath: mountDir },
    ]);
    // No modifications to mountDir.
    diffStagePostState(stageDir, pre!, [{ name: 'src', hostPath: mountDir }]);

    const diff = fs.readFileSync(
      path.join(stageDir, 'diff', 'src.diff'),
      'utf-8',
    );
    expect(diff).toBe('');
    const summary = JSON.parse(
      fs.readFileSync(path.join(stageDir, 'diff', 'summary.json'), 'utf-8'),
    );
    expect(summary.mounts).toEqual([
      expect.objectContaining({ mount: 'src', changed: false, bytes: 0 }),
    ]);
  });
});

describe('diffHostBinariesAvailable', () => {
  it('returns boolean (cached) — depends on host having cp + git', () => {
    // We expect dev hosts to have both. CI: same. Just assert call works.
    const r = diffHostBinariesAvailable();
    expect(typeof r).toBe('boolean');
  });
});

describe('classifyDiffMounts', () => {
  // groupDir is the project's __art__/ — same convention as cli/run.ts.
  const groupDir = '/proj/__art__';

  it('resolves a plain art-managed rw mount', () => {
    const { resolved, skipped } = classifyDiffMounts(
      { results: 'rw', plan: 'ro' },
      groupDir,
    );
    expect(resolved).toEqual([
      { name: 'results', hostPath: '/proj/__art__/results' },
    ]);
    expect(skipped).toEqual([]);
  });

  it('skips bare `project` (whole tree would include __art__)', () => {
    const { resolved, skipped } = classifyDiffMounts(
      { project: 'rw' },
      groupDir,
    );
    expect(resolved).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].key).toBe('project');
    expect(skipped[0].reason).toMatch(/project mount/);
  });

  it('resolves a project sub-path to <projectDir>/<sub>', () => {
    const { resolved, skipped } = classifyDiffMounts(
      { 'project:reports': 'rw' },
      groupDir,
    );
    expect(resolved).toEqual([
      { name: 'project__reports', hostPath: '/proj/reports' },
    ]);
    expect(skipped).toEqual([]);
  });

  it('resolves a nested project sub-path', () => {
    const { resolved } = classifyDiffMounts(
      { 'project:build/outputs': 'rw' },
      groupDir,
    );
    expect(resolved).toEqual([
      {
        name: 'project__build__outputs',
        hostPath: '/proj/build/outputs',
      },
    ]);
  });

  it('skips project sub-paths overlapping __art__', () => {
    const { resolved, skipped } = classifyDiffMounts(
      {
        'project:__art__': 'rw',
        'project:__art__/something': 'rw',
        'project:reports': 'rw',
      },
      groupDir,
    );
    expect(resolved).toEqual([
      { name: 'project__reports', hostPath: '/proj/reports' },
    ]);
    expect(skipped.map((s) => s.key).sort()).toEqual([
      'project:__art__',
      'project:__art__/something',
    ]);
    for (const s of skipped) expect(s.reason).toMatch(/__art__/);
  });

  it('skips invalid sub-paths', () => {
    const { resolved, skipped } = classifyDiffMounts(
      { 'project:': 'rw', 'project:../escape': 'rw', 'sweep:./.': 'rw' },
      groupDir,
    );
    expect(resolved).toEqual([]);
    expect(skipped.map((s) => s.key).sort()).toEqual([
      'project:',
      'project:../escape',
      'sweep:./.',
    ]);
  });

  it('resolves non-project sub-paths under groupDir', () => {
    const { resolved } = classifyDiffMounts({ 'sweep:lane-0': 'rw' }, groupDir);
    expect(resolved).toEqual([
      { name: 'sweep__lane-0', hostPath: '/proj/__art__/sweep/lane-0' },
    ]);
  });

  it('ignores ro / null mounts', () => {
    const { resolved, skipped } = classifyDiffMounts(
      { results: 'ro', 'project:src': null, 'project:reports': 'rw' },
      groupDir,
    );
    expect(resolved).toEqual([
      { name: 'project__reports', hostPath: '/proj/reports' },
    ]);
    expect(skipped).toEqual([]);
  });
});

describe('dirSizeBytes', () => {
  it('returns 0 for missing path', () => {
    expect(dirSizeBytes(path.join(tmpDir, 'nope'))).toBe(0);
  });

  it('returns non-zero for a populated dir', () => {
    fs.writeFileSync(path.join(mountDir, 'a.txt'), 'x'.repeat(1024));
    expect(dirSizeBytes(mountDir)).toBeGreaterThan(0);
  });
});
