/**
 * Run manifest and current-run persistence.
 *
 * CRUD helpers for pipeline run tracking:
 * - _current.json: which run is active (PID guard)
 * - {runId}.json: per-run manifest with stage history
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// --- Run ID ---

export function generateRunId(): string {
  return `run-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

// --- Interfaces ---

export interface RunManifest {
  runId: string;
  pid: number;
  startTime: string;
  endTime?: string;
  status: 'running' | 'success' | 'error' | 'cancelled';
  stages: Array<{ name: string; status: string; duration?: number }>;
  logFile?: string;
  outputLogFile?: string;
}

export interface CurrentRunInfo {
  runId: string;
  pid: number;
  startTime: string;
}

// --- Helpers ---

function runsDir(groupDir: string): string {
  return path.join(groupDir, 'runs');
}

// --- Current Run ---

export function writeCurrentRun(groupDir: string, info: CurrentRunInfo): void {
  const dir = runsDir(groupDir);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, '_current.json.tmp');
  const filePath = path.join(dir, '_current.json');
  fs.writeFileSync(tmpPath, JSON.stringify(info, null, 2));
  fs.renameSync(tmpPath, filePath);
}

export function readCurrentRun(groupDir: string): CurrentRunInfo | null {
  try {
    const raw = fs.readFileSync(
      path.join(runsDir(groupDir), '_current.json'),
      'utf-8',
    );
    return JSON.parse(raw) as CurrentRunInfo;
  } catch {
    return null;
  }
}

export function removeCurrentRun(groupDir: string): void {
  try {
    fs.unlinkSync(path.join(runsDir(groupDir), '_current.json'));
  } catch {
    /* file may not exist */
  }
}

// --- Run Manifest ---

export function writeRunManifest(
  groupDir: string,
  manifest: RunManifest,
): void {
  const dir = runsDir(groupDir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${manifest.runId}.json`);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmpPath, filePath);
}

export function readRunManifest(
  groupDir: string,
  runId: string,
): RunManifest | null {
  try {
    const raw = fs.readFileSync(
      path.join(runsDir(groupDir), `${runId}.json`),
      'utf-8',
    );
    return JSON.parse(raw) as RunManifest;
  } catch {
    return null;
  }
}

export function listRunManifests(groupDir: string): RunManifest[] {
  const dir = runsDir(groupDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('run-') && f.endsWith('.json'))
    .sort()
    .reverse()
    .map((f) => {
      try {
        return JSON.parse(
          fs.readFileSync(path.join(dir, f), 'utf-8'),
        ) as RunManifest;
      } catch {
        return null;
      }
    })
    .filter((m): m is RunManifest => m !== null);
}

// --- PID ---

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
