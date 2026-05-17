/**
 * run-registry — scan-based queries over runs/<id>/ directories. No pointer
 * files. Three derived states (live, crashed, sealed) classify each run by
 * sealed-marker presence and PID liveness on the same host.
 *
 * Classification precedence: sealed > pid alive > pid dead. Ambiguous cases
 * (missing run.json, malformed JSON, missing pid) classify as crashed.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export type RunState = 'live' | 'crashed' | 'sealed';

export interface RunHeader {
  runId: string;
  state: RunState;
  pid?: number;
  hostname?: string;
  startTime?: string;
  provider?: string;
  image?: string;
}

function runsRoot(stateDir: string): string {
  return path.join(stateDir, 'runs');
}

function readRunJson(runDir: string): Partial<RunHeader> | null {
  try {
    const raw = fs.readFileSync(path.join(runDir, 'run.json'), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't deliver a signal; just checks permission/existence.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function classifyRun(stateDir: string, runId: string): RunHeader {
  const runDir = path.join(runsRoot(stateDir), runId);
  const sealed = fs.existsSync(path.join(runDir, 'sealed'));
  const meta = readRunJson(runDir) ?? {};

  if (sealed) {
    return { runId, state: 'sealed', ...meta };
  }
  if (typeof meta.pid !== 'number' || meta.pid <= 0) {
    return { runId, state: 'crashed', ...meta };
  }
  // PID-based liveness is host-local. If hostname mismatches, we cannot tell.
  const sameHost = !meta.hostname || meta.hostname === os.hostname();
  const live = sameHost && isPidAlive(meta.pid);
  return {
    runId,
    state: live ? 'live' : 'crashed',
    ...meta,
  };
}

export function listRuns(stateDir: string): RunHeader[] {
  const dir = runsRoot(stateDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((entry) => {
      if (!entry.startsWith('run-')) return false;
      try {
        return fs.statSync(path.join(dir, entry)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .reverse()
    .map((entry) => classifyRun(stateDir, entry));
}

export function liveRuns(stateDir: string): RunHeader[] {
  return listRuns(stateDir).filter((r) => r.state === 'live');
}

export function crashedRuns(stateDir: string): RunHeader[] {
  return listRuns(stateDir).filter((r) => r.state === 'crashed');
}

export function sealedRuns(stateDir: string): RunHeader[] {
  return listRuns(stateDir).filter((r) => r.state === 'sealed');
}

export function findRun(stateDir: string, runId: string): RunHeader | null {
  const runDir = path.join(runsRoot(stateDir), runId);
  if (!fs.existsSync(runDir)) return null;
  return classifyRun(stateDir, runId);
}

/**
 * Resolve the retention limit from `ART_KEEP_RUNS` (default 10). Negative or
 * non-numeric values disable retention (keep everything).
 */
export function resolveRetentionLimit(): number {
  const raw = process.env.ART_KEEP_RUNS;
  if (raw === undefined || raw === '') return 10;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return Number.POSITIVE_INFINITY;
  return Math.floor(n);
}

/**
 * Delete sealed runs older than the most-recent `keep` sealed runs. Live and
 * crashed runs are never touched (the user may want to inspect or resume
 * them). Best-effort: any individual rm failure logs once and the sweep
 * continues. Returns the runIds that were deleted.
 */
export function sweepSealedRuns(stateDir: string, keep: number): string[] {
  if (!Number.isFinite(keep)) return [];
  const sealed = sealedRuns(stateDir);
  if (sealed.length <= keep) return [];
  // sealedRuns is already sorted newest-first by listRuns.
  const toDelete = sealed.slice(keep);
  const deleted: string[] = [];
  for (const run of toDelete) {
    const dir = path.join(runsRoot(stateDir), run.runId);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      deleted.push(run.runId);
    } catch (err) {
      console.error(
        `[run-registry] failed to remove ${run.runId}: ${(err as Error).message}`,
      );
    }
  }
  return deleted;
}
