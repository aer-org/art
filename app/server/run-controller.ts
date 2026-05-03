import fs from 'node:fs';
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

  // Local UI-spawned run only. Use activeRunInfo()/isProjectRunning() when the
  // caller also wants chat/debugger-launched `art run` processes.
  isRunning(projectDir: string): boolean {
    return this.active.has(projectDir);
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
    opts?: { skipPreflight?: boolean; authWarning?: string },
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

    const args = ['run', ...(opts?.skipPreflight ? ['--skip-preflight'] : []), projectDir];
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
      process.kill(external.pid, 'SIGTERM');
      const exited = await waitForPidExit(external.pid, 5000);
      if (!exited) cleanupDockerContainers();
      return { ok: true };
    }

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
  }

  log(projectDir: string): string[] {
    return this.active.get(projectDir)?.log ?? this.recentLogs.get(projectDir) ?? [];
  }

  private readRunManifests(projectDir: string): RunManifest[] {
    const runsDir = path.join(projectDir, ART_DIR_NAME, '.state', 'runs');
    if (!fs.existsSync(runsDir)) return [];
    return fs
      .readdirSync(runsDir)
      .filter((f) => f.startsWith('run-') && f.endsWith('.json'))
      .sort()
      .reverse()
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8')) as RunManifest;
        } catch {
          return null;
        }
      })
      .filter((manifest): manifest is RunManifest => manifest !== null);
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
