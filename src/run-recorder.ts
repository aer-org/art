/**
 * RunRecorder — owns one runs/<runId>/ directory and all persistent writes
 * into it. Created once per `art run` invocation; stitched child PipelineRunner
 * instances share the parent's recorder (they only change their nodeId scope).
 *
 * Write-failure policy is criticality-tiered:
 * - Run dir / run.json: throws (cannot proceed without these)
 * - State files (under state/): savePipelineState's atomic write; throws on failure
 * - events.jsonl appends: best-effort, console.error on failure, continue
 * - summary.json + sealed at finalize: best-effort
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

export interface RunInitInfo {
  pid: number;
  hostname: string;
  startTime: string;
  provider?: 'codex' | 'claude';
  image?: string;
  args?: string[];
}

export interface RunSummary {
  outcome: 'success' | 'error';
  endTime: string;
  durationMs: number;
  totalStages: number;
  failedStages: number;
}

export type EventLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RecorderEventInput {
  level: EventLevel;
  type: string;
  scopeId?: string;
  nodeId?: string;
  stageName?: string;
  message?: string;
  data?: unknown;
}

export interface RecorderEvent extends RecorderEventInput {
  time: string;
}

/** Generate a sortable, mostly-unique runId. */
export function generateRunId(): string {
  return `run-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

export class RunRecorder {
  readonly runId: string;
  readonly runDir: string;
  private readonly eventsPath: string;
  private finalized = false;

  private constructor(runId: string, runDir: string) {
    this.runId = runId;
    this.runDir = runDir;
    this.eventsPath = path.join(runDir, 'events.jsonl');
  }

  static create(opts: {
    stateDir: string;
    runId?: string;
    init: Omit<RunInitInfo, 'pid' | 'hostname' | 'startTime'>;
  }): RunRecorder {
    const runId = opts.runId ?? generateRunId();
    const runDir = path.join(opts.stateDir, 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(path.join(runDir, 'state'), { recursive: true });

    const initJson: RunInitInfo = {
      pid: process.pid,
      hostname: os.hostname(),
      startTime: new Date().toISOString(),
      ...opts.init,
    };
    atomicWrite(
      path.join(runDir, 'run.json'),
      JSON.stringify(initJson, null, 2),
    );

    return new RunRecorder(runId, runDir);
  }

  /** Reattach to an existing run dir (resume). Returns null if not found. */
  static reattach(stateDir: string, runId: string): RunRecorder | null {
    const runDir = path.join(stateDir, 'runs', runId);
    if (!fs.existsSync(runDir)) return null;
    return new RunRecorder(runId, runDir);
  }

  /** Path to the run-local state dir (PIPELINE_STATE.json lives here). */
  stateDir(): string {
    return path.join(this.runDir, 'state');
  }

  /** Append one event to events.jsonl. Best-effort (telemetry loss < run integrity). */
  event(input: RecorderEventInput): void {
    if (this.finalized) return;
    const record: RecorderEvent = {
      time: new Date().toISOString(),
      ...input,
    };
    try {
      fs.appendFileSync(this.eventsPath, JSON.stringify(record) + '\n');
    } catch (err) {
      console.error(
        `[recorder] failed to write event: ${(err as Error).message}`,
      );
    }
  }

  /** Write summary.json + sealed marker. Idempotent. */
  finalize(summary: RunSummary): void {
    if (this.finalized) return;
    this.finalized = true;
    try {
      atomicWrite(
        path.join(this.runDir, 'summary.json'),
        JSON.stringify(summary, null, 2),
      );
    } catch (err) {
      console.error(
        `[recorder] failed to write summary.json: ${(err as Error).message}`,
      );
    }
    try {
      fs.writeFileSync(path.join(this.runDir, 'sealed'), '');
    } catch (err) {
      console.error(
        `[recorder] failed to write sealed marker: ${(err as Error).message}`,
      );
    }
  }

  isFinalized(): boolean {
    return this.finalized;
  }
}

function atomicWrite(filepath: string, content: string): void {
  const tmp = `${filepath}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filepath);
}

// -- Process-global recorder hook --
//
// Most legacy `logger.*` call sites do not have a recorder reference handy.
// The new logger.ts forwards events through this hook; runtime sets it when
// a run starts and clears it at finalize. If unset, events are dropped.
let _activeRecorder: RunRecorder | null = null;

export function setActiveRecorder(recorder: RunRecorder | null): void {
  _activeRecorder = recorder;
}

export function getActiveRecorder(): RunRecorder | null {
  return _activeRecorder;
}
