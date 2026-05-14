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
import crypto, { createHash } from 'crypto';

/**
 * Schema version for run.json / summary.json / events.jsonl records. Bump on
 * incompatible shape change; readers should refuse unknown versions.
 */
export const RECORDER_SCHEMA_VERSION = 1;

/**
 * Env vars whose presence/value is safe to record in provenance. Anything
 * outside this list is omitted because it might carry secrets (API keys,
 * OAuth tokens, etc). When you add a new ART_* setting that affects
 * behavior, add it here so it appears in the run record.
 */
const PROVENANCE_ENV_PREFIXES = ['ART_'];
const PROVENANCE_ENV_ALLOW = new Set([
  'LOG_LEVEL',
  'CI',
  'CONTAINER_IMAGE',
  'CONTAINER_TIMEOUT',
  'CONTAINER_MAX_OUTPUT_SIZE',
  'IDLE_TIMEOUT',
  'TZ',
]);
const PROVENANCE_ENV_DENY = new Set([
  // Even ART_* fields that look like secrets stay out.
  'ART_OAUTH_TOKEN',
  '_ART_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
]);

export interface RunInitInfo {
  schemaVersion: number;
  pid: number;
  hostname: string;
  startTime: string;
  provider?: 'codex' | 'claude';
  args?: string[];
}

export interface RunSummary {
  schemaVersion: number;
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
  schemaVersion: number;
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
    init: Omit<RunInitInfo, 'schemaVersion' | 'pid' | 'hostname' | 'startTime'>;
  }): RunRecorder {
    const runId = opts.runId ?? generateRunId();
    const runDir = path.join(opts.stateDir, 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(path.join(runDir, 'state'), { recursive: true });

    const initJson: RunInitInfo = {
      schemaVersion: RECORDER_SCHEMA_VERSION,
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

  /**
   * Path to a stage's per-stage folder under runs/<id>/nodes/<n>/stages/<s>/.
   * Creates the folder if it doesn't exist. With `filename`, joins it on
   * the result. nodeId === undefined refers to the root dispatch node.
   */
  stagePath(
    nodeId: string | undefined,
    stageName: string,
    filename?: string,
  ): string {
    const node = nodeId ?? 'root';
    const base = path.join(this.runDir, 'nodes', node, 'stages', stageName);
    try {
      fs.mkdirSync(base, { recursive: true });
    } catch {
      // best-effort; subsequent writes will surface real failures
    }
    return filename ? path.join(base, filename) : base;
  }

  /** Append one event to events.jsonl. Best-effort (telemetry loss < run integrity). */
  event(input: RecorderEventInput): void {
    if (this.finalized) return;
    const record: RecorderEvent = {
      schemaVersion: RECORDER_SCHEMA_VERSION,
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

  /**
   * Snapshot PIPELINE.json verbatim at run start so a later reader sees the
   * exact authored config even if the on-disk file was edited afterwards.
   * Best-effort.
   */
  snapshotPipeline(pipelinePath: string): void {
    try {
      if (!fs.existsSync(pipelinePath)) return;
      const content = fs.readFileSync(pipelinePath);
      fs.writeFileSync(path.join(this.runDir, 'pipeline.snap.json'), content);
    } catch (err) {
      console.error(
        `[recorder] failed to snapshot PIPELINE.json: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Write provenance.json: sha256 of every file under `agents/` and
   * `templates/` in the bundle, plus an env-var whitelist. Lets a future
   * reader verify "the agents/foo.md on disk today matches what this run
   * loaded" without re-running.
   */
  captureRunProvenance(bundleDir: string): void {
    const hashFilesIn = (
      sub: string,
      ext: string,
    ): Array<{ path: string; sha256: string; bytes: number }> => {
      const dir = path.join(bundleDir, sub);
      if (!fs.existsSync(dir)) return [];
      const out: Array<{ path: string; sha256: string; bytes: number }> = [];
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        return [];
      }
      for (const entry of entries) {
        if (!entry.endsWith(ext)) continue;
        const fp = path.join(dir, entry);
        try {
          const buf = fs.readFileSync(fp);
          out.push({
            path: `${sub}/${entry}`,
            sha256: createHash('sha256').update(buf).digest('hex'),
            bytes: buf.length,
          });
        } catch {
          // skip unreadable
        }
      }
      return out;
    };

    const envSnapshot: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v !== 'string') continue;
      if (PROVENANCE_ENV_DENY.has(k)) continue;
      const isPrefixed = PROVENANCE_ENV_PREFIXES.some((p) => k.startsWith(p));
      const isAllowed = PROVENANCE_ENV_ALLOW.has(k);
      if (!isPrefixed && !isAllowed) continue;
      envSnapshot[k] = v;
    }

    const record = {
      schemaVersion: RECORDER_SCHEMA_VERSION,
      bundleDir,
      agents: hashFilesIn('agents', '.md'),
      templates: hashFilesIn('templates', '.json'),
      env: envSnapshot,
    };
    try {
      atomicWrite(
        path.join(this.runDir, 'provenance.json'),
        JSON.stringify(record, null, 2),
      );
    } catch (err) {
      console.error(
        `[recorder] failed to write provenance.json: ${(err as Error).message}`,
      );
    }
  }

  /** Write summary.json + sealed marker. Idempotent. */
  finalize(summary: Omit<RunSummary, 'schemaVersion'>): void {
    if (this.finalized) return;
    this.finalized = true;
    const out: RunSummary = {
      schemaVersion: RECORDER_SCHEMA_VERSION,
      ...summary,
    };
    try {
      atomicWrite(
        path.join(this.runDir, 'summary.json'),
        JSON.stringify(out, null, 2),
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
