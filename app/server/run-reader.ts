/**
 * File-system helpers for the transparency-layer visualizer.
 *
 * Mirrors `src/run-registry.ts` for the package boundary — `app/` does not
 * import from the parent `src/`. Adds richer per-run / per-stage readers
 * that the visualizer routes need:
 *   - run list with derived state (live / crashed / sealed)
 *   - run detail (run.json + summary.json + sealed marker + node tree)
 *   - per-stage record (stage.json + container.json + file inventory)
 *   - raw file readers (prompt.txt, initial.txt, command.sh/json,
 *     substitutions.json, diff/<mount>.diff, turns/NNN.json)
 *   - run-wide files (provenance.json, pipeline.snap.json)
 *
 * All reads are best-effort: missing files and malformed JSON return null
 * or [] so the UI can degrade gracefully across feature flags + transitional
 * runtime versions.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ART_DIR_NAME } from './config.ts';

export type RunState = 'live' | 'crashed' | 'sealed';

export interface RunHeader {
  runId: string;
  state: RunState;
  pid?: number;
  hostname?: string;
  startTime?: string;
  provider?: string;
  // Light summary so the list page doesn't need a second fetch per row.
  outcome?: 'success' | 'error';
  endTime?: string;
  durationMs?: number;
  totalStages?: number;
  failedStages?: number;
}

export interface RunDetail extends RunHeader {
  runDir: string;
  args?: string[];
  schemaVersion?: number;
  hasProvenance: boolean;
  hasPipelineSnap: boolean;
  hasEvents: boolean;
  nodes: NodeIndex[];
}

export interface NodeIndex {
  nodeId: string;
  stages: string[];
}

export interface StageDetail {
  nodeId: string;
  stageName: string;
  stage: Record<string, unknown> | null; // stage.json contents
  container: Record<string, unknown> | null; // container.json contents
  substitutions: Record<string, unknown> | null;
  promptSource: string | null;
  hasPrompt: boolean;
  hasInitial: boolean;
  hasCommand: boolean;
  hasDiff: boolean;
  diffMounts: string[];
  turnCount: number;
  streamSizes: { agent: number; stdout: number; stderr: number };
}

function runsRoot(projectDir: string): string {
  return path.join(projectDir, ART_DIR_NAME, '.state', 'runs');
}

function runDirOf(projectDir: string, runId: string): string {
  return path.join(runsRoot(projectDir), runId);
}

function readJson<T = Record<string, unknown>>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function classifyRunDir(runDir: string): {
  state: RunState;
  meta: Record<string, unknown> | null;
} {
  const sealed = fs.existsSync(path.join(runDir, 'sealed'));
  const meta = readJson(path.join(runDir, 'run.json'));
  if (sealed) return { state: 'sealed', meta };
  if (!meta || typeof meta.pid !== 'number' || meta.pid <= 0) {
    return { state: 'crashed', meta };
  }
  const sameHost = !meta.hostname || meta.hostname === os.hostname();
  const live = sameHost && isPidAlive(meta.pid as number);
  return { state: live ? 'live' : 'crashed', meta };
}

function headerFor(projectDir: string, runId: string): RunHeader {
  const dir = runDirOf(projectDir, runId);
  const { state, meta } = classifyRunDir(dir);
  const summary = readJson(path.join(dir, 'summary.json'));
  const header: RunHeader = { runId, state };
  if (meta) {
    if (typeof meta.pid === 'number') header.pid = meta.pid;
    if (typeof meta.hostname === 'string') header.hostname = meta.hostname;
    if (typeof meta.startTime === 'string')
      header.startTime = meta.startTime;
    if (typeof meta.provider === 'string') header.provider = meta.provider;
  }
  if (summary) {
    if (summary.outcome === 'success' || summary.outcome === 'error') {
      header.outcome = summary.outcome;
    }
    if (typeof summary.endTime === 'string') header.endTime = summary.endTime;
    if (typeof summary.durationMs === 'number')
      header.durationMs = summary.durationMs;
    if (typeof summary.totalStages === 'number')
      header.totalStages = summary.totalStages;
    if (typeof summary.failedStages === 'number')
      header.failedStages = summary.failedStages;
  }
  return header;
}

export function listRuns(projectDir: string): RunHeader[] {
  const root = runsRoot(projectDir);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((entry) => {
      if (!entry.startsWith('run-')) return false;
      try {
        return fs.statSync(path.join(root, entry)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .reverse()
    .map((entry) => headerFor(projectDir, entry));
}

export function getRun(
  projectDir: string,
  runId: string,
): RunDetail | null {
  const dir = runDirOf(projectDir, runId);
  if (!fs.existsSync(dir)) return null;
  const header = headerFor(projectDir, runId);
  const runJson = readJson(path.join(dir, 'run.json'));
  const detail: RunDetail = {
    ...header,
    runDir: dir,
    hasProvenance: fs.existsSync(path.join(dir, 'provenance.json')),
    hasPipelineSnap: fs.existsSync(path.join(dir, 'pipeline.snap.json')),
    hasEvents: fs.existsSync(path.join(dir, 'events.jsonl')),
    nodes: listNodes(dir),
  };
  if (runJson) {
    if (Array.isArray(runJson.args)) detail.args = runJson.args as string[];
    if (typeof runJson.schemaVersion === 'number') {
      detail.schemaVersion = runJson.schemaVersion;
    }
  }
  return detail;
}

function listNodes(runDir: string): NodeIndex[] {
  const nodesDir = path.join(runDir, 'nodes');
  if (!fs.existsSync(nodesDir)) return [];
  const out: NodeIndex[] = [];
  for (const node of fs.readdirSync(nodesDir)) {
    const stagesDir = path.join(nodesDir, node, 'stages');
    if (!fs.existsSync(stagesDir)) continue;
    const stages: string[] = [];
    try {
      for (const stage of fs.readdirSync(stagesDir)) {
        if (fs.statSync(path.join(stagesDir, stage)).isDirectory()) {
          stages.push(stage);
        }
      }
    } catch {
      continue;
    }
    out.push({ nodeId: node, stages: stages.sort() });
  }
  return out.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
}

export interface ReadEventsOpts {
  type?: string; // exact match or prefix (e.g. "decision.")
  limit?: number; // default 5000
  stageName?: string;
  nodeId?: string;
}

export function readEvents(
  projectDir: string,
  runId: string,
  opts: ReadEventsOpts = {},
): Array<Record<string, unknown>> {
  const fp = path.join(runDirOf(projectDir, runId), 'events.jsonl');
  if (!fs.existsSync(fp)) return [];
  const limit = opts.limit ?? 5000;
  let raw: string;
  try {
    raw = fs.readFileSync(fp, 'utf-8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter((l) => l.length > 0);
  const out: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (opts.type) {
      const t = typeof ev.type === 'string' ? ev.type : '';
      const match = opts.type.endsWith('.')
        ? t.startsWith(opts.type)
        : t === opts.type;
      if (!match) continue;
    }
    if (opts.stageName && ev.stageName !== opts.stageName) continue;
    if (opts.nodeId && ev.nodeId !== opts.nodeId) continue;
    out.push(ev);
    if (out.length >= limit) break;
  }
  return out;
}

function stageDirOf(
  projectDir: string,
  runId: string,
  nodeId: string,
  stageName: string,
): string {
  return path.join(
    runDirOf(projectDir, runId),
    'nodes',
    nodeId,
    'stages',
    stageName,
  );
}

function safeStat(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

export function getStage(
  projectDir: string,
  runId: string,
  nodeId: string,
  stageName: string,
): StageDetail | null {
  const dir = stageDirOf(projectDir, runId, nodeId, stageName);
  if (!fs.existsSync(dir)) return null;
  const diffDir = path.join(dir, 'diff');
  const diffMounts: string[] = [];
  if (fs.existsSync(diffDir)) {
    for (const entry of fs.readdirSync(diffDir)) {
      if (entry.endsWith('.diff')) diffMounts.push(entry.replace(/\.diff$/, ''));
    }
  }
  const turnsDir = path.join(dir, 'turns');
  let turnCount = 0;
  if (fs.existsSync(turnsDir)) {
    turnCount = fs
      .readdirSync(turnsDir)
      .filter((f) => /^\d+\.json$/.test(f)).length;
  }
  let promptSource: string | null = null;
  try {
    promptSource = fs
      .readFileSync(path.join(dir, 'prompt.source'), 'utf-8')
      .trim();
  } catch {
    promptSource = null;
  }
  return {
    nodeId,
    stageName,
    stage: readJson(path.join(dir, 'stage.json')),
    container: readJson(path.join(dir, 'container.json')),
    substitutions: readJson(path.join(dir, 'substitutions.json')),
    promptSource,
    hasPrompt: fs.existsSync(path.join(dir, 'prompt.txt')),
    hasInitial: fs.existsSync(path.join(dir, 'initial.txt')),
    hasCommand: fs.existsSync(path.join(dir, 'command.sh')),
    hasDiff: diffMounts.length > 0,
    diffMounts: diffMounts.sort(),
    turnCount,
    streamSizes: {
      agent: safeStat(path.join(dir, 'agent.stream.log')),
      stdout: safeStat(path.join(dir, 'stdout.log')),
      stderr: safeStat(path.join(dir, 'stderr.log')),
    },
  };
}

export function readStageText(
  projectDir: string,
  runId: string,
  nodeId: string,
  stageName: string,
  filename: 'prompt.txt' | 'initial.txt' | 'command.sh',
): string | null {
  const fp = path.join(stageDirOf(projectDir, runId, nodeId, stageName), filename);
  try {
    return fs.readFileSync(fp, 'utf-8');
  } catch {
    return null;
  }
}

export function readStageCommand(
  projectDir: string,
  runId: string,
  nodeId: string,
  stageName: string,
): { sh: string | null; meta: Record<string, unknown> | null } {
  const dir = stageDirOf(projectDir, runId, nodeId, stageName);
  let sh: string | null = null;
  try {
    sh = fs.readFileSync(path.join(dir, 'command.sh'), 'utf-8');
  } catch {
    sh = null;
  }
  const meta = readJson(path.join(dir, 'command.json'));
  return { sh, meta };
}

export function readStageDiff(
  projectDir: string,
  runId: string,
  nodeId: string,
  stageName: string,
  mount: string,
): string | null {
  const fp = path.join(
    stageDirOf(projectDir, runId, nodeId, stageName),
    'diff',
    `${mount}.diff`,
  );
  try {
    return fs.readFileSync(fp, 'utf-8');
  } catch {
    return null;
  }
}

export function readStageDiffSummary(
  projectDir: string,
  runId: string,
  nodeId: string,
  stageName: string,
): Record<string, unknown> | null {
  return readJson(
    path.join(
      stageDirOf(projectDir, runId, nodeId, stageName),
      'diff',
      'summary.json',
    ),
  );
}

export function readStageTurns(
  projectDir: string,
  runId: string,
  nodeId: string,
  stageName: string,
): Array<Record<string, unknown>> {
  const dir = path.join(
    stageDirOf(projectDir, runId, nodeId, stageName),
    'turns',
  );
  if (!fs.existsSync(dir)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!/^\d+\.json$/.test(f)) continue;
    const data = readJson(path.join(dir, f));
    if (data) out.push(data);
  }
  return out;
}

export function readStageStream(
  projectDir: string,
  runId: string,
  nodeId: string,
  stageName: string,
  kind: 'agent' | 'stdout' | 'stderr',
  tail = 500,
): { lines: string[]; bytes: number } | null {
  const filename =
    kind === 'agent' ? 'agent.stream.log' : `${kind}.log`;
  const fp = path.join(
    stageDirOf(projectDir, runId, nodeId, stageName),
    filename,
  );
  if (!fs.existsSync(fp)) return null;
  try {
    const raw = fs.readFileSync(fp, 'utf-8');
    const all = raw.split('\n');
    return {
      lines: all.slice(Math.max(0, all.length - tail)),
      bytes: raw.length,
    };
  } catch {
    return null;
  }
}

export function readProvenance(
  projectDir: string,
  runId: string,
): Record<string, unknown> | null {
  return readJson(path.join(runDirOf(projectDir, runId), 'provenance.json'));
}

export function readPipelineSnap(
  projectDir: string,
  runId: string,
): Record<string, unknown> | null {
  return readJson(
    path.join(runDirOf(projectDir, runId), 'pipeline.snap.json'),
  );
}

/**
 * Build a map of `stageName -> { retryCount, exitCode, nodeId }` by walking
 * every nodes/<n>/stages/<s>/stage.json in the run. Used to augment the
 * graph nodes in the run-detail view with transparency-layer data.
 *
 * Multiple stitched lanes can map to the *same* stage name across nodes;
 * here we collapse to the first occurrence — the graph itself only renders
 * one node per stage name in the current materialization, so this matches
 * what the UI will draw.
 */
