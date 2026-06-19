import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { APP_ROOT, ART_BIN, ART_DIR_NAME, childProcessEnv } from './config.ts';
import type { RunManifest } from './types.ts';

export interface RunHandle {
  projectDir: string;
  proc: ChildProcess;
  startedAt: number;
  log: string[]; // ring buffer of recent stdout/stderr lines
}

export interface ActiveRunInfo {
  projectDir: string;
  pid: number;
  startedAt: number;
  startTime?: string;
  runId?: string;
  source: 'local' | 'external';
}

export interface RunStartingInfo {
  projectDir: string;
  startedAt: number;
  source: 'chat';
}

export interface RunLogResetInfo {
  projectDir: string;
  startedAt: number;
  source: 'local' | 'chat';
}

const RUN_STARTING_TTL_MS = 5 * 60_000;

class RunController extends EventEmitter {
  private active: Map<string, RunHandle> = new Map();
  private recentLogs: Map<string, string[]> = new Map();
  private starting: Map<string, RunStartingInfo> = new Map();
  // Projects whose runner has been SIGTERM'd but hasn't exited yet. Used
  // so the UI can flip Stop → "Stopping…" immediately on click, instead
  // of waiting up to 5 s for the runner to finish cleanup.
  private stopping: Set<string> = new Set();

  // Local UI-spawned run only. Use activeRunInfo()/isProjectRunning() when the
  // caller also wants chat/debugger-launched `art run` processes.
  isRunning(projectDir: string): boolean {
    return this.active.has(projectDir);
  }

  isStopping(projectDir: string): boolean {
    return this.stopping.has(projectDir);
  }

  isProjectRunning(projectDir: string, latestRun?: RunManifest | null): boolean {
    return this.activeRunInfo(projectDir, latestRun) !== null;
  }

  activeRunInfo(projectDir: string, latestRun?: RunManifest | null): ActiveRunInfo | null {
    const local = this.active.get(projectDir);
    if (local?.proc.pid) {
      this.starting.delete(projectDir);
      const matchingManifest =
        latestRun?.status === 'running' && latestRun.pid === local.proc.pid
          ? latestRun
          : null;
      return {
        projectDir,
        pid: local.proc.pid,
        startedAt: local.startedAt,
        startTime: matchingManifest?.startTime,
        runId: matchingManifest?.runId,
        source: 'local',
      };
    }

    const external = this.findLiveRunningManifest(projectDir, latestRun);
    if (!external) return null;
    this.starting.delete(projectDir);
    const startedAt = Date.parse(external.startTime);
    return {
      projectDir,
      pid: external.pid,
      startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
      startTime: external.startTime,
      runId: external.runId,
      source: 'external',
    };
  }

  // Detect a stale on-disk "running" manifest with a live PID belonging to another process.
  hasExternalActiveRun(projectDir: string): boolean {
    return this.findLiveRunningManifest(projectDir) !== null;
  }

  markExternalRunStarting(projectDir: string): RunStartingInfo {
    const startedAt = Date.now();
    const info: RunStartingInfo = {
      projectDir,
      startedAt,
      source: 'chat',
    };
    this.starting.set(projectDir, info);
    this.emit('log-reset', { projectDir, startedAt, source: 'chat' } satisfies RunLogResetInfo);
    this.emit('starting', info);
    return info;
  }

  runStartingInfo(projectDir: string): RunStartingInfo | null {
    const info = this.starting.get(projectDir);
    if (!info) return null;

    if (Date.now() - info.startedAt > RUN_STARTING_TTL_MS) {
      this.starting.delete(projectDir);
      return null;
    }

    return info;
  }

