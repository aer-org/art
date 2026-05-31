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

export interface DiffMountSkip {
  key: string;
  reason: string;
}

export interface DiffMountDecision {
  resolved: RwMount[];
  skipped: DiffMountSkip[];
}

function isValidSubPath(subPath: string): boolean {
  if (!subPath) return false;
  if (subPath.startsWith('/')) return false;
  const segments = subPath.split('/');
  return segments.every((s) => s !== '' && s !== '..' && s !== '.');
}

/**
 * Decide which of a stage's rw mounts are eligible for pre-state snapshot
 * + diff. Sub-path mounts (`<parent>:<sub>`) resolve to the subdir on the
 * host so a stitched lane that only mounts its own slice (e.g.
 * `sweep:S175x175`) still produces a diff. Anything we cannot diff is
 * returned in `skipped` with a human-readable reason — the caller logs it
 * and (at run start) gates on approval.
 *
 * Project mounts:
 *   - Bare `project` is skipped by policy. A hardlink-snapshot of the
 *     entire project tree would copy `.git`, `node_modules`, build
 *     outputs, *and* the stage archive itself (`__art__/.state/runs/...`)
 *     which lives inside the project, creating a recursive blow-up.
 *   - `project:<sub>` resolves to `<projectDir>/<sub>` and goes through
 *     the same size gate as any other rw mount. The only sub-paths
 *     skipped are those that would snapshot `__art__/` itself.
 */
export function classifyDiffMounts(
  mounts: Record<string, 'ro' | 'rw' | null | undefined>,
  groupDir: string,
): DiffMountDecision {
  const resolved: RwMount[] = [];
  const skipped: DiffMountSkip[] = [];
  const projectDir = path.dirname(groupDir);
  const artDirName = path.basename(groupDir);
  for (const [key, policy] of Object.entries(mounts ?? {})) {
    if (policy !== 'rw') continue;
    if (key === 'project') {
      skipped.push({
        key,
        reason:
          'project mount (whole tree includes __art__; use project:<sub> for targeted diffs)',
      });
      continue;
    }
    if (key.includes(':')) {
      const sepIdx = key.indexOf(':');
      const parentKey = key.slice(0, sepIdx);
      const subPath = key.slice(sepIdx + 1);
      if (!isValidSubPath(subPath)) {
        skipped.push({ key, reason: `invalid sub-path "${subPath}"` });
        continue;
      }
      if (parentKey === 'project') {
        if (subPath === artDirName || subPath.startsWith(`${artDirName}/`)) {
          skipped.push({
            key,
            reason: `project sub-path overlaps with ${artDirName}/`,
          });
          continue;
        }
        resolved.push({
          name: key.replace(/[:/]/g, '__'),
          hostPath: path.join(projectDir, subPath),
        });
        continue;
      }
      resolved.push({
        name: key.replace(/[:/]/g, '__'),
        hostPath: path.join(groupDir, parentKey, subPath),
      });
      continue;
    }
    resolved.push({ name: key, hostPath: path.join(groupDir, key) });
  }
  return { resolved, skipped };
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
 * Strategy: try `cp -al` first (hardlink — instant, near-zero disk).
 * Linux's `fs.protected_hardlinks` rejects hardlinks from a non-owner
 * without write access, which trips on root-owned files left behind
 * by `runAsRoot: true` stages. When that happens for a given mount,
 * we wipe the partial snapshot and retry with `cp -a` (full copy) for
 * just that mount.
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
      if (!snapshotMount(m.hostPath, dst, m.name)) {
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

function snapshotMount(
  hostPath: string,
  dst: string,
  mountKey: string,
): boolean {
  const link = spawnSync('cp', ['-al', hostPath, dst]);
  if (link.status === 0) return true;

  // Clean whatever the partial hardlink attempt left behind so the
  // full copy starts from a clean slate.
  try {
    fs.rmSync(dst, { recursive: true, force: true });
  } catch {
    // ignore
  }

  const full = spawnSync('cp', ['-a', hostPath, dst]);
  if (full.status === 0) {
    // One line per mount instead of one per file when cp fans out the
    // permission error to every root-owned entry under the tree.
    console.error(
      `[diff] hardlink-copy denied for "${mountKey}" (root-owned files?); fell back to full copy`,
    );
    return true;
  }

  console.error(
    `[diff] snapshot failed for "${mountKey}" via both cp -al and cp -a: ${full.stderr?.toString().split('\n')[0] ?? ''}`,
  );
  return false;
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
