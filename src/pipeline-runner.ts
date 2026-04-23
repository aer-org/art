/**
 * Host-Side Pipeline FSM with Multi-Container Isolation
 *
 * When a group has PIPELINE.json, this runner spawns separate containers
 * per stage with different mount policies. The host FSM routes work via IPC
 * and each container maintains its session across retries.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';

import { spawn, execSync } from 'child_process';

import { CONTAINER_IMAGE, DATA_DIR } from './config.js';
import {
  buildContainerArgs,
  ContainerOutput,
  prefixLogLines,
  runContainerAgent,
} from './container-runner.js';
import { getRuntime } from './container-runtime.js';
import { getImageForStage, loadImageRegistry } from './image-registry.js';
import { validateAdditionalMounts } from './mount-security.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  generateRunId,
  writeRunManifest,
  type RunManifest,
} from './run-manifest.js';
import {
  formatStageMcpAccessSummary,
  loadMcpRegistry,
  resolveStageMcpServers,
  type ExternalMcpRegistry,
} from './mcp-registry.js';
import { resolveStagePrompt } from './prompt-store.js';
import { loadPipelineTemplate } from './pipeline-template.js';
import {
  assertConfigAcyclic,
  stitchParallel,
  stitchSingle,
  RESERVED_SUBSTITUTION_KEYS,
  type SubstitutionMap,
} from './stitch.js';
import { AdditionalMount, RegisteredGroup } from './types.js';

function resolveProvider(): 'claude' | 'codex' {
  return process.env.ART_AGENT_PROVIDER === 'codex' ? 'codex' : 'claude';
}

// --- Pipeline JSON Schema ---

export interface PipelineTransition {
  marker: string; // Marker name (e.g. "STAGE_COMPLETE")
  next?: string | string[] | null; // Stage name (scope-local) or null (pipeline end). Arrays are runtime-only (parallel-stitch barrier fan-out).
  template?: string; // Template name to stitch at runtime. Mutually exclusive with non-null `next`.
  count?: number; // With `template`: insert N copies in parallel + synthesized fan-in barrier. Requires `template`. Mutually exclusive with `countFrom`.
  countFrom?: 'payload'; // Derive lane count from marker payload (JSON array length). Requires `template`. Mutually exclusive with `count`.
  substitutionsFrom?: 'payload'; // Per-lane substitution map comes from payload[i] object fields. Requires `countFrom: "payload"`.
  prompt?: string; // Description for the agent on when to use this marker
}

export type StageKind = 'agent' | 'command';

export interface PipelineStage {
  name: string;
  kind?: StageKind; // Explicit stage kind. Default: inferred (command if `command` set, else agent).
  agent?: string; // Registry ref like "builder:latest". Resolved to prompt/mcp at run start.
  prompt?: string;
  prompts?: string[];
  prompt_append?: string;
  image?: string; // Registry key (agent mode) or image name (command mode)
  command?: string; // Shell command mode (runs sh -c, no agent)
  successMarker?: string; // Command mode: stdout substring that indicates success → STAGE_COMPLETE
  errorMarker?: string; // Command mode: stdout substring that indicates failure → STAGE_ERROR (resolves immediately)
  chat?: boolean; // Interactive chatting stage (agent + user conversation via stdin)
  mounts: Record<string, 'ro' | 'rw' | null | undefined>;
  devices?: string[];
  gpu?: boolean;
  runAsRoot?: boolean;
  privileged?: boolean; // Run container with --privileged flag
  env?: Record<string, string>; // Environment variables passed to container
  exclusive?: string;
  hostMounts?: AdditionalMount[]; // Host path mounts validated against allowlist
  mcpAccess?: string[]; // External MCP registry refs available to this stage
  resumeSession?: boolean; // false = always start fresh session. default true = resume
  fan_in?: 'all'; // Fan-in mode: waits for all predecessors. Reserved for future alternatives.
  transitions: PipelineTransition[];
}

/**
 * Resolve the effective stage kind — explicit `kind` wins, otherwise infer
 * from presence of `command`.
 */
export function resolveStageKind(stage: PipelineStage): StageKind {
  if (stage.kind) return stage.kind;
  return stage.command ? 'command' : 'agent';
}

export interface PipelineConfig {
  stages: PipelineStage[];
  entryStage?: string;
}

// --- Stitch directive (result of resolving a transition into stitch inputs) ---

export type StitchDirective =
  | { mode: 'single'; subs?: SubstitutionMap }
  | {
      mode: 'parallel';
      count: number;
      perCopySubs?: SubstitutionMap[];
    };

/**
 * Pure helper: given a matched transition and the payload captured from the
 * agent's marker, return the StitchDirective that performStitch should use.
 * Throws with a descriptive message on any invalid payload shape.
 *
 * Callers must pass `payload` only when the transition has `countFrom:
 * "payload"`; otherwise the argument is ignored. The caller catches thrown
 * errors and surfaces them as STAGE_ERROR outcomes.
 */