  start(
    projectDir: string,
    opts?: {
      skipPreflight?: boolean;
      authWarning?: string;
      model?: string;
    },
  ): { ok: true; pid: number } | { ok: false; status: number; reason: string } {
    if (this.isRunning(projectDir)) {
      return { ok: false, status: 409, reason: 'A run is already in progress for this project.' };
    }
    if (this.hasExternalActiveRun(projectDir)) {
      return {
        ok: false,
        status: 409,
        reason: 'Another `art run` process is active for this project (external to this UI).',
      };
    }

    const args = [
      'run',
      ...(opts?.skipPreflight ? ['--skip-preflight'] : []),
      ...(opts?.model ? ['--model', opts.model] : []),
      projectDir,
    ];
    const log: string[] = [];
    this.recentLogs.set(projectDir, log);
    const startedAt = Date.now();
    this.emit('log-reset', { projectDir, startedAt, source: 'local' } satisfies RunLogResetInfo);

    const pushLine = (kind: 'stdout' | 'stderr', line: string) => {
      const cleanLine = stripAnsi(line);
      log.push(`[${kind}] ${cleanLine}`);
      if (log.length > 2000) log.splice(0, log.length - 2000);
      this.emit('log', { projectDir, kind, line: cleanLine });
    };

    pushLine('stdout', `$ ${ART_BIN} ${args.map((arg) => JSON.stringify(arg)).join(' ')}`);
    if (opts?.authWarning) pushLine('stderr', opts.authWarning);

    const proc = spawn(ART_BIN, args, {
      cwd: projectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: artRunEnv(),
    });

    const handle: RunHandle = {
      projectDir,
      proc,
      startedAt,
      log,
    };
    this.active.set(projectDir, handle);
    this.emit('start', { projectDir, pid: proc.pid!, startedAt: handle.startedAt });

    let stdoutBuf = '';
    let stderrBuf = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
        pushLine('stdout', stdoutBuf.slice(0, idx));
        stdoutBuf = stdoutBuf.slice(idx + 1);
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      let idx;
      while ((idx = stderrBuf.indexOf('\n')) !== -1) {
        pushLine('stderr', stderrBuf.slice(0, idx));
        stderrBuf = stderrBuf.slice(idx + 1);
      }
    });

    proc.on('exit', (code, signal) => {
      if (stdoutBuf) pushLine('stdout', stdoutBuf);
      if (stderrBuf) pushLine('stderr', stderrBuf);
      this.active.delete(projectDir);
      pushLine('stdout', `--- run finished (code=${code ?? 'null'}, signal=${signal ?? 'null'}) ---`);
      this.emit('exit', { projectDir, code, signal });
    });
    proc.on('error', (err) => {
      pushLine('stderr', `[run-controller] spawn error: ${err.message}`);
      this.active.delete(projectDir);
      this.emit('exit', { projectDir, code: null, signal: null });
    });

    return { ok: true, pid: proc.pid! };
  }

  async stop(projectDir: string): Promise<{ ok: boolean; reason?: string }> {
    const handle = this.active.get(projectDir);
    if (!handle) {
      const external = this.findLiveRunningManifest(projectDir);
      if (!external) return { ok: false, reason: 'No active run.' };
      this.markStopping(projectDir);
      try {
        process.kill(external.pid, 'SIGTERM');
        const exited = await waitForPidExit(external.pid, 5000);
        if (!exited) cleanupDockerContainers();
        return { ok: true };
      } finally {
        this.clearStopping(projectDir);
      }
    }

    this.markStopping(projectDir);
    try {
      handle.proc.kill('SIGTERM');

      // Wait up to 5s for clean exit.
      const exited = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 5000);
        handle.proc.once('exit', () => {
          clearTimeout(t);
          resolve(true);
        });
      });

      // Best-effort container cleanup if SIGTERM didn't finish in time.
      if (!exited) cleanupDockerContainers();
      return { ok: true };
    } finally {
      this.clearStopping(projectDir);
    }
  }

  private markStopping(projectDir: string): void {
    if (this.stopping.has(projectDir)) return;
    this.stopping.add(projectDir);
    // Emit so the SSE layer can push a fresh snapshot immediately —
    // otherwise the UI doesn't flip to "Stopping…" until the runner
    // finishes cleanup (which is exactly when the user is waiting for
    // feedback).
    this.emit('stopping', { projectDir });
  }

  private clearStopping(projectDir: string): void {
    this.stopping.delete(projectDir);
  }

  log(projectDir: string): string[] {
    return this.active.get(projectDir)?.log ?? this.recentLogs.get(projectDir) ?? [];
  }

  private readRunManifests(projectDir: string): RunManifest[] {
    const runsDir = path.join(projectDir, ART_DIR_NAME, '.state', 'runs');
    if (!fs.existsSync(runsDir)) return [];
    return fs
      .readdirSync(runsDir)
      .filter((entry) => {
        if (!entry.startsWith('run-')) return false;
        try {
          return fs.statSync(path.join(runsDir, entry)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort()
      .reverse()
      .map((entry) => this.runFolderToManifest(runsDir, entry))
      .filter((manifest): manifest is RunManifest => manifest !== null);
  }

  // Synthesize a legacy-shape RunManifest from a runs/<id>/ folder. status is
  // derived: sealed marker + summary.outcome -> success/error; no sealed +
  // PID alive on this host -> running; no sealed + PID dead -> cancelled
  // (closest legacy label for crashed). Stages array is left empty because
  // the new layout records progress in events.jsonl, not in the manifest.
  private runFolderToManifest(
    runsDir: string,
    runId: string,
  ): RunManifest | null {
    const dir = path.join(runsDir, runId);
    let runJson: {
      pid?: number;
      hostname?: string;
      startTime?: string;
    } | null = null;
    try {
      runJson = JSON.parse(
        fs.readFileSync(path.join(dir, 'run.json'), 'utf8'),
      );
    } catch {
      return null;
    }
    const sealed = fs.existsSync(path.join(dir, 'sealed'));
    let status: RunManifest['status'];
    let endTime: string | undefined;
    if (sealed) {
      let outcome: 'success' | 'error' = 'success';
      try {
        const summary = JSON.parse(
          fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'),
        );
        if (summary.outcome === 'error') outcome = 'error';
        if (typeof summary.endTime === 'string') endTime = summary.endTime;
      } catch {
        // sealed but no readable summary; treat as success for legacy clients
      }
      status = outcome;
    } else if (
      typeof runJson?.pid === 'number' &&
      runJson.pid > 0 &&
      (!runJson.hostname || runJson.hostname === os.hostname()) &&
      isPidAlive(runJson.pid)
    ) {
      status = 'running';
    } else {
      status = 'cancelled';
    }
    return {
      runId,
      pid: typeof runJson?.pid === 'number' ? runJson.pid : 0,
      startTime: runJson?.startTime ?? '',
      endTime,
      status,
      stages: [],
    };
  }

  private findLiveRunningManifest(
    projectDir: string,
    preferred?: RunManifest | null,
  ): RunManifest | null {
    const candidates: RunManifest[] = [];
    const seen = new Set<string>();
    const add = (manifest: RunManifest | null | undefined) => {
      if (!manifest || seen.has(manifest.runId)) return;
      candidates.push(manifest);
      seen.add(manifest.runId);
    };

    add(preferred);
    for (const manifest of this.readRunManifests(projectDir)) add(manifest);

    const localPid = this.active.get(projectDir)?.proc.pid;
    for (const manifest of candidates) {
      if (manifest.status !== 'running' || !manifest.pid) continue;
      if (localPid && manifest.pid === localPid) continue;
      if (isPidAlive(manifest.pid)) return manifest;
    }
    return null;
  }
}

export const runController = new RunController();

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}


async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isPidAlive(pid);
}

function cleanupDockerContainers(): void {
  try {
    const ps = spawnSync('docker', ['ps', '-q', '--filter', 'name=aer-art-'], { encoding: 'utf8' });
    const ids = ps.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    for (const id of ids) spawnSync('docker', ['rm', '-f', id]);
  } catch {
    // ignore — docker may not be installed (podman / udocker fallback skipped for v1)
  }
}

function artRunEnv(): NodeJS.ProcessEnv {
  const env = childProcessEnv();
  const loggerPreload = path.join(APP_ROOT, '..', 'dist', 'logger.js');
  if (!fs.existsSync(loggerPreload)) return env;

  const preloadOption = `--import=${loggerPreload}`;
  const existing = env.NODE_OPTIONS?.trim();
  if (existing?.includes(preloadOption)) return env;
  return {
    ...env,
    NODE_OPTIONS: existing ? `${existing} ${preloadOption}` : preloadOption,
  };
}
