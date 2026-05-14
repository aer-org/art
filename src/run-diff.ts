/**
 * Artifact diff capture for L1 stage I/O.
 *
 * Strategy: ephemeral pre-state snapshot via hardlink-copy (`cp -al`) into
 * a tmpdir inside the stage's recorder folder, then `git diff --no-index`
 * against the live rw mount at stage end. The snapshot is destroyed once
 * the diff is written. Pre-state is *not* preserved beyond stage runtime.
 *
 * Best-effort: every operation that fails logs to console.error and the
 * stage continues. A missing `git` or `cp` binary disables diff for the
 * run; it does not abort the run.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface RwMount {
  name: string; // mount key (e.g. "src")
  hostPath: string; // absolute path on host
}

let _hostBinariesChecked = false;
let _hostBinariesOk = false;

/**
 * One-time check that `cp` and `git` are available. Result is cached for
 * the lifetime of the process. Falsy result disables artifact diff.
 */
export function diffHostBinariesAvailable(): boolean {
  if (_hostBinariesChecked) return _hostBinariesOk;
  _hostBinariesChecked = true;
  try {
    const cp = spawnSync('cp', ['--version'], { stdio: 'ignore' });
    const git = spawnSync('git', ['--version'], { stdio: 'ignore' });
    _hostBinariesOk = cp.status === 0 && git.status === 0;
  } catch {
    _hostBinariesOk = false;
  }
  return _hostBinariesOk;
}

/**
 * Snapshot rw mounts via hardlink copy. Returns the snapshot dir path,
 * or null if snapshot fails or there are no mounts to snapshot.
 *
 * Note: `cp -al` makes a hardlink-only copy. For files the stage doesn't
 * touch, it costs ~one inode each. Files the stage modifies are detached
 * (copy-on-write) by docker volumes / standard write-then-rename patterns.
 */
export function captureStagePreState(
  stageDir: string,
  mounts: RwMount[],
): string | null {
  if (mounts.length === 0) return null;
  if (!diffHostBinariesAvailable()) return null;
  const snapDir = path.join(stageDir, '.pre');
  try {
    fs.mkdirSync(snapDir, { recursive: true });
    for (const m of mounts) {
      if (!fs.existsSync(m.hostPath)) continue;
      const dst = path.join(snapDir, m.name);
      const r = spawnSync('cp', ['-al', m.hostPath, dst]);
      if (r.status !== 0) {
        console.error(
          `[diff] cp -al failed for ${m.name}: ${r.stderr?.toString() ?? ''}`,
        );
        // Clean up partial snapshot so we don't leak inodes.
        try {
          fs.rmSync(snapDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
        return null;
      }
    }
    return snapDir;
  } catch (err) {
    console.error(
      `[diff] pre-state snapshot failed: ${(err as Error).message}`,
    );
    return null;
  }
}

/**
 * Produce per-mount unified diffs comparing pre-state snapshot vs current
 * state. Writes `diff/<mount>.diff` and `diff/summary.json`. Always
 * removes the pre-state snapshot dir (best-effort) so disk doesn't bloat.
 */
export function diffStagePostState(
  stageDir: string,
  preStateDir: string,
  mounts: RwMount[],
): void {
  const diffDir = path.join(stageDir, 'diff');
  try {
    fs.mkdirSync(diffDir, { recursive: true });
    const entries: Array<{
      mount: string;
      changed: boolean;
      bytes: number;
    }> = [];
    for (const m of mounts) {
      const post = m.hostPath;
      if (!fs.existsSync(post)) continue;
      const pre = path.join(preStateDir, m.name);
      const usePre = fs.existsSync(pre) ? pre : '/dev/null';
      const r = spawnSync(
        'git',
        ['diff', '--no-index', '--no-color', usePre, post],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      // git diff exits 1 when there are differences — that's expected.
      const stdout = r.stdout?.toString() ?? '';
      const out = path.join(diffDir, `${m.name}.diff`);
      fs.writeFileSync(out, stdout);
      entries.push({
        mount: m.name,
        changed: stdout.length > 0,
        bytes: stdout.length,
      });
    }
    fs.writeFileSync(
      path.join(diffDir, 'summary.json'),
      JSON.stringify({ schemaVersion: 1, mounts: entries }, null, 2),
    );
  } catch (err) {
    console.error(`[diff] post-state diff failed: ${(err as Error).message}`);
  } finally {
    try {
      fs.rmSync(preStateDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Sum bytes used by a directory (best-effort `du -sb`). Returns 0 on
 * failure so the size gate never blocks a run on metadata trouble.
 */
export function dirSizeBytes(p: string): number {
  if (!fs.existsSync(p)) return 0;
  const r = spawnSync('du', ['-sb', p], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.status !== 0) return 0;
  const out = r.stdout?.toString().trim() ?? '';
  const m = /^(\d+)/.exec(out);
  return m ? Number(m[1]) : 0;
}
