import fs from 'fs';
import path from 'path';

import type { PipelineStage } from './pipeline-types.js';

export interface PipelineStageQueueEntry {
  name: string;
  initialPrompt?: string | null;
  ephemeralSystemPrompt?: string | null;
}

export interface PipelineState {
  version?: 3; // Required on save; load rejects older state files.
  currentStage: string | string[] | null;
  completedStages: string[];
  lastUpdated: string;
  status: 'running' | 'error' | 'success';
  activations?: Record<string, number>; // Per-stage activation count for fan-in accounting.
  completions?: Record<string, number>; // Per-stage completion count for fan-in accounting.
  runtimeStages?: PipelineStage[]; // Complete runtime graph after all stitches and rewrites.
  insertedStages?: PipelineStage[]; // Dynamically inserted stages (from runtime stitch). Merged into config on resume.
  joinSettlements?: Record<string, Record<string, 'success' | 'error'>>; // Per join-stage copy outcomes keyed by copy index.
  runningStages?: string[]; // Stages active when the last durable scheduler snapshot was written.
  pendingStages?: PipelineStageQueueEntry[]; // Runnable stages not yet launched, including handoff prompts.
  waitingStages?: PipelineStageQueueEntry[]; // Fan-in/join waiters, including handoff prompts.
  stageSessions?: Record<string, string>; // Last known provider session per stage.
}

const PIPELINE_STATE_FILE = 'PIPELINE_STATE.json';

// scopeId constrains nested child-runner paths so parent and sibling runners
// don't collide on PIPELINE_STATE / sessions / IPC / logs. Short alphanumeric
// keeps the derived virtual sub-folder under the group-folder length cap.
const SCOPE_ID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;

export function assertValidScopeId(scopeId: string): void {
  if (!SCOPE_ID_PATTERN.test(scopeId)) {
    throw new Error(
      `Invalid scopeId "${scopeId}" - must match ${SCOPE_ID_PATTERN}`,
    );
  }
}

/**
 * Derive the state file name for a given pipeline tag and optional scopeId.
 * - no tag, no scope            -> 'PIPELINE_STATE.json' (backward compatible)
 * - tag only                    -> 'PIPELINE_STATE.<tag>.json'
 * - scope only                  -> 'PIPELINE_STATE.<scope>.json'
 * - scope + tag                 -> 'PIPELINE_STATE.<scope>.<tag>.json'
 */
function pipelineStateFileName(tag?: string, scopeId?: string): string {
  const parts: string[] = [];
  if (scopeId) parts.push(scopeId);
  if (tag && tag !== 'PIPELINE') parts.push(tag);
  if (parts.length === 0) return PIPELINE_STATE_FILE;
  return `PIPELINE_STATE.${parts.join('.')}.json`;
}

export function savePipelineState(
  stateDir: string,
  state: PipelineState,
  tag?: string,
  scopeId?: string,
): void {
  fs.mkdirSync(stateDir, { recursive: true });
  const filepath = path.join(stateDir, pipelineStateFileName(tag, scopeId));
  const stateOut: PipelineState = { ...state, version: 3 };
  atomicWrite(filepath, JSON.stringify(stateOut, null, 2));
}

export function loadPipelineState(
  stateDir: string,
  tag?: string,
  scopeId?: string,
): PipelineState | null {
  const filepath = path.join(stateDir, pipelineStateFileName(tag, scopeId));
  let raw: string;
  try {
    raw = fs.readFileSync(filepath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: PipelineState & { pendingFanoutPayloads?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Pipeline state file ${filepath} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (parsed.version !== 3 || parsed.pendingFanoutPayloads !== undefined) {
    throw new Error(
      `Pipeline state file ${filepath} is from an older pipeline-state version - delete it to reset (rm "${filepath}")`,
    );
  }
  return parsed;
}

/**
 * Atomic write: write to .tmp then rename for crash safety.
 */
function atomicWrite(filepath: string, content: string): void {
  const tmpPath = `${filepath}.tmp`;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filepath);
}