export function resolveStitchInputs(
  t: PipelineTransition,
  payload: string | null,
): StitchDirective {
  // Static count path — unchanged from pre-payload behavior.
  if (t.countFrom === undefined) {
    if (t.count !== undefined && t.count > 1) {
      return { mode: 'parallel', count: t.count };
    }
    return { mode: 'single' };
  }

  // Dynamic (payload-driven) path.
  if (payload === null || payload.length === 0) {
    throw new Error(
      'countFrom: "payload" requires the agent to emit a fenced ---PAYLOAD_START---...---PAYLOAD_END--- block after the marker',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    throw new Error(`Payload is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Payload must be a JSON array');
  }
  if (parsed.length === 0) {
    throw new Error('Payload array must be non-empty');
  }
  const wantSubs = t.substitutionsFrom === 'payload';
  const perCopySubs: SubstitutionMap[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const el = parsed[i];
    if (el === null || typeof el !== 'object' || Array.isArray(el)) {
      throw new Error(
        `Payload element [${i}] must be a flat JSON object (got ${el === null ? 'null' : Array.isArray(el) ? 'array' : typeof el})`,
      );
    }
    const subs: SubstitutionMap = {};
    for (const [key, value] of Object.entries(el)) {
      if ((RESERVED_SUBSTITUTION_KEYS as readonly string[]).includes(key)) {
        throw new Error(
          `Payload element [${i}] uses reserved key "${key}" (reserved: ${RESERVED_SUBSTITUTION_KEYS.join(', ')})`,
        );
      }
      if (
        typeof value !== 'string' &&
        typeof value !== 'number' &&
        typeof value !== 'boolean'
      ) {
        throw new Error(
          `Payload element [${i}] field "${key}" must be string/number/boolean (got ${typeof value})`,
        );
      }
      subs[key] = value;
    }
    perCopySubs.push(subs);
  }
  if (perCopySubs.length === 1) {
    return {
      mode: 'single',
      subs: wantSubs ? perCopySubs[0] : undefined,
    };
  }
  return {
    mode: 'parallel',
    count: perCopySubs.length,
    perCopySubs: wantSubs ? perCopySubs : undefined,
  };
}

// --- Exclusive stage lock ---
// Stages with the same `exclusive` key share a mutex.
// Only one container runs at a time per key (e.g. "vivado" for bitstream + board_upload).

class ExclusiveLock {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }
}

const exclusiveLocks = new Map<string, ExclusiveLock>();

function getExclusiveLock(key: string): ExclusiveLock {
  let lock = exclusiveLocks.get(key);
  if (!lock) {
    lock = new ExclusiveLock();
    exclusiveLocks.set(key, lock);
  }
  return lock;
}

// --- Pipeline State Tracking ---

export interface PipelineState {
  version?: 2; // Required on save; load rejects state files without version 2.
  currentStage: string | string[] | null;
  completedStages: string[];
  lastUpdated: string;
  status: 'running' | 'error' | 'success';
  activations?: Record<string, number>; // Per-stage activation count for fan-in accounting.
  completions?: Record<string, number>; // Per-stage completion count for fan-in accounting.
  insertedStages?: PipelineStage[]; // Dynamically inserted stages (from runtime stitch). Merged into config on resume.
}

const PIPELINE_STATE_FILE = 'PIPELINE_STATE.json';

// scopeId constrains nested child-runner paths so parent and sibling runners
// don't collide on PIPELINE_STATE / sessions / IPC / logs. Short alphanumeric
// keeps the derived virtual sub-folder under the group-folder length cap.
const SCOPE_ID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;

export function assertValidScopeId(scopeId: string): void {
  if (!SCOPE_ID_PATTERN.test(scopeId)) {
    throw new Error(
      `Invalid scopeId "${scopeId}" — must match ${SCOPE_ID_PATTERN}`,
    );
  }
}

/**
 * Derive the state file name for a given pipeline tag and optional scopeId.
 * - no tag, no scope            → 'PIPELINE_STATE.json' (backward compatible)
 * - tag only                    → 'PIPELINE_STATE.<tag>.json'
 * - scope only                  → 'PIPELINE_STATE.<scope>.json'
 * - scope + tag                 → 'PIPELINE_STATE.<scope>.<tag>.json'
 */
function pipelineStateFileName(tag?: string, scopeId?: string): string {
  const parts: string[] = [];
  if (scopeId) parts.push(scopeId);
  if (tag && tag !== 'PIPELINE') parts.push(tag);
  if (parts.length === 0) return PIPELINE_STATE_FILE;
  return `PIPELINE_STATE.${parts.join('.')}.json`;
}

/**
 * Derive a short tag from a custom pipeline file path.
 * e.g. '/abs/path/to/my-pipeline.json' → 'my-pipeline'
 *      undefined (default PIPELINE.json) → undefined
 */
export function pipelineTagFromPath(
  pipelinePath: string | undefined,
): string | undefined {
  if (!pipelinePath) return undefined;
  const base = path.basename(pipelinePath, '.json');
  if (base === 'PIPELINE') return undefined;
  return base;
}

export function savePipelineState(
  groupDir: string,
  state: PipelineState,
  tag?: string,
  scopeId?: string,
): void {
  const filepath = path.join(groupDir, pipelineStateFileName(tag, scopeId));
  const stateOut: PipelineState = { ...state, version: 2 };
  atomicWrite(filepath, JSON.stringify(stateOut, null, 2));
}

export function loadPipelineState(
  groupDir: string,
  tag?: string,
  scopeId?: string,
): PipelineState | null {
  const filepath = path.join(groupDir, pipelineStateFileName(tag, scopeId));
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
  if (parsed.version !== 2 || parsed.pendingFanoutPayloads !== undefined) {
    throw new Error(
      `Pipeline state file ${filepath} is from a pre-stitch version — delete it to reset (rm "${filepath}")`,
    );
  }
  return parsed;
}

// --- Internal types ---

interface StageMarkerResult {
  matched: PipelineTransition | null;
  payload: string | null;
}

interface StageHandle {
  name: string;
  config: PipelineStage;
  ipcInputDir: string;
  containerPromise: Promise<ContainerOutput>;
  pendingResult: {
    promise: Promise<StageMarkerResult>;
    resolve: (r: StageMarkerResult) => void;
  } | null;
  resultTexts: string[];
}

/**
 * Parse stage markers dynamically from the stage's transitions array.
 *
 * Supported forms (first match wins across transitions):
 *   [MARKER]                                          — no payload
 *   [MARKER: short inline payload]                    — single-line payload
 *   [MARKER]
 *   ---PAYLOAD_START---
 *   free-form multi-line payload (any chars incl. ])
 *   ---PAYLOAD_END---                                 — fenced payload
 *
 * The fenced form is preferred for anything non-trivial. Payload must not
 * contain the literal sentinel `---PAYLOAD_END---` (non-greedy match stops
 * at the first occurrence).
 *
 * Defensive unwrap: if a fenced payload body is *solely* an inline form of
 * the same marker (`[MARKER]` or `[MARKER: value]`), the inner value (or
 * null) is returned. This protects against agents double-wrapping the
 * marker — emitting inline syntax inside the fence — which would otherwise
 * leak literal brackets into downstream dispatchers.
 */
export function parseStageMarkers(
  resultTexts: string[],
  transitions: PipelineTransition[],
): StageMarkerResult {
  const combined = resultTexts.join('\n');
  for (const transition of transitions) {
    const markerName = escapeRegExp(transition.marker);
    // Fenced payload: [MARKER] followed by ---PAYLOAD_START---...---PAYLOAD_END---
    const fencedRegex = new RegExp(
      `\\[${markerName}\\][ \\t]*\\r?\\n[ \\t]*---PAYLOAD_START---[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*---PAYLOAD_END---`,
    );
    const fencedMatch = fencedRegex.exec(combined);
    if (fencedMatch) {
      const payload = fencedMatch[1];
      const unwrapRegex = new RegExp(`^\\[${markerName}(?::\\s*(.+?))?\\]$`);
      const unwrap = unwrapRegex.exec(payload.trim());
      if (unwrap) {
        return { matched: transition, payload: unwrap[1] ?? null };
      }
      return { matched: transition, payload };
    }
    // Inline / no payload: [MARKER] or [MARKER: payload]
    const regex = new RegExp(`\\[${markerName}(?::\\s*(.+?))?\\]`);
    const match = regex.exec(combined);
    if (match) {
      return { matched: transition, payload: match[1] ?? null };
    }
  }
  return { matched: null, payload: null };
}

function readUserInput(promptText: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise<string>((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createDeferred(): {
  promise: Promise<StageMarkerResult>;
  resolve: (r: StageMarkerResult) => void;
} {
  let resolve!: (r: StageMarkerResult) => void;
  const promise = new Promise<StageMarkerResult>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Atomic write: write to .tmp then rename for crash safety.
 */
function atomicWrite(filepath: string, content: string): void {
  const tmpPath = `${filepath}.tmp`;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filepath);
}

/**
 * Send a message to a stage container via IPC input directory.
 */
function sendToStage(handle: StageHandle, text: string): void {
  const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`;
  const filepath = path.join(handle.ipcInputDir, filename);
  atomicWrite(filepath, JSON.stringify({ type: 'message', text }));
  logger.debug(
    { stage: handle.name, textLen: text.length },
    'Sent IPC message to stage container',
  );
}

/**
 * Send _close sentinel to a stage container.
 */
function closeStage(handle: StageHandle): void {
  try {
    fs.writeFileSync(path.join(handle.ipcInputDir, '_close'), '');
  } catch {
    // Container may already be gone
  }
}

export class PipelineRunner {
  private group: RegisteredGroup;
  private chatJid: string;
  private config: PipelineConfig;
  private notify: (text: string) => Promise<void>;
  private onProcess: (
    proc: import('child_process').ChildProcess,
    containerName: string,
  ) => void;
  private groupDir: string;
  private runId: string;
  private pipelineTag: string | undefined;
  private scopeId: string | undefined;
  private manifest: RunManifest;
  private aborted = false;
  private activeHandles = new Map<string, StageHandle>();
  private stageSessionIds = new Map<string, string>();
  private baseStageCount = 0;
  constructor(
    group: RegisteredGroup,
    chatJid: string,
    pipelineConfig: PipelineConfig,
    notify: (text: string) => Promise<void>,
    onProcess: (
      proc: import('child_process').ChildProcess,
      containerName: string,
    ) => void,
    groupDir?: string,
    runId?: string,
    pipelineTag?: string,
    scopeId?: string,
  ) {
    this.group = group;
    this.chatJid = chatJid;
    this.config = pipelineConfig;
    this.baseStageCount = pipelineConfig.stages.length;
    this.notify = notify;
    this.onProcess = onProcess;
    this.groupDir = groupDir ?? resolveGroupFolderPath(this.group.folder);
    this.runId = runId ?? generateRunId();
    this.pipelineTag = pipelineTag;
    if (scopeId !== undefined) assertValidScopeId(scopeId);
    this.scopeId = scopeId;
    this.manifest = {
      runId: this.runId,
      pid: process.pid,
      startTime: new Date().toISOString(),
      status: 'running',
      stages: [],
    };
  }

  /**
   * Compute the virtual sub-group folder for a stage container.
   * When scopeId is set, embed it so sibling runners that spawn the same
   * stage name get distinct IPC / sessions / conversations paths.
   */
  private stageSubFolder(stageName: string): string {
    return this.scopeId
      ? `${this.group.folder}__${this.scopeId}__pipeline_${stageName}`
      : `${this.group.folder}__pipeline_${stageName}`;
  }

  /**
   * Sub-paths must be relative, non-empty, and cannot contain ".." segments
   * or start with a leading slash. Keeps the mount confined under its parent.
   */
  private isValidSubPath(subPath: string): boolean {
    if (!subPath) return false;
    if (subPath.startsWith('/')) return false;
    const segments = subPath.split('/');
    if (segments.some((s) => s === '' || s === '..' || s === '.')) return false;
    return true;
  }

  getRunId(): string {
    return this.runId;
  }

  async abort(): Promise<void> {
    this.aborted = true;
    const handles = [...this.activeHandles.values()];
    await Promise.all(handles.map((h) => this.closeAndWait(h)));
  }

  /** Send a visually prominent banner to TUI for stage transitions */
  private async notifyBanner(text: string): Promise<void> {
    if (process.env.ART_TUI_MODE) {
      const line = '─'.repeat(50);
      await this.notify(
        `\n\x1b[36m${line}\x1b[0m\n\x1b[1;36m${text}\x1b[0m\n\x1b[36m${line}\x1b[0m`,
      );
    } else {
      await this.notify(text);
    }
  }

  /**
   * Build all internal mounts for a stage: group mounts + project mount +
   * __art__ shadow + project:* sub-path overrides.
   * Shared by both agent mode and command mode.
   */
  private buildStageMounts(
    stageConfig: PipelineStage,
  ): Array<{ hostPath: string; containerPath: string; readonly: boolean }> {
    const mounts: Array<{
      hostPath: string;
      containerPath: string;
      readonly: boolean;
    }> = [];

    // Reserved keys that conflict with /workspace/* system paths
    const RESERVED_KEYS = new Set([
      'project',
      'ipc',
      'global',
      'extra',
      'conversations',
    ]);

    const emptyDir = path.join(DATA_DIR, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });

    // Stage mounts (e.g. "src": "rw" → /workspace/src)
    for (const [key, policy] of Object.entries(stageConfig.mounts)) {
      if (key.includes(':')) continue; // sub-path keys handled below
      if (!policy) continue;
      if (RESERVED_KEYS.has(key)) {
        logger.warn(
          { key },
          `mount key "${key}" conflicts with reserved /workspace/${key} — skipped`,
        );
        continue;
      }

      const hostDir = path.join(this.groupDir, key);
      fs.mkdirSync(hostDir, { recursive: true });

      mounts.push({
        hostPath: hostDir,
        containerPath: `/workspace/${key}`,
        readonly: policy === 'ro',
      });
    }

    // Project mount (parent of __art__/)
    const projectPolicy = stageConfig.mounts['project'];
    const effectivePolicy = projectPolicy === undefined ? 'ro' : projectPolicy;
    const artDirName = path.basename(this.groupDir);
    if (effectivePolicy) {
      mounts.push({
        hostPath: path.dirname(this.groupDir),
        containerPath: '/workspace/project',
        readonly: effectivePolicy === 'ro',
      });

      // Shadow __art__/ with empty dir
      mounts.push({
        hostPath: emptyDir,
        containerPath: `/workspace/project/${artDirName}`,
        readonly: true,
      });
    }

    // Sub-path overrides. Syntax: "<key>:<subpath>" with value ro | rw | null.
    // File-level bind mounts are not supported (Docker tracks inodes, git
    // operations replace files with new inodes, making the bind mount stale).
    for (const [key, subPolicy] of Object.entries(stageConfig.mounts)) {
      if (!key.includes(':')) continue;
      const sepIdx = key.indexOf(':');
      const parentKey = key.slice(0, sepIdx);
      const subPath = key.slice(sepIdx + 1);

      if (!this.isValidSubPath(subPath)) {
        logger.warn({ key, subPath }, 'Invalid sub-path — skipped');
        continue;
      }
      if (RESERVED_KEYS.has(parentKey) && parentKey !== 'project') {
        logger.warn(
          { parentKey, subPath },
          `sub-mount parent "${parentKey}" conflicts with reserved /workspace/${parentKey} — skipped`,
        );
        continue;
      }

      let hostBase: string;
      let containerBase: string;
      let parentEffective: 'ro' | 'rw' | undefined;

      if (parentKey === 'project') {
        if (!effectivePolicy) continue;
        if (subPath === artDirName || subPath.startsWith(artDirName + '/'))
          continue;
        hostBase = path.dirname(this.groupDir);
        containerBase = '/workspace/project';
        parentEffective = effectivePolicy;
      } else {
        hostBase = path.join(this.groupDir, parentKey);
        containerBase = `/workspace/${parentKey}`;
        const pp = stageConfig.mounts[parentKey];
        parentEffective = pp === 'ro' || pp === 'rw' ? pp : undefined;
      }

      const subHostPath = path.join(hostBase, subPath);
      const isFile =
        fs.existsSync(subHostPath) && fs.statSync(subHostPath).isFile();
      if (isFile) {
        logger.warn(
          { key, subPath },
          'File-level sub-mount ignored (only directories supported)',
        );
        continue;
      }

      const containerSubPath = `${containerBase}/${subPath}`;
      if (subPolicy === null) {
        // Only meaningful when parent is mounted — shadow that subtree.
        if (parentEffective) {
          mounts.push({
            hostPath: emptyDir,
            containerPath: containerSubPath,
            readonly: true,
          });
        }
        continue;
      }
      if (!subPolicy) continue;
      if (parentEffective && subPolicy === parentEffective) continue;

      // Direct or override mount. Create the host dir so the child can
      // populate it even when the parent is absent.
      fs.mkdirSync(subHostPath, { recursive: true });
      mounts.push({
        hostPath: subHostPath,
        containerPath: containerSubPath,
        readonly: subPolicy === 'ro',
      });
    }

    // Host path mounts (validated against external allowlist)
    if (stageConfig.hostMounts && stageConfig.hostMounts.length > 0) {
      const validated = validateAdditionalMounts(
        stageConfig.hostMounts,
        `pipeline-${stageConfig.name}`,
        this.group.isMain ?? false,
      );
      mounts.push(...validated);
    }

    // Conversations archive directory (agent-runner writes transcripts here)
    const subFolder = this.stageSubFolder(stageConfig.name);
    const convDir = path.join(
      resolveGroupFolderPath(subFolder),
      'conversations',
    );
    fs.mkdirSync(convDir, { recursive: true });
    mounts.push({
      hostPath: convDir,
      containerPath: '/workspace/conversations',
      readonly: false,
    });

    return mounts;
  }

  /**
   * Spawn a stage container as a virtual sub-group.
   * The container starts with an initial prompt and enters the IPC wait loop.
   */
  private spawnStageContainer(
    stageConfig: PipelineStage,
    initialPrompt: string,
    logStream?: fs.WriteStream,
    ephemeralSystemPrompt?: string,
  ): StageHandle {
    const subFolder = this.stageSubFolder(stageConfig.name);

    // Build internal mounts (group + project + sub-path overrides)
    const internalMounts = this.buildStageMounts(stageConfig);

    // Resolve container image from registry (agent mode only)
    let resolvedImage: string | undefined;
    if (!stageConfig.command) {
      resolvedImage = getImageForStage(stageConfig.image, false);
    }
    const resolvedExternalMcpServers = stageConfig.command
      ? []
      : resolveStageMcpServers(stageConfig.mcpAccess, {
          hostGateway: getRuntime().hostGateway,
        });

    // Parent's additional mounts stay in additionalMounts (security-validated).
    // Filter out any that conflict with stage-level hostMounts (stage wins).
    const parentMounts = this.group.containerConfig?.additionalMounts || [];
    const stageExtraPaths = new Set(
      internalMounts
        .filter((m) => m.containerPath.startsWith('/workspace/extra/'))
        .map((m) => m.containerPath),
    );
    const filteredParentMounts = parentMounts.filter((m) => {
      const cp = `/workspace/extra/${m.containerPath || path.basename(m.hostPath)}`;
      return !stageExtraPaths.has(cp);
    });

    const virtualGroup: RegisteredGroup = {
      name: `pipeline-${stageConfig.name}`,
      folder: subFolder, // Flat folder for IPC/sessions
      trigger: '',
      added_at: new Date().toISOString(),
      containerConfig: {
        provider: this.group.containerConfig?.provider || resolveProvider(),
        image: resolvedImage,
        additionalMounts: filteredParentMounts,
        additionalDevices: stageConfig.devices || [],
        gpu: stageConfig.gpu === true,
        runAsRoot: stageConfig.runAsRoot === true,
        privileged: stageConfig.privileged === true,
        env: stageConfig.env,
        externalMcpServers: resolvedExternalMcpServers,
        internalMounts,
      },
    };

    const ipcInputDir = path.join(resolveGroupIpcPath(subFolder), 'input');
    fs.mkdirSync(ipcInputDir, { recursive: true });
    // Clean stale _close sentinel
    try {
      fs.unlinkSync(path.join(ipcInputDir, '_close'));
    } catch {
      /* ignore */
    }

    const handle: StageHandle = {
      name: stageConfig.name,
      config: stageConfig,
      ipcInputDir,
      containerPromise: null!,
      pendingResult: createDeferred(),
      resultTexts: [],
    };

    // Create onOutput callback that resolves the pending deferred
    const onOutput = async (output: ContainerOutput) => {
      logger.info(
        {
          stage: stageConfig.name,
          hasResult: !!output.result,
          hasPending: !!handle.pendingResult,
          textsLen: handle.resultTexts.length,
        },
        'onOutput called',
      );
      // result=null means query ended (agent entering IPC wait).
      // If we have accumulated text with no marker, resolve as no-match
      // so the FSM can send a retry prompt via IPC.
      if (!output.result) {
        if (handle.pendingResult && handle.resultTexts.length > 0) {
          handle.pendingResult.resolve({ matched: null, payload: null });
          handle.pendingResult = null;
          handle.resultTexts = [];
        }
        return;
      }
      handle.resultTexts.push(output.result);

      // Stream agent output to user
      if (stageConfig.chat) {
        // Chatting stage: show full output so user can read the agent's response
        await this.notify(output.result);
      } else if (process.env.ART_TUI_MODE) {
        const lines = output.result.split('\n');
        const summary =
          lines.length > 3
            ? lines.slice(0, 3).join('\n') +
              `\n... (${lines.length - 3} more lines)`
            : output.result;
        await this.notify(`[${stageConfig.name}] ${summary}`);
      }

      const markers = parseStageMarkers(
        handle.resultTexts,
        stageConfig.transitions,
      );
      logger.info(
        { stage: stageConfig.name, matched: markers.matched?.marker ?? null },
        'parseStageMarkers result',
      );
      if (markers.matched) {
        if (handle.pendingResult) {
          logger.info(
            { stage: stageConfig.name, marker: markers.matched.marker },
            'Resolving pendingResult',
          );
          handle.pendingResult.resolve(markers);
          handle.pendingResult = null;
        } else {
          logger.warn(
            { stage: stageConfig.name, marker: markers.matched.marker },
            'Marker matched but no pendingResult!',
          );
        }
        handle.resultTexts = [];
      } else if (handle.pendingResult) {
        // Result came but no marker — resolve immediately as no-match
        // so the FSM sends a retry prompt with transition instructions via IPC.
        logger.warn(
          { stage: stageConfig.name },
          'Result without marker, resolving as no-match for retry',
        );
        handle.pendingResult.resolve({ matched: null, payload: null });
        handle.pendingResult = null;
        handle.resultTexts = [];
      }
    };

    if (stageConfig.command) {
      // Command mode: run shell command, no agent
      handle.containerPromise = this.runStageCommand(
        stageConfig,
        handle,
        logStream,
      );
    } else {
      // Agent mode: spawn the container (don't await — it runs in background)
      // Resume previous session if available (preserves context across loop iterations)
      handle.containerPromise = runContainerAgent(
        virtualGroup,
        {
          prompt: initialPrompt,
          sessionId:
            stageConfig.resumeSession !== false
              ? this.stageSessionIds.get(stageConfig.name)
              : undefined,
          provider: virtualGroup.containerConfig?.provider,
          groupFolder: subFolder,
          chatJid: this.chatJid,
          isMain: false,
          assistantName: `pipeline-${stageConfig.name}`,
          runId: this.runId,
          ephemeralSystemPrompt,
          externalMcpServers: resolvedExternalMcpServers,
        },
        (proc, containerName) => this.onProcess(proc, containerName),
        onOutput,
        logStream,
      );
    }

    // Handle container exit
    handle.containerPromise
      .then((result) => {
        logger.info(
          { stage: stageConfig.name, status: result.status },
          'Pipeline stage container exited',
        );
        // If there's a pending result, resolve with a fallback
        if (handle.pendingResult) {
          const markers = parseStageMarkers(
            handle.resultTexts,
            stageConfig.transitions,
          );
          handle.pendingResult.resolve(
            markers.matched
              ? markers
              : {
                  matched: {
                    marker: '_CONTAINER_EXIT',
                    prompt: 'Container exited unexpectedly',
                  },
                  payload: 'Container exited unexpectedly',
                },
          );
          handle.pendingResult = null;
        }
      })
      .catch((err) => {
        logger.error(
          { stage: stageConfig.name, err },
          'Pipeline stage container error',
        );
        if (handle.pendingResult) {
          handle.pendingResult.resolve({
            matched: {
              marker: '_CONTAINER_ERROR',
              prompt: 'Container error',
            },
            payload: `Container error: ${err instanceof Error ? err.message : String(err)}`,
          });
          handle.pendingResult = null;
        }
      });

    return handle;
  }

  /**
   * Run a command-mode stage: spawn container with sh -c, collect stdout,
   * parse markers from output.
   */
  private runStageCommand(
    stageConfig: PipelineStage,
    handle: StageHandle,
    logStream?: fs.WriteStream,
  ): Promise<ContainerOutput> {
    const rt = getRuntime();
    const internalMounts = this.buildStageMounts(stageConfig);

    const safeName = stageConfig.name.replace(/[^a-zA-Z0-9-]/g, '-');
    const containerName = `aer-art-cmd-${safeName}-${Date.now()}`;
    const image = stageConfig.image || CONTAINER_IMAGE;
    const devices = stageConfig.devices || [];
    const gpu = stageConfig.gpu === true;
    const runAsRoot = stageConfig.runAsRoot === true;
    const privileged = stageConfig.privileged === true;

    const containerArgs = buildContainerArgs(
      internalMounts,
      containerName,
      devices,
      gpu,
      runAsRoot,
      image,
      'sh',
      this.runId,
      privileged,
      stageConfig.env,
    );
    containerArgs.push('-c', stageConfig.command!);

    logger.info(
      { stage: stageConfig.name, image, command: stageConfig.command },
      'Running command-mode stage',
    );

    if (logStream) {
      logStream.write(
        `\n=== Command Stage: ${stageConfig.name} ===\n` +
          `Started: ${new Date().toISOString()}\n` +
          `Image: ${image}\n` +
          `Command: ${stageConfig.command}\n\n`,
      );
    }

    return new Promise<ContainerOutput>((resolve) => {
      const container = spawn(rt.bin, containerArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.onProcess(container, containerName);

      let stdout = '';
      let stderr = '';
      let cmdLogRemainder = '';
      let cmdLogStderrRemainder = '';
      // Streaming marker detection: resolve pendingResult as soon as a marker
      // is found in stdout, without waiting for process exit.
      let markerResolved = false;

      const completeTransition = stageConfig.transitions.find(
        (t) => t.marker === 'STAGE_COMPLETE',
      );
      const errorTransition = stageConfig.transitions.find(
        (t) => t.marker === 'STAGE_ERROR',
      );

      const resolveMarker = (isSuccess: boolean, payload: string | null) => {
        if (markerResolved || !handle.pendingResult) return;
        markerResolved = true;
        const transition = isSuccess ? completeTransition : errorTransition;
        // On success, scan stdout for a fenced marker payload to forward to
        // the next stage. Command stages don't emit payload structurally, but
        // fenced `[MARKER] ... ---PAYLOAD_START--- ... ---PAYLOAD_END---`
        // blocks in stdout are picked up so a command stage can feed a
        // downstream dynamic-fanout.
        let effectivePayload = payload;
        if (isSuccess && transition && effectivePayload === null) {
          const parsed = parseStageMarkers([stdout], [transition]);
          if (parsed.matched && parsed.payload !== null) {
            effectivePayload = parsed.payload;
          }
        }
        handle.pendingResult.resolve({
          matched: transition ?? {
            marker: isSuccess ? 'STAGE_COMPLETE' : 'STAGE_ERROR',
            next: null,
          },
          payload: effectivePayload,
        });
        handle.pendingResult = null;
        // Kill process on error marker — no need to wait for cleanup
        if (!isSuccess) {
          container.kill('SIGTERM');
        }
      };

      container.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        if (logStream) {
          const { prefixed, remainder } = prefixLogLines(
            chunk,
            stageConfig.name,
            cmdLogRemainder,
          );
          cmdLogRemainder = remainder;
          if (prefixed) logStream.write(prefixed);
        }

        // Stream output to TUI
        if (process.env.ART_TUI_MODE) {
          const trimmed = chunk.trim();
          if (trimmed) {
            this.notify(`[${stageConfig.name}] ${trimmed}`).catch(() => {});
          }
        }

        // Streaming marker detection
        if (!markerResolved) {
          if (
            stageConfig.successMarker &&
            stdout.includes(stageConfig.successMarker)
          ) {
            resolveMarker(true, null);
          } else if (
            stageConfig.errorMarker &&
            stdout.includes(stageConfig.errorMarker)
          ) {
            resolveMarker(
              false,
              `errorMarker detected: ${stageConfig.errorMarker}`,
            );
          }
        }
      });

      container.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        if (logStream) {
          const { prefixed, remainder } = prefixLogLines(
            chunk,
            `${stageConfig.name}:stderr`,
            cmdLogStderrRemainder,
          );
          cmdLogStderrRemainder = remainder;
          if (prefixed) logStream.write(prefixed);
        }
      });

      const configTimeout = this.group.containerConfig?.timeout || 14400000; // 4 hour default for commands
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        container.kill('SIGTERM');
        setTimeout(() => container.kill('SIGKILL'), 15000);
      }, configTimeout);

      container.on('close', (code) => {
        clearTimeout(timeout);

        if (logStream) {
          if (cmdLogRemainder)
            logStream.write(`[${stageConfig.name}] ${cmdLogRemainder}\n`);
          if (cmdLogStderrRemainder)
            logStream.write(
              `[${stageConfig.name}:stderr] ${cmdLogStderrRemainder}\n`,
            );
          logStream.write(
            `\n=== Command Stage ${stageConfig.name} exited: code=${code} ===\n`,
          );
        }

        // If marker already resolved during streaming, just finalize the container promise
        if (markerResolved) {
          resolve({
            status: code === 0 ? 'success' : 'error',
            result: stdout,
            error: code !== 0 ? `Command exited with code ${code}` : undefined,
          });
          return;
        }

        if (timedOut) {
          resolveMarker(false, `Command timed out after ${configTimeout}ms`);
          resolve({
            status: 'error',
            result: null,
            error: `Command timed out after ${configTimeout}ms`,
          });
          return;
        }

        // Fallback: no streaming marker matched, use successMarker check or exit code
        const isSuccess = stageConfig.successMarker
          ? stdout.includes(stageConfig.successMarker)
          : code === 0;

        resolveMarker(
          isSuccess,
          isSuccess
            ? null
            : code !== 0
              ? `Exit code ${code}: ${stderr.slice(-500)}`
              : `successMarker not found in output`,
        );

        resolve({
          status: code === 0 ? 'success' : 'error',
          result: stdout,
          error: code !== 0 ? `Command exited with code ${code}` : undefined,
        });
      });

      container.on('error', (err) => {
        clearTimeout(timeout);
        resolveMarker(false, err.message);
        resolve({
          status: 'error',
          result: null,
          error: `Command container spawn error: ${err.message}`,
        });
      });
    });
  }

  /**
   * Close a stage container and wait for it to exit (with timeout).
   */
  private async closeAndWait(handle: StageHandle): Promise<void> {
    closeStage(handle);
    const settled = await Promise.race([
      handle.containerPromise.then(() => 'done' as const),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 5000)),
    ]);
    if (settled === 'timeout') {
      logger.warn(
        { stage: handle.name },
        'Stage did not exit in 5s, force-stopping',
      );
      try {
        const { cleanupRunContainers } = await import('./container-runtime.js');
        cleanupRunContainers(this.runId);
      } catch {
        /* best effort */
      }
    }
  }

  /**
   * Build commonRules dynamically from a stage's transitions.
   */
  private buildCommonRules(stageConfig: PipelineStage): string {
    const markerLines = stageConfig.transitions.map((t) => {
      const desc = t.prompt || t.marker;
      return `- ${desc} → [${t.marker}]`;
    });

    const modeRule = stageConfig.chat
      ? '- You are in an interactive conversation with the user. Ask questions and respond conversationally.\n- When the conversation goal is achieved, emit the completion marker.'
      : '- Do NOT ask questions. Always assume "yes" and proceed autonomously.\n- Do not stop until this stage is complete or you hit a blocking error.';
    const externalMcpLines = (() => {
      if (!stageConfig.mcpAccess || stageConfig.mcpAccess.length === 0) {
        return '- External MCP access for this stage: none.';
      }

      const servers = resolveStageMcpServers(stageConfig.mcpAccess, {
        hostGateway: getRuntime().hostGateway,
      });
      return [
        '- External MCP access is limited to the following servers/tools:',
        ...formatStageMcpAccessSummary(servers),
      ].join('\n');
    })();

    return `
RULES:
${modeRule}
- Read files before editing. Use tools freely.
- Project source is available read-only at /workspace/project/.
- Stage working directories are mounted under /workspace/ (plan/, src/, tb/, build/, sim/, etc.). Always read and write files at these paths.
${externalMcpLines}

STAGE MARKERS — use the correct one:
${markerLines.join('\n')}

PAYLOAD FORMATS:
- Short, single-line payload: [MARKER: payload text]
- Long or multi-line payload (preferred for anything non-trivial), emit the bare marker on its own line followed by a fenced block:
    [MARKER]
    ---PAYLOAD_START---
    free-form content, any characters or line count allowed
    ---PAYLOAD_END---
  Do NOT include the literal string "---PAYLOAD_END---" inside the payload.`;
  }

  /**
   * Validate plan, initialize git if needed, write manifest, create log stream.
   * Returns null on validation failure.
   */
  private async initRun(): Promise<{
    planContent: string;
    stagesByName: Map<string, PipelineStage>;
    pipelineLogStream: fs.WriteStream;
  } | null> {
    const planPath = path.join(this.groupDir, 'plan', 'PLAN.md');
    const planContent = fs.existsSync(planPath)
      ? fs.readFileSync(planPath, 'utf-8')
      : '';

    // Ensure project directory is a git repo (containers need it for branching/committing)
    const projectRoot = path.dirname(this.groupDir);
    const dotGit = path.join(projectRoot, '.git');
    if (!fs.existsSync(dotGit)) {
      logger.info({ projectRoot }, 'Project is not a git repo, initializing');
      const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: 'AerArt',
        GIT_AUTHOR_EMAIL: 'art-agent@local',
        GIT_COMMITTER_NAME: 'AerArt',
        GIT_COMMITTER_EMAIL: 'art-agent@local',
      };
      execSync('git init -b main', { cwd: projectRoot, stdio: 'pipe' });
      execSync('git commit --allow-empty -m "art: initial baseline"', {
        cwd: projectRoot,
        stdio: 'pipe',
        env: gitEnv,
      });
    }

    // Write initial manifest
    writeRunManifest(this.groupDir, this.manifest);
    logger.info(
      {
        group: this.group.name,
        runId: this.runId,
        planLen: planContent.length,
        stageCount: this.config.stages.length,
      },
      'Pipeline starting',
    );

    const stageNames = this.config.stages.map((s) => s.name).join(' → ');
    await this.notifyBanner(`🚀 Pipeline starting. Stages: ${stageNames}`);

    // Pipeline-wide log file
    const logsDir = this.scopeId
      ? path.join(this.groupDir, 'logs', this.scopeId)
      : path.join(this.groupDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const pipelineLogFile = path.join(logsDir, `pipeline-${ts}.log`);
    this.manifest.logFile = this.scopeId
      ? `logs/${this.scopeId}/pipeline-${ts}.log`
      : `logs/pipeline-${ts}.log`;
    writeRunManifest(this.groupDir, this.manifest);
    const pipelineLogStream = fs.createWriteStream(pipelineLogFile);
    pipelineLogStream.write(
      `=== Pipeline Log ===\n` +
        `Started: ${new Date().toISOString()}\n` +
        `Group: ${this.group.name}\n` +
        `Stages: ${stageNames}\n\n`,
    );

    // Build stage config lookup
    const stagesByName = new Map<string, PipelineStage>();
    for (const s of this.config.stages) {
      stagesByName.set(s.name, s);
    }

    const planSuffix = planContent ? `\n\n## Plan\n\n${planContent}` : '';
    return { planContent: planSuffix, stagesByName, pipelineLogStream };
  }

  /**
   * Normalize transition.next to an array of target names (empty for pipeline end).
   */
  private static nextTargets(
    next: string | string[] | null | undefined,
  ): string[] {
    if (next == null) return [];
    return Array.isArray(next) ? next : [next];
  }

  /**
   * Build predecessor map: for each stage, which stages have non-retry
   * transitions pointing to it?
   */
  private buildPredecessorMap(): Map<string, Set<string>> {
    const predecessors = new Map<string, Set<string>>();
    for (const s of this.config.stages) {
      // Only the first transition (primary/success path) contributes to the
      // predecessor map. Error/fallback transitions listed after the primary
      // one do not gate fan-in.
      const primary = s.transitions[0];
      if (!primary) continue;
      for (const target of PipelineRunner.nextTargets(primary.next)) {
        let set = predecessors.get(target);
        if (!set) {
          set = new Set();
          predecessors.set(target, set);
        }
        set.add(s.name);
      }
    }
    return predecessors;
  }

  /**
   * Check if a stage's fan-in gate is satisfied:
   * all predecessors must appear in completedStages.
   */
  /**
   * Execute a stitch operation, mutating this.config to include the inserted
   * stages and returning the new host transition target (single name or an
   * array for parallel stitch).
   */
  private performStitch(
    stageConfig: PipelineStage,
    transitionIdx: number,
    templateName: string,
    directive: StitchDirective,
  ): {
    insertedStages: PipelineStage[];
    newNext: string | string[];
  } {
    if (transitionIdx < 0) {
      throw new Error(
        `Host transition for "${stageConfig.name}" not found in stage config`,
      );
    }
    const template = loadPipelineTemplate(this.groupDir, templateName);
    if (directive.mode === 'parallel') {
      const r = stitchParallel({
        config: this.config,
        originStage: stageConfig.name,
        originTransitionIdx: transitionIdx,
        template,
        count: directive.count,
        perCopySubstitutions: directive.perCopySubs,
      });
      this.config = r.updatedConfig;
      logger.info(
        {
          origin: stageConfig.name,
          template: templateName,
          insertId: r.insertId,
          count: directive.count,
          subs: directive.perCopySubs !== undefined,
        },
        'Stitch (parallel) applied',
      );
      return { insertedStages: r.insertedStages, newNext: r.entryNames };
    }
    const r = stitchSingle({
      config: this.config,
      originStage: stageConfig.name,
      originTransitionIdx: transitionIdx,
      template,
      substitutions: directive.subs,
    });
    this.config = r.updatedConfig;
    logger.info(
      {
        origin: stageConfig.name,
        template: templateName,
        insertId: r.insertId,
        subs: directive.subs !== undefined,
      },
      'Stitch (single) applied',
    );
    return { insertedStages: r.insertedStages, newNext: r.entryName };
  }

  private static fanInReady(
    stageName: string,
    predecessors: Map<string, Set<string>>,
    completedStages: string[],
  ): boolean {
    const preds = predecessors.get(stageName);
    if (!preds || preds.size <= 1) return true;
    const completed = new Set(completedStages);
    for (const pred of preds) {
      if (!completed.has(pred)) return false;
    }
    return true;
  }

  /**
   * Determine entry stage and resume from previous state if applicable.
   */
  private async resolveEntryStage(
    stagesByName: Map<string, PipelineStage>,
  ): Promise<{
    initialStages: string[];
    completedStages: string[];
    activations: Map<string, number>;
    completions: Map<string, number>;
  }> {
    // Determine entry stage: explicit > heuristic (prefer nodes with outgoing edges) > stages[0]
    const resolveEntry = (): string => {
      if (this.config.entryStage && stagesByName.has(this.config.entryStage)) {
        return this.config.entryStage;
      }
      const hasIncoming = new Set<string>();
      const hasOutgoing = new Set<string>();
      for (const s of this.config.stages) {
        for (const t of s.transitions) {
          const targets = PipelineRunner.nextTargets(t.next);
          if (targets.length > 0) {
            hasOutgoing.add(s.name);
            for (const target of targets) hasIncoming.add(target);
          }
        }
      }
      const preferred = this.config.stages.find(
        (s) => !hasIncoming.has(s.name) && hasOutgoing.has(s.name),
      );
      if (preferred) return preferred.name;
      const fallback = this.config.stages.find((s) => !hasIncoming.has(s.name));
      if (fallback) return fallback.name;
      return this.config.stages[0].name;
    };

    // Resume from last completed stage if pipeline was interrupted
    const existingState = loadPipelineState(
      this.groupDir,
      this.pipelineTag,
      this.scopeId,
    );
    if (
      existingState &&
      existingState.status !== 'success' &&
      existingState.completedStages.length > 0
    ) {
      const completedStages = [...existingState.completedStages];
      // Resume from currentStage directly — it captures exactly what was
      // running at interruption, handling cyclic and fan-out cases correctly.
      let initialStages: string[];
      if (existingState.currentStage) {
        const current = Array.isArray(existingState.currentStage)
          ? existingState.currentStage
          : [existingState.currentStage];
        initialStages = current
          .flatMap((name) => {
            if (!stagesByName.has(name)) return [];
            if (!completedStages.includes(name)) return [name];
            const stage = stagesByName.get(name)!;
            const primary = stage.transitions[0];
            return primary ? PipelineRunner.nextTargets(primary.next) : [];
          })
          .filter((s, index, items) => items.indexOf(s) === index)
          .filter((s) => stagesByName.has(s));
      } else {
        initialStages = [];
      }
      if (initialStages.length === 0) {
        initialStages = [resolveEntry()];
      }
      await this.notifyBanner(
        `🔄 Resuming from ${initialStages.join(', ')} (previously completed: ${existingState.completedStages.join(' → ')})`,
      );
      // Restore activation/completion counts from persisted state
      const activations = new Map(
        Object.entries(existingState.activations ?? {}),
      );
      const completions = new Map(
        Object.entries(existingState.completions ?? {}),
      );
      // Restore dynamically-inserted stages (from earlier stitch operations)
      if (
        existingState.insertedStages &&
        existingState.insertedStages.length > 0
      ) {
        this.config = {
          ...this.config,
          stages: [...this.config.stages, ...existingState.insertedStages],
        };
        // baseStageCount already reflects the pre-resume count; don't update
      }
      return { initialStages, completedStages, activations, completions };
    }

    return {
      initialStages: [resolveEntry()],
      completedStages: [],
      activations: new Map(),
      completions: new Map(),
    };
  }

  /**
   * Handle stage result: no-match → retry prompt, retry → re-send,
   * transition → close container and advance FSM.
   */
  private async handleStageResult(
    result: StageMarkerResult,
    ctx: {
      handle: StageHandle;
      stageConfig: PipelineStage;
      currentStageName: string;
      turnCount: number;
      stageStartTime: number;
      completedStages: string[];
      commonRules: string;
      planContent: string;
      stagesByName: Map<string, PipelineStage>;
      containerRespawnCount: number;
      maxContainerRespawns: number;
    },
  ): Promise<{
    stageResolved: boolean;
    nextStageName: string | string[] | null;
    nextInitialPrompt: string | null;
    nextEphemeralSystemPrompt?: string | null;
    lastResult: 'success' | 'error' | null;
  }> {
    const { matched, payload } = result;
    const {
      handle,
      stageConfig,
      currentStageName,
      turnCount,
      stageStartTime,
      completedStages,
      commonRules,
      planContent,
      stagesByName,
    } = ctx;

    if (!matched) {
      if (stageConfig.chat) {
        // Chatting stage: read user input and send to container
        const userInput = await readUserInput('\n> ');
        handle.pendingResult = createDeferred();
        sendToStage(handle, userInput);
        return {
          stageResolved: false,
          nextStageName: null,
          nextInitialPrompt: null,
          lastResult: null,
        };
      }

      // No markers found — retry (autonomous mode)
      logger.warn(
        { stage: currentStageName, turn: turnCount },
        'No stage markers found',
      );
      handle.pendingResult = createDeferred();
      sendToStage(
        handle,
        `No stage markers found in the previous response. Continue working and emit the appropriate marker when done.\n\n${stageConfig.prompt}\n${commonRules}`,
      );
      return {
        stageResolved: false,
        nextStageName: null,
        nextInitialPrompt: null,
        lastResult: null,
      };
    }

    // Synthetic container exit/error — container is dead, must respawn in place.
    if (matched.marker.startsWith('_CONTAINER')) {
      const errorDesc = payload || matched.marker;
      await this.notify(
        `⚠️ [Turn ${turnCount}] ${currentStageName} error: ${errorDesc}`,
      );
      if (ctx.containerRespawnCount >= ctx.maxContainerRespawns) {
        await this.notify(
          `❌ [Turn ${turnCount}] ${currentStageName} container respawn limit exceeded (${ctx.maxContainerRespawns}) — stage failed`,
        );
        return {
          stageResolved: true,
          nextStageName: null,
          nextInitialPrompt: null,
          lastResult: 'error',
        };
      }
      await this.notify(
        `🔄 [Turn ${turnCount}] ${currentStageName} container respawn (${ctx.containerRespawnCount + 1}/${ctx.maxContainerRespawns})...`,
      );
      return {
        stageResolved: true,
        nextStageName: currentStageName,
        nextInitialPrompt: `The container exited abnormally in the previous attempt: ${errorDesc}\n\nPlease retry.\n\n${stageConfig.prompt}\n${commonRules}${planContent}`,
        lastResult: null,
      };
    }

    // Regular transition — move to next stage or end pipeline. When
    // `template` is set, stitch the template into the graph in place and
    // route to its entry/barrier. Otherwise `next` is either a scope-local
    // stage name, null (pipeline end), or a runtime-injected string[] from
    // a parallel-stitch barrier fan-out.
    let targetName: string | string[] | null = matched.next ?? null;
    if (matched.template) {
      try {
        const directive = resolveStitchInputs(matched, payload);
        const transitionIdx = stageConfig.transitions.indexOf(matched);
        const stitched = this.performStitch(
          stageConfig,
          transitionIdx,
          matched.template,
          directive,
        );
        for (const s of stitched.insertedStages) {
          stagesByName.set(s.name, s);
        }
        targetName = stitched.newNext;
        await this.notifyBanner(
          `🧵 Stitched template "${matched.template}" after ${currentStageName} — inserted ${stitched.insertedStages.length} stage(s)`,
        );
      } catch (err) {
        logger.error(
          { stage: currentStageName, template: matched.template, err },
          'Stitch failed',
        );
        await this.notifyBanner(
          `❌ ${currentStageName}: stitch of "${matched.template}" failed — ${(err as Error).message}`,
        );
        return {
          stageResolved: true,
          nextStageName: null,
          nextInitialPrompt: null,
          lastResult: 'error',
        };
      }
    }

    const targetDisplay = Array.isArray(targetName)
      ? targetName.join(', ')
      : targetName;
    const isErrorTransition = matched.marker.includes('ERROR');
    if (isErrorTransition) {
      await this.notifyBanner(
        targetDisplay
          ? `⚠️ Warning: ${payload || matched.marker}\n🔄 Returning to ${targetDisplay}`
          : `⚠️ Warning: ${payload || matched.marker}`,
      );
    } else {
      await this.notifyBanner(
        targetDisplay
          ? `✅ ${currentStageName} → ${targetDisplay} (${matched.marker})`
          : `✅ ${currentStageName} completed! (${matched.marker})`,
      );
    }

    // Track completed stage
    completedStages.push(currentStageName);
    this.manifest.stages.push({
      name: currentStageName,
      status: isErrorTransition ? 'error' : 'success',
      duration: Date.now() - stageStartTime,
    });
    writeRunManifest(this.groupDir, this.manifest);
    savePipelineState(
      this.groupDir,
      {
        currentStage: targetName,
        completedStages,
        lastUpdated: new Date().toISOString(),
        status: 'running',
      },
      this.pipelineTag,
      this.scopeId,
    );

    // Close the container first, then retrieve session ID
    await this.closeAndWait(handle);
    const containerResult = await handle.containerPromise;
    if (containerResult.newSessionId) {
      this.stageSessionIds.set(currentStageName, containerResult.newSessionId);
    }
    this.activeHandles.delete(currentStageName);

    // Payload forwarding for single-target transitions.
    //   - Target has a resumed session (re-entry) → send payload via ephemeral
    //     system-prompt append so it does NOT persist in the transcript.
    //   - Target is entering fresh → bundle payload into the initial user
    //     prompt like before (no session to pollute).
    let nextInitialPrompt: string | null = null;
    let nextEphemeralSystemPrompt: string | null = null;
    const targets = PipelineRunner.nextTargets(targetName);
    if (targets.length === 1 && payload) {
      const targetConfig = stagesByName.get(targets[0]);
      const targetRules = targetConfig
        ? this.buildCommonRules(targetConfig)
        : commonRules;
      const isResumedTarget =
        targetConfig?.resumeSession !== false &&
        this.stageSessionIds.has(targets[0]);
      if (isResumedTarget) {
        nextEphemeralSystemPrompt = `Forwarded from previous stage (${currentStageName}):\n\n${payload}`;
      } else {
        nextInitialPrompt = `Forwarded from previous stage (${currentStageName}):\n\n${payload}\n\n${targetConfig?.prompt || ''}\n${targetRules}${planContent}`;
      }
    }

    return {
      stageResolved: true,
      nextStageName: targetName,
      nextInitialPrompt,
      nextEphemeralSystemPrompt,
      // Terminal transition: an ERROR marker ends the pipeline with 'error',
      // any other marker ends it with 'success'. Non-terminal transitions
      // leave the result undetermined until a later stage decides.
      lastResult:
        targets.length === 0 ? (isErrorTransition ? 'error' : 'success') : null,
    };
  }

  /**
   * Save final pipeline state, close manifest and log stream.
   */
  private async finalizeRun(
    completedStages: string[],
    lastResult: 'success' | 'error',
    pipelineLogStream: fs.WriteStream,
  ): Promise<void> {
    savePipelineState(
      this.groupDir,
      {
        currentStage: null,
        completedStages,
        lastUpdated: new Date().toISOString(),
        status: lastResult,
      },
      this.pipelineTag,
      this.scopeId,
    );

    this.manifest.endTime = new Date().toISOString();
    this.manifest.status = lastResult;
    writeRunManifest(this.groupDir, this.manifest);

    pipelineLogStream.write(
      `\n=== Pipeline ${lastResult === 'success' ? 'completed' : 'failed'}: ${new Date().toISOString()} ===\n`,
    );
    pipelineLogStream.end();

    await this.notifyBanner(
      lastResult === 'success'
        ? '🏁 Pipeline completed!'
        : '❌ Pipeline terminated with errors.',
    );
  }

  /**
   * Run a single stage to completion (spawn → turn loop → close).
   * Self-contained: handles retries and container respawns internally.
   */
  private async runSingleStage(
    stageName: string,
    stagesByName: Map<string, PipelineStage>,
    completedStages: string[],
    planContent: string,
    pipelineLogStream: fs.WriteStream,
    initialPromptOverride?: string | null,
    ephemeralSystemPromptOverride?: string | null,
  ): Promise<{
    stageName: string;
    nextStages: string | string[] | null;
    nextInitialPrompt: string | null;
    nextEphemeralSystemPrompt: string | null;
    result: 'success' | 'error' | null;
  }> {
    const stageConfig = stagesByName.get(stageName);
    if (!stageConfig) {
      logger.error({ stage: stageName }, 'Stage config not found');
      return {
        stageName,
        nextStages: null,
        nextInitialPrompt: null,
        nextEphemeralSystemPrompt: null,
        result: 'error',
      };
    }

    // Exclusive lock: wait for shared resource
    let exclusiveLock: ExclusiveLock | null = null;
    if (stageConfig.exclusive) {
      exclusiveLock = getExclusiveLock(stageConfig.exclusive);
      logger.info(
        { stage: stageName, key: stageConfig.exclusive },
        'Waiting for exclusive lock',
      );
      await this.notify(
        `🔒 ${stageName}: waiting (${stageConfig.exclusive} lock)...`,
      );
      await exclusiveLock.acquire();
      logger.info(
        { stage: stageName, key: stageConfig.exclusive },
        'Exclusive lock acquired',
      );
    }

    let nextStages: string | string[] | null = null;
    let stageResult: 'success' | 'error' | null = null;
    let outNextInitialPrompt: string | null = null;
    let outNextEphemeralSystemPrompt: string | null = null;

    try {
      const commonRules = this.buildCommonRules(stageConfig);
      let nextInitialPrompt: string | null = initialPromptOverride ?? null;
      // Ephemeral system-prompt append consumed only by the next spawn in this stage.
      // Used when re-entering a resumed stage with a handoff payload from a predecessor.
      let nextEphemeralSystemPrompt: string | null =
        ephemeralSystemPromptOverride ?? null;
      let containerRespawnCount = 0;
      const MAX_CONTAINER_RESPAWNS = 3;
      let turnCount = 0;
      let currentStage: string | null = stageName;

      while (currentStage === stageName) {
        if (this.aborted) {
          stageResult = 'error';
          break;
        }

        const resolvedStagePrompt = resolveStagePrompt(stageConfig);
        const initialPrompt =
          nextInitialPrompt ||
          `${resolvedStagePrompt.text}\n${commonRules}${planContent}`;
        nextInitialPrompt = null;
        const ephemeralForSpawn = nextEphemeralSystemPrompt ?? undefined;
        nextEphemeralSystemPrompt = null;

        const stageStartTime = Date.now();
        const handle = this.spawnStageContainer(
          stageConfig,
          initialPrompt,
          pipelineLogStream,
          ephemeralForSpawn,
        );
        this.activeHandles.set(stageName, handle);

        logger.info(
          {
            stage: stageName,
            promptIds: resolvedStagePrompt.promptIds,
            promptHash: resolvedStagePrompt.promptHash,
          },
          'Stage container spawned (on-demand)',
        );
        logger.info({ stage: stageName }, 'Entering stage');
        await this.notifyBanner(`📌 Stage: ${stageName} starting`);

        let isFirstTurn = true;
        let stageResolved = false;

        while (!stageResolved) {
          turnCount++;

          if (!handle.pendingResult) {
            handle.pendingResult = createDeferred();
          }

          if (!isFirstTurn) {
            const prompt = `${resolvedStagePrompt.text}\n${commonRules}${planContent}`;
            sendToStage(handle, prompt);
          }
          isFirstTurn = false;

          logger.debug(
            { stage: stageName, turn: turnCount },
            'Waiting for stage result',
          );
          await this.notify(
            `🔧 [Turn ${turnCount}] ${stageName} in progress...`,
          );

          const result = await handle.pendingResult.promise;
          handle.pendingResult = null;

          logger.info(
            { stage: stageName, turn: turnCount, result },
            'Stage result received',
          );

          const outcome = await this.handleStageResult(result, {
            handle,
            stageConfig,
            currentStageName: stageName,
            turnCount,
            stageStartTime,
            completedStages,
            commonRules,
            planContent,
            stagesByName,
            containerRespawnCount,
            maxContainerRespawns: MAX_CONTAINER_RESPAWNS,
          });

          stageResolved = outcome.stageResolved;
          if (outcome.stageResolved) {
            if (outcome.nextStageName === stageName) {
              // Container respawn — loop again with same stage
              containerRespawnCount++;
              nextInitialPrompt = outcome.nextInitialPrompt;
              nextEphemeralSystemPrompt =
                outcome.nextEphemeralSystemPrompt ?? null;
              currentStage = stageName; // stay in outer while
            } else {
              // Advance to next stage(s) or end
              nextStages = outcome.nextStageName;
              outNextInitialPrompt = outcome.nextInitialPrompt;
              outNextEphemeralSystemPrompt =
                outcome.nextEphemeralSystemPrompt ?? null;
              currentStage = null; // exit outer while
              if (outcome.lastResult) {
                stageResult = outcome.lastResult;
              }
            }
          }
        }
      }
    } finally {
      this.activeHandles.delete(stageName);
      if (exclusiveLock) {
        exclusiveLock.release();
        logger.info(
          { stage: stageName, key: stageConfig.exclusive },
          'Exclusive lock released',
        );
      }
    }

    return {
      stageName,
      nextStages,
      nextInitialPrompt: outNextInitialPrompt,
      nextEphemeralSystemPrompt: outNextEphemeralSystemPrompt,
      result: stageResult,
    };
  }

  /**
   * Main FSM loop with fan-out/fan-in support.
   * Spawns stage containers on-demand, runs parallel stages concurrently,
   * and gates fan-in stages until all predecessors complete.
   */
  async run(): Promise<'success' | 'error'> {
    const init = await this.initRun();
    if (!init) return 'error';

    const { planContent, stagesByName, pipelineLogStream } = init;
    const { initialStages, completedStages, activations, completions } =
      await this.resolveEntryStage(stagesByName);

    // Track activations for initial stages
    for (const name of initialStages) {
      activations.set(name, (activations.get(name) ?? 0) + 1);
    }

    savePipelineState(
      this.groupDir,
      {
        currentStage:
          initialStages.length === 1 ? initialStages[0] : initialStages,
        completedStages,
        lastUpdated: new Date().toISOString(),
        status: 'running',
        activations: Object.fromEntries(activations),
        completions: Object.fromEntries(completions),
        insertedStages: this.config.stages.slice(this.baseStageCount),
      },
      this.pipelineTag,
      this.scopeId,
    );

    // `predecessors` is recomputed per-call below — stitch may add stages at
    // runtime, so a snapshot taken at run-start would miss barriers and
    // lane-tails from parallel stitches that fire later.
    // Each entry: { name, initialPrompt, ephemeralSystemPrompt }
    // — set when payload forwarding applies (initialPrompt for fresh entries,
    //   ephemeralSystemPrompt for re-entry into a resumed stage).
    let pendingStages: Array<{
      name: string;
      initialPrompt?: string | null;
      ephemeralSystemPrompt?: string | null;
    }> = initialStages.map((name) => ({ name }));
    const waitingForFanIn = new Set<string>();
    let lastResult: 'success' | 'error' = 'success';

    // --- Completion notification queue (replaces Promise.all barrier) ---
    type StageResult = Awaited<ReturnType<PipelineRunner['runSingleStage']>>;
    const resultQueue: StageResult[] = [];
    let notifyResolve: (() => void) | null = null;
    const running = new Set<Promise<void>>();
    const runningNames = new Set<string>();

    const waitForResult = (): Promise<void> => {
      if (resultQueue.length > 0) return Promise.resolve();
      return new Promise<void>((r) => {
        notifyResolve = r;
      });
    };

    const signalResult = (): void => {
      if (notifyResolve) {
        const r = notifyResolve;
        notifyResolve = null;
        r();
      }
    };

    const launchStage = (entry: {
      name: string;
      initialPrompt?: string | null;
      ephemeralSystemPrompt?: string | null;
    }): void => {
      runningNames.add(entry.name);
      const p = this.runSingleStage(
        entry.name,
        stagesByName,
        completedStages,
        planContent,
        pipelineLogStream,
        entry.initialPrompt,
        entry.ephemeralSystemPrompt,
      )
        .then((result) => {
          resultQueue.push(result);
          running.delete(p);
          runningNames.delete(result.stageName);
          signalResult();
        })
        .catch((err) => {
          logger.error({ stage: entry.name, err }, 'Stage threw unexpectedly');
          resultQueue.push({
            stageName: entry.name,
            nextStages: null,
            nextInitialPrompt: null,
            nextEphemeralSystemPrompt: null,
            result: 'error',
          });
          running.delete(p);
          runningNames.delete(entry.name);
          signalResult();
        });
      running.add(p);
    };

    // Helper: check fan-in readiness for a stage. Rebuild predecessors on
    // demand so stitch-inserted stages (especially parallel barriers) see
    // their lane-tails as predecessors.
    const isFanInReady = (stageName: string): boolean => {
      const predecessors = this.buildPredecessorMap();
      return PipelineRunner.fanInReady(
        stageName,
        predecessors,
        completedStages,
      );
    };

    // Helper: launch a stage, deferring chat stages if pool is busy
    const tryLaunch = (entry: {
      name: string;
      initialPrompt?: string | null;
      ephemeralSystemPrompt?: string | null;
    }): void => {
      const cfg = stagesByName.get(entry.name);
      if (cfg?.chat && running.size > 0) {
        // Chat stages need exclusive stdin — defer until pool drains
        pendingStages.push(entry);
        return;
      }
      launchStage(entry);
    };

    // Launch initial stages
    for (const entry of pendingStages) {
      tryLaunch(entry);
    }
    pendingStages = [];

    while (
      running.size > 0 ||
      waitingForFanIn.size > 0 ||
      pendingStages.length > 0
    ) {
      if (this.aborted) break;

      // Launch any deferred pending stages (e.g. chat stages waiting for pool to drain)
      if (pendingStages.length > 0 && running.size === 0) {
        const deferred = [...pendingStages];
        pendingStages = [];
        for (const entry of deferred) {
          tryLaunch(entry);
        }
      }

      // Stuck detection: nothing running, nothing queued, only fan-in waiting
      if (
        running.size === 0 &&
        resultQueue.length === 0 &&
        pendingStages.length === 0
      ) {
        if (waitingForFanIn.size > 0) {
          logger.warn(
            { waiting: [...waitingForFanIn] },
            'Fan-in stages stuck — predecessors did not complete',
          );
          lastResult = 'error';
        }
        break;
      }

      // Save current active stages
      const activeNames = [...runningNames];
      savePipelineState(
        this.groupDir,
        {
          currentStage: activeNames.length === 1 ? activeNames[0] : activeNames,
          completedStages,
          lastUpdated: new Date().toISOString(),
          status: 'running',
          activations: Object.fromEntries(activations),
          completions: Object.fromEntries(completions),
          insertedStages: this.config.stages.slice(this.baseStageCount),
        },
        this.pipelineTag,
        this.scopeId,
      );

      // Wait for at least one stage to complete
      await waitForResult();

      // Drain all available results and launch ready successors immediately
      while (resultQueue.length > 0) {
        const {
          stageName: finishedStage,
          nextStages,
          nextInitialPrompt,
          nextEphemeralSystemPrompt,
          result,
        } = resultQueue.shift()!;

        if (result === 'error') lastResult = 'error';

        // Track completion for dynamic fan-in
        completions.set(
          finishedStage,
          (completions.get(finishedStage) ?? 0) + 1,
        );

        const targets = PipelineRunner.nextTargets(nextStages);
        for (const target of targets) {
          // Skip if already running, queued, or waiting for fan-in
          if (
            runningNames.has(target) ||
            pendingStages.some((s) => s.name === target) ||
            waitingForFanIn.has(target)
          ) {
            continue;
          }
          // Track activation for dynamic fan-in (only when actually queued, not deduped)
          activations.set(target, (activations.get(target) ?? 0) + 1);

          if (isFanInReady(target)) {
            tryLaunch({
              name: target,
              initialPrompt: targets.length === 1 ? nextInitialPrompt : null,
              ephemeralSystemPrompt:
                targets.length === 1 ? nextEphemeralSystemPrompt : null,
            });
          } else {
            waitingForFanIn.add(target);
          }
        }
      }

      // Re-check fan-in gates — a newly completed stage may have unblocked waiters
      for (const w of [...waitingForFanIn]) {
        if (isFanInReady(w)) {
          waitingForFanIn.delete(w);
          tryLaunch({ name: w });
        }
      }
    }

    await this.finalizeRun(completedStages, lastResult, pipelineLogStream);
    return lastResult;
  }
}