export function readStageSummaryMap(
  projectDir: string,
  runId: string,
): Map<
  string,
  { retryCount?: number; exitCode?: number | null; nodeId: string }
> {
  const result = new Map<
    string,
    { retryCount?: number; exitCode?: number | null; nodeId: string }
  >();
  const dir = path.join(runDirOf(projectDir, runId), 'nodes');
  if (!fs.existsSync(dir)) return result;
  for (const nodeId of fs.readdirSync(dir)) {
    const stagesDir = path.join(dir, nodeId, 'stages');
    if (!fs.existsSync(stagesDir)) continue;
    for (const stage of fs.readdirSync(stagesDir)) {
      if (result.has(stage)) continue;
      const rec = readJson(path.join(stagesDir, stage, 'stage.json'));
      if (!rec) continue;
      result.set(stage, {
        retryCount:
          typeof rec.retryCount === 'number' ? rec.retryCount : undefined,
        exitCode: rec.exitCode as number | null | undefined,
        nodeId,
      });
    }
  }
  return result;
}

export function readPipelineSnapConfig(
  projectDir: string,
  runId: string,
): Record<string, unknown> | null {
  return readJson(
    path.join(runDirOf(projectDir, runId), 'pipeline.snap.json'),
  );
}

export function readPipelineStateForRun(
  projectDir: string,
  runId: string,
): Record<string, unknown> | null {
  return readJson(
    path.join(
      runDirOf(projectDir, runId),
      'state',
      'PIPELINE_STATE.json',
    ),
  );
}

