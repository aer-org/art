import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  captureStagePreState,
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

describe('dirSizeBytes', () => {
  it('returns 0 for missing path', () => {
    expect(dirSizeBytes(path.join(tmpDir, 'nope'))).toBe(0);
  });

  it('returns non-zero for a populated dir', () => {
    fs.writeFileSync(path.join(mountDir, 'a.txt'), 'x'.repeat(1024));
    expect(dirSizeBytes(mountDir)).toBeGreaterThan(0);
  });
});