/**
 * Load and validate a pipeline config.
 * @param pipelinePath - Absolute path to a pipeline JSON file. When provided,
 *   groupFolder/groupDir are ignored and the file is loaded directly.
 * Returns null if the file doesn't exist.
 */
export function loadPipelineConfig(
  groupFolder: string,
  groupDir?: string,
  pipelinePath?: string,
): PipelineConfig | null {
  const dir = groupDir ?? resolveGroupFolderPath(groupFolder);
  if (!pipelinePath) {
    pipelinePath = path.join(dir, 'PIPELINE.json');
  }

  if (!fs.existsSync(pipelinePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(pipelinePath, 'utf-8');
    const config: PipelineConfig = JSON.parse(raw);
    let mcpRegistry: ExternalMcpRegistry | undefined;

    // Basic validation
    if (!Array.isArray(config.stages) || config.stages.length === 0) {
      logger.warn({ groupFolder }, 'PIPELINE.json has no stages');
      return null;
    }

    // Validate stage names and transitions
    const stageNames = new Set(config.stages.map((s) => s.name));
    for (const stage of config.stages) {
      if (
        stage.kind !== undefined &&
        stage.kind !== 'agent' &&
        stage.kind !== 'command'
      ) {
        logger.error(
          { groupFolder, stage: stage.name, kind: stage.kind },
          'Invalid stage kind (must be "agent" or "command")',
        );
        return null;
      }

      if (
        stage.prompts !== undefined &&
        (!Array.isArray(stage.prompts) ||
          stage.prompts.some((promptId) => typeof promptId !== 'string'))
      ) {
        logger.error(
          { groupFolder, stage: stage.name, prompts: stage.prompts },
          'Invalid prompts field (must be an array of prompt DB ids)',
        );
        return null;
      }

      if (
        stage.prompt_append !== undefined &&
        typeof stage.prompt_append !== 'string'
      ) {
        logger.error(
          {
            groupFolder,
            stage: stage.name,
            prompt_append: stage.prompt_append,
          },
          'Invalid prompt_append field (must be a string)',
        );
        return null;
      }

      if (stage.prompt !== undefined && typeof stage.prompt !== 'string') {
        logger.error(
          { groupFolder, stage: stage.name, prompt: stage.prompt },
          'Invalid prompt field (must be a string)',
        );
        return null;
      }

      if (
        stage.mcpAccess !== undefined &&
        (!Array.isArray(stage.mcpAccess) ||
          stage.mcpAccess.some((ref) => typeof ref !== 'string'))
      ) {
        logger.error(
          { groupFolder, stage: stage.name, mcpAccess: stage.mcpAccess },
          'Invalid mcpAccess field (must be an array of registry ref strings)',
        );
        return null;
      }

      if (
        !stage.command &&
        !stage.prompt &&
        !stage.prompt_append &&
        (!stage.prompts || stage.prompts.length === 0)
      ) {
        logger.error(
          { groupFolder, stage: stage.name },
          'Agent stage must define prompt, prompts, or prompt_append',
        );
        return null;
      }

      if (stage.command && stage.mcpAccess && stage.mcpAccess.length > 0) {
        logger.error(
          { groupFolder, stage: stage.name },
          'Command stages cannot declare mcpAccess',
        );
        return null;
      }

      if (stage.mcpAccess && stage.mcpAccess.length > 0) {
        try {
          mcpRegistry ??= loadMcpRegistry();
          resolveStageMcpServers(stage.mcpAccess, { registry: mcpRegistry });
        } catch (err) {
          logger.error(
            { groupFolder, stage: stage.name, err },
            'Invalid mcpAccess configuration',
          );
          return null;
        }
      }

      if (stage.fan_in !== undefined && stage.fan_in !== 'all') {
        logger.error(
          { groupFolder, stage: stage.name, fan_in: stage.fan_in },
          'Invalid fan_in value (must be "all")',
        );
        return null;
      }

      for (const t of stage.transitions) {
        const tAny = t as unknown as Record<string, unknown>;
        if (tAny.retry !== undefined) {
          logger.error(
            { groupFolder, stage: stage.name, marker: t.marker },
            'Transition "retry" is no longer supported',
          );
          return null;
        }
        if (tAny.next_dynamic !== undefined) {
          logger.error(
            { groupFolder, stage: stage.name, marker: t.marker },
            'Transition "next_dynamic" is no longer supported',
          );
          return null;
        }
        if (Array.isArray(t.next)) {
          logger.error(
            { groupFolder, stage: stage.name, marker: t.marker },
            'Transition "next" must be a string or null — multi-target arrays are produced only by parallel stitch at runtime',
          );
          return null;
        }
        const hasNextString = typeof t.next === 'string';
        const hasTemplate = t.template !== undefined;
        if (hasNextString && hasTemplate) {
          logger.error(
            { groupFolder, stage: stage.name, marker: t.marker },
            'Transition must have either "next" or "template", not both',
          );
          return null;
        }
        if (hasTemplate) {
          if (typeof t.template !== 'string' || t.template.length === 0) {
            logger.error(
              { groupFolder, stage: stage.name, marker: t.marker },
              'Transition "template" must be a non-empty string',
            );
            return null;
          }
        }
        if (t.count !== undefined) {
          if (!Number.isInteger(t.count) || (t.count as number) < 1) {
            logger.error(
              { groupFolder, stage: stage.name, marker: t.marker },
              'Transition "count" must be a positive integer',
            );
            return null;
          }
          if (!hasTemplate) {
            logger.error(
              { groupFolder, stage: stage.name, marker: t.marker },
              'Transition "count" requires "template"',
            );
            return null;
          }
        }
        if (t.countFrom !== undefined) {
          if (t.countFrom !== 'payload') {
            logger.error(
              { groupFolder, stage: stage.name, marker: t.marker },
              'Transition "countFrom" only accepts "payload"',
            );
            return null;
          }
          if (!hasTemplate) {
            logger.error(
              { groupFolder, stage: stage.name, marker: t.marker },
              'Transition "countFrom" requires "template"',
            );
            return null;
          }
          if (t.count !== undefined) {
            logger.error(
              { groupFolder, stage: stage.name, marker: t.marker },
              'Transition must have either "count" or "countFrom", not both',
            );
            return null;
          }
        }
        if (t.substitutionsFrom !== undefined) {
          if (t.substitutionsFrom !== 'payload') {
            logger.error(
              { groupFolder, stage: stage.name, marker: t.marker },
              'Transition "substitutionsFrom" only accepts "payload"',
            );
            return null;
          }
          if (t.countFrom !== 'payload') {
            logger.error(
              { groupFolder, stage: stage.name, marker: t.marker },
              'Transition "substitutionsFrom" requires "countFrom: \\"payload\\""',
            );
            return null;
          }
        }
        if (hasNextString && !stageNames.has(t.next as string)) {
          logger.error(
            { groupFolder, stage: stage.name, target: t.next },
            'Transition "next" must reference an existing stage in this pipeline (use "template" for templates)',
          );
          return null;
        }
      }
    }

    try {
      assertConfigAcyclic(config);
    } catch (err) {
      logger.error(
        { groupFolder, err: (err as Error).message },
        'PIPELINE.json contains a cycle — pipelines must be DAGs',
      );
      return null;
    }

    return config;
  } catch (err) {
    logger.error({ groupFolder, err }, 'Failed to parse PIPELINE.json');
    return null;
  }
}