export interface AllStageRecord {
  nodeId: string;
  stageName: string;
  stage: Record<string, unknown> | null;
  turnCount: number;
  turnSum: {
    tokensIn: number;
    tokensOut: number;
    cacheReadTokens: number;
    latencyMs: number;
    costUsd: number;
  };
}

/**
 * Walk every nodes/<n>/stages/<s>/stage.json + sibling turns/ to build a
 * run-wide list for Timeline + Cost overlays. Single fast pass so the L4
 * overlays don't need N+1 stage fetches.
 */
export function readAllStageRecords(
  projectDir: string,
  runId: string,
): AllStageRecord[] {
  const out: AllStageRecord[] = [];
  const nodesDir = path.join(runDirOf(projectDir, runId), 'nodes');
  if (!fs.existsSync(nodesDir)) return out;
  for (const nodeId of fs.readdirSync(nodesDir)) {
    const stagesDir = path.join(nodesDir, nodeId, 'stages');
    if (!fs.existsSync(stagesDir)) continue;
    for (const stage of fs.readdirSync(stagesDir)) {
      const dir = path.join(stagesDir, stage);
      const rec = readJson(path.join(dir, 'stage.json'));
      // Aggregate turns (small files, parsed eagerly so the client gets one
      // round trip per L4 view).
      const turnsDir = path.join(dir, 'turns');
      const turnSum = {
        tokensIn: 0,
        tokensOut: 0,
        cacheReadTokens: 0,
        latencyMs: 0,
        costUsd: 0,
      };
      let turnCount = 0;
      if (fs.existsSync(turnsDir)) {
        for (const f of fs.readdirSync(turnsDir)) {
          if (!/^\d+\.json$/.test(f)) continue;
          const t = readJson(path.join(turnsDir, f));
          if (!t) continue;
          turnCount++;
          if (typeof t.tokensIn === 'number') turnSum.tokensIn += t.tokensIn;
          if (typeof t.tokensOut === 'number')
            turnSum.tokensOut += t.tokensOut;
          if (typeof t.cacheReadTokens === 'number')
            turnSum.cacheReadTokens += t.cacheReadTokens;
          if (typeof t.latencyMs === 'number')
            turnSum.latencyMs += t.latencyMs;
          if (typeof t.costUsd === 'number') turnSum.costUsd += t.costUsd;
        }
      }
      out.push({ nodeId, stageName: stage, stage: rec, turnCount, turnSum });
    }
  }
  // Sort by finishedAt when available, else node + stage name. Timeline
  // wants chronological; Cost view is order-agnostic.
  out.sort((a, b) => {
    const af = (a.stage as { finishedAt?: string } | null)?.finishedAt ?? '';
    const bf = (b.stage as { finishedAt?: string } | null)?.finishedAt ?? '';
    if (af && bf) return af.localeCompare(bf);
    return `${a.nodeId}/${a.stageName}`.localeCompare(
      `${b.nodeId}/${b.stageName}`,
    );
  });
  return out;
}
