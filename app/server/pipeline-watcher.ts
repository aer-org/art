import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import chokidar, { type FSWatcher } from 'chokidar';

import { ART_DIR_NAME } from './config.ts';
import {
  buildNodeLogContext,
  findLatestPipelineLogFile,
  parseNodeLogLine,
} from './node-log.ts';
import { runController } from './run-controller.ts';
import type { NodeLogLine, PipelineConfig, PipelineState, RunManifest } from './types.ts';

export interface WatchedSnapshot {
  pipeline: PipelineConfig | null;
  state: PipelineState | null;
  latestRun: RunManifest | null;
  pipelineLogTail: string[];
  pipelineError?: string;
}

function safeParseJson<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function listLatestRun(runsDir: string): RunManifest | null {
  if (!fs.existsSync(runsDir)) return null;
  const files = fs
    .readdirSync(runsDir)
    .filter((f) => f.startsWith('run-') && f.endsWith('.json'))
    .sort()
    .reverse();
  for (const f of files) {
    const m = safeParseJson<RunManifest>(path.join(runsDir, f));
    if (m) return m;
  }
  return null;
}

function latestRunManifestPath(runsDir: string): string | null {
  if (!fs.existsSync(runsDir)) return null;
  const files = fs
    .readdirSync(runsDir)
    .filter((f) => f.startsWith('run-') && f.endsWith('.json'))
    .sort()
    .reverse();
  return files[0] ? path.join(runsDir, files[0]) : null;
}

function listPipelineStateFiles(stateDir: string): string[] {
  if (!fs.existsSync(stateDir)) return [];
  return fs
    .readdirSync(stateDir)
    .filter((f) => f.startsWith('PIPELINE_STATE') && f.endsWith('.json'))
    .map((f) => path.join(stateDir, f));
}

function tailFile(filePath: string, maxLines = 500): string[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n');
    return lines.slice(Math.max(0, lines.length - maxLines));
  } catch {
    return [];
  }
}

export class PipelineProject extends EventEmitter {
  readonly projectDir: string;
  readonly artDir: string;
  readonly stateDir: string;
  private watcher: FSWatcher | null = null;
  private snapshot: WatchedSnapshot;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private lastMtimes: Map<string, number> = new Map();
  private tailFile: string | null = null;
  private tailOffset = 0;
  private tailBuffer = '';
  private tailPollInterval: NodeJS.Timeout | null = null;

  constructor(projectDir: string) {
    super();
    this.projectDir = projectDir;
    this.artDir = path.join(projectDir, ART_DIR_NAME);
    this.stateDir = path.join(this.artDir, '.state');
    this.snapshot = this.read();
    // Start the tail at end-of-file for whatever is current; we don't replay
    // historical pipeline logs as live events.
    this.initTailToCurrentEnd();
  }

  start(): void {
    this.watcher = chokidar.watch(
      [
        path.join(this.artDir, 'PIPELINE.json'),
        this.stateDir,
        path.join(this.stateDir, 'PIPELINE_STATE*.json'),
        path.join(this.stateDir, 'runs'),
        path.join(this.stateDir, 'runs', 'run-*.json'),
        path.join(this.stateDir, 'logs'),
        path.join(this.stateDir, 'logs', '**', 'pipeline-*.log'),
      ],
      {
        ignored: (p: string) => p.endsWith('.tmp'),
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
      },
    );
    this.watcher.on('all', () => {
      this.scheduleRefresh();
      this.tailLatestPipelineLog();
    });
    this.watcher.on('error', (err) => this.handleWatcherError(err));

    // Polling fallback for filesystems where inotify is flaky (NFS, SSHFS).
    // Keep it fairly tight: only one project is loaded, and run-state files are tiny.
    this.pollInterval = setInterval(() => this.pollOnce(), 500);
    // Independent tail poll so log lines don't wait for state changes.
    this.tailPollInterval = setInterval(() => this.tailLatestPipelineLog(), 500);
  }

  private latestPipelineLogPath(): string | null {
    const logsDir = path.join(this.stateDir, 'logs');
    return findLatestPipelineLogFile(logsDir);
  }

  private initTailToCurrentEnd(): void {
    const latest = this.latestPipelineLogPath();
    if (!latest) return;
    try {
      const size = fs.statSync(latest).size;
      this.tailFile = latest;
      this.tailOffset = size;
    } catch {
      // ignore
    }
  }

