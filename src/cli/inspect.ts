/**
 * `art inspect` — read-only viewer for archived runs under `__art__/.state/runs/`.
 *
 * Usage:
 *   art inspect              # list recent runs
 *   art inspect <runId>      # print run summary + timeline
 *   art inspect <runId> --events   # raw events.jsonl
 *
 * Designed to be self-contained: no Docker, no auth, no engine startup.
 * Anything that can't be answered from disk is just omitted.
 */
import fs from 'fs';
import path from 'path';

import { ART_DIR_NAME } from '../config.js';
import { findRun, listRuns } from '../run-registry.js';

interface InspectOpts {
  events?: boolean;
  project?: string;
}

export async function inspect(
  runId: string | undefined,
  opts: InspectOpts = {},
): Promise<void> {
  const projectDir = path.resolve(opts.project ?? '.');
  const artDir = path.join(projectDir, ART_DIR_NAME);
  const stateDir = path.join(artDir, '.state');
  if (!fs.existsSync(stateDir)) {
    console.error(`No ${ART_DIR_NAME}/.state in ${projectDir}.`);
    process.exit(1);
  }

  if (!runId) {
    listRunsView(stateDir);
    return;
  }
  inspectRun(stateDir, runId, opts);
}

function listRunsView(stateDir: string): void {
  const runs = listRuns(stateDir);
  if (runs.length === 0) {
    console.log('No runs found.');
    return;
  }
  const header = `${pad('RUN ID', 28)}  ${pad('STATE', 8)}  ${pad('START', 24)}  ${pad('OUTCOME', 8)}  STAGES`;
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of runs) {
    const summary = readSummary(stateDir, r.runId);
    const outcome = summary?.outcome ?? '-';
    const stages =
      typeof summary?.totalStages === 'number'
        ? `${summary.totalStages - (summary.failedStages ?? 0)}/${summary.totalStages}`
        : '-';
    console.log(
      `${pad(r.runId, 28)}  ${pad(r.state, 8)}  ${pad(r.startTime ?? '-', 24)}  ${pad(outcome, 8)}  ${stages}`,
    );
  }
}

function inspectRun(stateDir: string, runId: string, opts: InspectOpts): void {
  const header = findRun(stateDir, runId);
  if (!header) {
    console.error(`Run not found: ${runId}`);
    process.exit(1);
  }
  const runDir = path.join(stateDir, 'runs', runId);
  const summary = readSummary(stateDir, runId);

  if (opts.events) {
    const events = readEventsJsonl(runDir);
    for (const ev of events) console.log(JSON.stringify(ev));
    return;
  }

  // Header block
  console.log(`Run:       ${runId}`);
  console.log(`State:     ${header.state}`);
  if (header.startTime) console.log(`Started:   ${header.startTime}`);
  if (summary?.endTime) console.log(`Ended:     ${summary.endTime}`);
  if (typeof summary?.durationMs === 'number')
    console.log(`Duration:  ${formatDuration(summary.durationMs)}`);
  if (summary?.outcome) console.log(`Outcome:   ${summary.outcome}`);
  if (typeof summary?.totalStages === 'number') {
    const failed = summary.failedStages ?? 0;
    console.log(
      `Stages:    ${summary.totalStages - failed}/${summary.totalStages} succeeded`,
    );
  }
  if (header.provider) console.log(`Provider:  ${header.provider}`);
  if (header.hostname) console.log(`Host:      ${header.hostname}`);

  // Per-stage records
  const stageRecords = collectStageRecords(runDir);
  if (stageRecords.length > 0) {
    console.log('');
    console.log('Stages:');
    for (const s of stageRecords) {
      const marker = s.matchedMarker ? `[${s.matchedMarker}]` : '';
      const dur =
        typeof s.durationMs === 'number'
          ? ` (${formatDuration(s.durationMs)})`
          : '';
      const retry =
        typeof s.retryCount === 'number' && s.retryCount > 0
          ? ` retry=${s.retryCount}`
          : '';
      const exit =
        typeof s.exitCode === 'number' && s.exitCode !== 0
          ? ` exit=${s.exitCode}`
          : '';
      console.log(
        `  ${pad(`[${s.nodeId}]`, 14)} ${pad(s.stageName, 24)} ${pad(s.result, 8)} ${marker}${dur}${retry}${exit}`,
      );
    }
  }

  // Decision-event timeline (filtered from events.jsonl)
  const events = readEventsJsonl(runDir);
  const decisions = events.filter(
    (e) => typeof e.type === 'string' && e.type.startsWith('decision.'),
  );
  if (decisions.length > 0) {
    console.log('');
    console.log('Decisions:');
    for (const d of decisions) {
      const t = typeof d.time === 'string' ? d.time.slice(11, 19) : '?';
      const stage = (d.stageName as string) ?? '?';
      console.log(`  ${t}  ${pad(stage, 24)} ${d.type}  ${d.message ?? ''}`);
    }
  }

  console.log('');
  console.log(`Run directory: ${runDir}`);
  console.log(`Tail events:   art inspect ${runId} --events`);
}

interface StageRecord {
  stageName: string;
  nodeId: string;
  result: string;
  matchedMarker?: string;
  durationMs?: number;
  retryCount?: number;
  exitCode?: number | null;
}

function collectStageRecords(runDir: string): StageRecord[] {
  const out: StageRecord[] = [];
  const nodesDir = path.join(runDir, 'nodes');
  if (!fs.existsSync(nodesDir)) return out;
  let nodes: string[];
  try {
    nodes = fs.readdirSync(nodesDir);
  } catch {
    return out;
  }
  for (const node of nodes) {
    const stagesDir = path.join(nodesDir, node, 'stages');
    if (!fs.existsSync(stagesDir)) continue;
    for (const stage of fs.readdirSync(stagesDir)) {
      const fp = path.join(stagesDir, stage, 'stage.json');
      if (!fs.existsSync(fp)) continue;
      try {
        const r = JSON.parse(fs.readFileSync(fp, 'utf-8'));
        out.push(r);
      } catch {
        // skip unreadable
      }
    }
  }
  // Sort by finishedAt if available, else node + stage name.
  out.sort((a, b) =>
    ((a as { finishedAt?: string }).finishedAt ?? '').localeCompare(
      (b as { finishedAt?: string }).finishedAt ?? '',
    ),
  );
  return out;
}

function readSummary(
  stateDir: string,
  runId: string,
): {
  outcome?: string;
  endTime?: string;
  durationMs?: number;
  totalStages?: number;
  failedStages?: number;
} | null {
  const fp = path.join(stateDir, 'runs', runId, 'summary.json');
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch {
    return null;
  }
}

function readEventsJsonl(runDir: string): Array<Record<string, unknown>> {
  const fp = path.join(runDir, 'events.jsonl');
  if (!fs.existsSync(fp)) return [];
  try {
    return fs
      .readFileSync(fp, 'utf-8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return {};
        }
      });
  } catch {
    return [];
  }
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + ' '.repeat(n - s.length);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}m` : `${m}m${r}s`;
}