  private tailLatestPipelineLog(): void {
    const latest = this.latestPipelineLogPath();
    if (!latest) return;
    if (this.tailFile !== latest) {
      // Switched to a new pipeline log (a new run started). Read from byte 0
      // so the user sees the start of the new run.
      this.tailFile = latest;
      this.tailOffset = 0;
      this.tailBuffer = '';
    }
    let size: number;
    try {
      size = fs.statSync(latest).size;
    } catch {
      return;
    }
    if (size <= this.tailOffset) return;

    const length = size - this.tailOffset;
    const buf = Buffer.alloc(length);
    let fd: number | null = null;
    try {
      fd = fs.openSync(latest, 'r');
      fs.readSync(fd, buf, 0, length, this.tailOffset);
    } catch {
      if (fd != null) try { fs.closeSync(fd); } catch { /* ignore */ }
      return;
    }
    fs.closeSync(fd);
    this.tailOffset = size;

    this.tailBuffer += buf.toString('utf8');
    const nodeLogContext = buildNodeLogContext(this.snapshot.pipeline, this.snapshot.state);
    const sourceFile = path.basename(latest);
    let idx;
    while ((idx = this.tailBuffer.indexOf('\n')) !== -1) {
      const line = this.tailBuffer.slice(0, idx);
      this.tailBuffer = this.tailBuffer.slice(idx + 1);
      if (line.length === 0) continue;
      const nodeLogLine = parseNodeLogLine(line, nodeLogContext, sourceFile);
      if (nodeLogLine) {
        this.emit('node-log-line', nodeLogLine satisfies NodeLogLine);
        continue;
      }
      const kind = /\b(error|err|stderr|fail)/i.test(line) ? 'stderr' : 'stdout';
      this.emit('log-line', { line, kind });
    }
  }

  async stop(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.tailPollInterval) clearInterval(this.tailPollInterval);
    await this.watcher?.close();
    this.watcher = null;
  }

  current(): WatchedSnapshot {
    return this.snapshot;
  }

  refreshNow(emit = true): WatchedSnapshot {
    const next = this.read();
    this.snapshot = next;
    if (emit) this.emit('snapshot', next);
    return next;
  }

  private scheduleRefresh(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.refresh(), 100);
  }

  private pollOnce(): void {
    let changed = false;
    const runsDir = path.join(this.stateDir, 'runs');
    const logsDir = path.join(this.stateDir, 'logs');
    const candidates = [
      this.artDir,
      this.stateDir,
      path.join(this.artDir, 'PIPELINE.json'),
      ...listPipelineStateFiles(this.stateDir),
      runsDir,
      latestRunManifestPath(runsDir),
      logsDir,
      this.latestPipelineLogPath(),
    ];
    for (const f of candidates) {
      if (!f) continue;
      try {
        const m = fs.statSync(f).mtimeMs;
        if (this.lastMtimes.get(f) !== m) {
          this.lastMtimes.set(f, m);
          changed = true;
        }
      } catch {
        // file may not exist yet — skip
      }
    }
    const activeRun = runController.activeRunInfo(this.projectDir, this.snapshot.latestRun);
    if (activeRun?.runId && this.snapshot.latestRun?.runId !== activeRun.runId) {
      changed = true;
    }
    if (changed) this.scheduleRefresh();
  }

  private handleWatcherError(err: Error): void {
    const code = (err as NodeJS.ErrnoException).code;
    this.emit('watch-error', {
      message: err.message,
      code,
    });

    // The polling loop is always active; closing the native watcher prevents
    // repeated EMFILE/inotify errors from taking down the backend.
    const watcher = this.watcher;
    this.watcher = null;
    void watcher?.close().catch(() => {});
  }

  private refresh(): void {
    this.refreshNow();
  }

  private read(): WatchedSnapshot {
    const pipelinePath = path.join(this.artDir, 'PIPELINE.json');
    const statePath = path.join(this.stateDir, 'PIPELINE_STATE.json');
    const runsDir = path.join(this.stateDir, 'runs');
    const logsDir = path.join(this.stateDir, 'logs');

    let pipeline: PipelineConfig | null = null;
    let pipelineError: string | undefined;
    try {
      const raw = fs.readFileSync(pipelinePath, 'utf8');
      pipeline = JSON.parse(raw) as PipelineConfig;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') pipelineError = 'PIPELINE.json not found';
      else pipelineError = `Could not parse PIPELINE.json: ${(e as Error).message}`;
    }

    const state = safeParseJson<PipelineState>(statePath);
    const latestRun = listLatestRun(runsDir);
    const logFile = findLatestPipelineLogFile(logsDir);
    const pipelineLogTail = logFile ? tailFile(logFile, 500) : [];

    return { pipeline, state, latestRun, pipelineLogTail, pipelineError };
  }
}
