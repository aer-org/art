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
import {
  applyFanoutSubstitutions,
  assertFanoutDepthAllowed,
  deriveChildScopeId,
  loadFanoutTemplate,
  parseFanoutPayload,
  withConcurrency,
} from './fanout.js';
import { AdditionalMount, RegisteredGroup } from './types.js';

function resolveProvider(): 'claude' | 'codex' {
  return process.env.ART_AGENT_PROVIDER === 'codex' ? 'codex' : 'claude';
}

// --- Pipeline JSON Schema ---

export interface PipelineTransition {
  marker: string; // Marker name (e.g. "STAGE_COMPLETE")
  next?: string | string[] | null; // Target stage(s) (null = pipeline end, array = fan-out)
  next_dynamic?: boolean; // Agent picks targets at runtime via marker payload; next becomes allowlist
  retry?: boolean; // true = retry current stage (error tracking applies)
  prompt?: string; // Description for the agent on when to use this marker
}

export type StageKind = 'agent' | 'command' | 'dynamic-fanout';

export interface FanoutSubstitution {
  fields: string[]; // Stage fields where {{key}} substitution applies (e.g. ["prompt", "mounts"])
}

export interface PipelineStage {
  name: string;
  kind?: StageKind; // Explicit stage kind. Default: inferred (command if `command` set, else agent).
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
  fan_in?: 'all' | 'dynamic'; // Fan-in mode: "all" (default) waits for all predecessors; "dynamic" waits only for activated ones
  transitions: PipelineTransition[];

  // --- dynamic-fanout stage only ---
  template?: string; // Path to child pipeline template JSON (relative to groupDir)
  inputFrom?: 'payload'; // Source of fanout inputs (only "payload" for now)
  substitutions?: FanoutSubstitution; // Template fields that accept {{key}} substitution
  concurrency?: number; // Max concurrent child runners; undefined = unbounded
  failurePolicy?: 'all-success'; // Only "all-success" supported initially
}

/**
 * Resolve the effective stage kind — explicit `kind` wins, otherwise infer
 * from presence of `command`. "dynamic-fanout" must be explicit.
 */
export function resolveStageKind(stage: PipelineStage): StageKind {
  if (stage.kind) return stage.kind;
  return stage.command ? 'command' : 'agent';
}

export interface PipelineConfig {
  stages: PipelineStage[];
  entryStage?: string;
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
  currentStage: string | string[] | null;
  completedStages: string[];
  lastUpdated: string;
  status: 'running' | 'error' | 'success';
  activations?: Record<string, number>; // Per-stage activation count (for dynamic fan-in)
  completions?: Record<string, number>; // Per-stage completion count (for dynamic fan-in)
  pendingFanoutPayloads?: Record<string, string>; // Per-target payload awaiting a dynamic-fanout launch
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
  atomicWrite(filepath, JSON.stringify(state, null, 2));
}

export function loadPipelineState(
  groupDir: string,
  tag?: string,
  scopeId?: string,
): PipelineState | null {
  const filepath = path.join(groupDir, pipelineStateFileName(tag, scopeId));
  try {
    const raw = fs.readFileSync(filepath, 'utf-8');
    return JSON.parse(raw) as PipelineState;
  } catch {
    return null;
  }
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
      return { matched: transition, payload: fencedMatch[1] };
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
  private pendingFanoutPayloads = new Map<string, string>();
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
                    retry: true,
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
              retry: true,
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
        handle.pendingResult.resolve({
          matched: transition ?? {
            marker: isSuccess ? 'STAGE_COMPLETE' : 'STAGE_ERROR',
            next: null,
          },
          payload,
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
      if (t.retry) {
        return `- ${desc} → [${t.marker}: brief description]`;
      }
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
      // Only the first non-retry, non-dynamic transition (primary/success path)
      // contributes to the predecessor map. Error/fallback transitions listed
      // after the primary one create backward edges (child→parent) that must
      // not gate fan-in — otherwise a re-entry from an eval/dynamic source
      // gets blocked by its own downstream stage's pending work.
      const primary = s.transitions.find((t) => !t.retry && !t.next_dynamic);
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
   * Build reachability map: for each stage, which stages can it
   * transitively reach through the pipeline's transition graph?
   * Used by dynamic fan-in to determine if an unactivated predecessor
   * could still be activated by a currently-alive stage.
   */
  private buildReachabilityMap(): Map<string, Set<string>> {
    // Build adjacency list from all transitions with `next` targets
    const adj = new Map<string, Set<string>>();
    for (const s of this.config.stages) {
      if (!adj.has(s.name)) adj.set(s.name, new Set());
      for (const t of s.transitions) {
        if (t.retry && !t.next) continue;
        for (const target of PipelineRunner.nextTargets(t.next)) {
          adj.get(s.name)!.add(target);
        }
      }
    }
    // BFS transitive closure per stage
    const reachability = new Map<string, Set<string>>();
    for (const s of this.config.stages) {
      const reachable = new Set<string>();
      const queue = [...(adj.get(s.name) ?? [])];
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (reachable.has(current)) continue;
        reachable.add(current);
        for (const next of adj.get(current) ?? []) {
          if (!reachable.has(next)) queue.push(next);
        }
      }
      reachability.set(s.name, reachable);
    }
    return reachability;
  }

  /**
   * Check if a stage's fan-in gate is satisfied:
   * all predecessors must appear in completedStages.
   */
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
   * Check if a stage's dynamic fan-in gate is satisfied:
   * only predecessors that have been activated are checked.
   * A predecessor is "done" if its completion count matches its activation count.
   *
   * An unactivated predecessor (activation=0) is only skipped if no alive
   * stage can transitively reach it. If any alive stage could still activate
   * the predecessor via retry/error paths, the gate stays closed.
   */
  private static fanInReadyDynamic(
    stageName: string,
    predecessors: Map<string, Set<string>>,
    activations: Map<string, number>,
    completions: Map<string, number>,
    reachability: Map<string, Set<string>>,
    aliveStages: Set<string>,
  ): boolean {
    const preds = predecessors.get(stageName);
    if (!preds || preds.size <= 1) return true;

    let anyActivated = false;
    for (const pred of preds) {
      const act = activations.get(pred) ?? 0;
      if (act === 0) {
        // Never activated — but could it still be activated?
        // Check if any alive stage can transitively reach this predecessor.
        for (const alive of aliveStages) {
          if (reachability.get(alive)?.has(pred)) {
            return false; // alive stage can still reach this predecessor — wait
          }
        }
        continue; // no alive stage can reach it — safe to skip
      }
      anyActivated = true;
      const comp = completions.get(pred) ?? 0;
      if (comp < act) return false; // activated but not yet completed
    }
    return anyActivated; // at least one predecessor must have been activated
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
          if (t.retry) continue;
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
      const loopFallback = this.config.stages.find((s) =>
        hasOutgoing.has(s.name),
      );
      if (loopFallback) return loopFallback.name;
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
            const primary = stage.transitions.find((t) => !t.retry);
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
      // Restore pending fanout payloads so resumed fanout stages have inputs
      if (existingState.pendingFanoutPayloads) {
        for (const [k, v] of Object.entries(
          existingState.pendingFanoutPayloads,
        )) {
          this.pendingFanoutPayloads.set(k, v);
        }
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

    if (matched.retry) {
      const errorDesc = payload || matched.marker;
      await this.notify(
        `⚠️ [Turn ${turnCount}] ${currentStageName} error: ${errorDesc}`,
      );

      // Synthetic container exit/error — container is dead, must respawn
      if (matched.marker.startsWith('_CONTAINER')) {
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

      // Normal retry — container is still alive, re-send prompt via IPC
      handle.pendingResult = createDeferred();
      sendToStage(
        handle,
        `An error occurred in the previous attempt: ${errorDesc}\n\nPlease retry.\n\n${stageConfig.prompt}\n${commonRules}${planContent}`,
      );
      return {
        stageResolved: false,
        nextStageName: null,
        nextInitialPrompt: null,
        lastResult: null,
      };
    }

    // Non-retry transition — move to next stage(s) or end pipeline
    let targetName: string | string[] | null;
    if (matched.next_dynamic && payload) {
      // Dynamic transition: agent picks targets from payload
      const requested = payload
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const allowlist = new Set(PipelineRunner.nextTargets(matched.next));
      const invalid = requested.filter((t) => !allowlist.has(t));
      if (invalid.length > 0) {
        logger.error(
          { stage: currentStageName, invalid, allowlist: [...allowlist] },
          'Dynamic transition target not in allowlist',
        );
        await this.notifyBanner(
          `❌ ${currentStageName}: dynamic transition target not in allowlist: ${invalid.join(', ')}`,
        );
        return {
          stageResolved: true,
          nextStageName: null,
          nextInitialPrompt: null,
          lastResult: 'error',
        };
      }
      targetName =
        requested.length === 0
          ? (matched.next ?? null) // empty payload → fallback to static next
          : requested.length === 1
            ? requested[0]
            : requested;
    } else {
      targetName = matched.next ?? null;
    }

    // Stash payload for any dynamic-fanout target. Only single-target,
    // non-next_dynamic transitions forward payload downstream.
    if (payload && !matched.next_dynamic) {
      for (const t of PipelineRunner.nextTargets(targetName)) {
        const targetCfg = stagesByName.get(t);
        if (targetCfg && resolveStageKind(targetCfg) === 'dynamic-fanout') {
          this.pendingFanoutPayloads.set(t, payload);
        }
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

    // Payload forwarding only works for single-target non-dynamic transitions
    // (dynamic payloads contain target names, not content to forward).
    //
    // Routing rule:
    //   - Target has a resumed session (re-entry) → send payload via ephemeral
    //     system-prompt append so it does NOT persist in the transcript.
    //   - Target is entering fresh → bundle payload into the initial user
    //     prompt like before (no session to pollute).
    let nextInitialPrompt: string | null = null;
    let nextEphemeralSystemPrompt: string | null = null;
    const targets = PipelineRunner.nextTargets(targetName);
    if (targets.length === 1 && payload && !matched.next_dynamic) {
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
      lastResult: targets.length === 0 ? 'success' : null,
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

    if (resolveStageKind(stageConfig) === 'dynamic-fanout') {
      return this.runFanoutStage(stageConfig, pipelineLogStream);
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
   * Execute a dynamic-fanout stage: spawn N child PipelineRunner instances in
   * parallel, one per element of the payload forwarded by the preceding stage.
   *
   * All children run fully isolated via distinct scopeIds. Policy: wait for all
   * children to settle before returning, then fail if any child failed
   * ("all-success" failure policy). Recursion depth is capped via the
   * ART_FANOUT_DEPTH env variable.
   */
  private async runFanoutStage(
    stageConfig: PipelineStage,
    pipelineLogStream: fs.WriteStream,
  ): Promise<{
    stageName: string;
    nextStages: string | string[] | null;
    nextInitialPrompt: string | null;
    nextEphemeralSystemPrompt: string | null;
    result: 'success' | 'error' | null;
  }> {
    const stageName = stageConfig.name;
    await this.notifyBanner(`🌱 Stage: ${stageName} (dynamic-fanout)`);

    const stageResultOnError = (err: unknown) => {
      logger.error({ stage: stageName, err }, 'dynamic-fanout stage failed');
      pipelineLogStream.write(
        `[${stageName}] dynamic-fanout failed: ${(err as Error).message || String(err)}\n`,
      );
      return {
        stageName,
        nextStages: this.pickFanoutTransition(stageConfig, false),
        nextInitialPrompt: null,
        nextEphemeralSystemPrompt: null,
        result: 'error' as const,
      };
    };

    let childDepth: number;
    try {
      childDepth = assertFanoutDepthAllowed(stageName);
    } catch (err) {
      return stageResultOnError(err);
    }

    const payload = this.pendingFanoutPayloads.get(stageName);
    this.pendingFanoutPayloads.delete(stageName);
    if (!payload) {
      return stageResultOnError(
        new Error(
          `dynamic-fanout "${stageName}": no payload forwarded from predecessor (preceding stage must emit a STAGE_COMPLETE with a JSON array payload)`,
        ),
      );
    }

    let inputs;
    try {
      inputs = parseFanoutPayload(payload, stageName);
    } catch (err) {
      return stageResultOnError(err);
    }

    if (inputs.length === 0) {
      // Zero-element fanout: nothing to spawn, emit success immediately.
      await this.notifyBanner(
        `🌱 ${stageName}: 0 child pipelines (empty payload)`,
      );
      return {
        stageName,
        nextStages: this.pickFanoutTransition(stageConfig, true),
        nextInitialPrompt: null,
        nextEphemeralSystemPrompt: null,
        result: 'success',
      };
    }

    let template;
    try {
      template = loadFanoutTemplate(
        this.groupDir,
        stageConfig.template!,
        stageName,
      );
    } catch (err) {
      return stageResultOnError(err);
    }

    const allowedFields = stageConfig.substitutions?.fields ?? [];
    await this.notifyBanner(
      `🌱 ${stageName}: spawning ${inputs.length} child pipeline(s)` +
        (stageConfig.concurrency
          ? ` (concurrency ${stageConfig.concurrency})`
          : ''),
    );

    const prevDepthEnv = process.env.ART_FANOUT_DEPTH;
    process.env.ART_FANOUT_DEPTH = String(childDepth);

    const childResults: Array<'success' | 'error'> = new Array(inputs.length);
    let anyFailure = false;

    try {
      const tasks = inputs.map((input, idx) => async () => {
        const childScope = deriveChildScopeId(this.scopeId, stageName, idx);
        const substituted = applyFanoutSubstitutions(
          template!,
          input,
          allowedFields,
          stageName,
        );

        // Child-scoped state from a previous (interrupted) run is discarded.
        // TODO: support scope-aware child resume instead of always restarting.
        const staleStatePath = path.join(
          this.groupDir,
          `PIPELINE_STATE.${childScope}.json`,
        );
        try {
          fs.rmSync(staleStatePath, { force: true });
        } catch {
          /* ignore */
        }

        try {
          const child = new PipelineRunner(
            this.group,
            this.chatJid,
            substituted,
            this.notify,
            this.onProcess,
            this.groupDir,
            undefined,
            undefined,
            childScope,
          );
          const result = await child.run();
          childResults[idx] = result;
          if (result === 'error') anyFailure = true;
        } catch (err) {
          logger.error(
            { stage: stageName, idx, childScope, err },
            'dynamic-fanout child threw',
          );
          childResults[idx] = 'error';
          anyFailure = true;
        }
      });

      await withConcurrency(stageConfig.concurrency, tasks);
    } finally {
      if (prevDepthEnv === undefined) delete process.env.ART_FANOUT_DEPTH;
      else process.env.ART_FANOUT_DEPTH = prevDepthEnv;
    }

    const succeeded = childResults.filter((r) => r === 'success').length;
    const failed = childResults.length - succeeded;
    await this.notifyBanner(
      `🌱 ${stageName}: fanout complete — ${succeeded} succeeded, ${failed} failed`,
    );

    if (anyFailure) {
      return {
        stageName,
        nextStages: this.pickFanoutTransition(stageConfig, false),
        nextInitialPrompt: null,
        nextEphemeralSystemPrompt: null,
        result: 'error',
      };
    }

    return {
      stageName,
      nextStages: this.pickFanoutTransition(stageConfig, true),
      nextInitialPrompt: null,
      nextEphemeralSystemPrompt: null,
      result: 'success',
    };
  }

  /**
   * Pick the transition target for a dynamic-fanout stage based on outcome.
   * Convention: marker containing "ERROR" → error path; otherwise → success path.
   * Retry transitions are ignored (fanout stages don't retry).
   */
  private pickFanoutTransition(
    stageConfig: PipelineStage,
    success: boolean,
  ): string | string[] | null {
    for (const t of stageConfig.transitions) {
      if (t.retry) continue;
      const isError = t.marker.toUpperCase().includes('ERROR');
      if (success && !isError) return t.next ?? null;
      if (!success && isError) return t.next ?? null;
    }
    return null;
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
        pendingFanoutPayloads: Object.fromEntries(this.pendingFanoutPayloads),
      },
      this.pipelineTag,
      this.scopeId,
    );

    const predecessors = this.buildPredecessorMap();
    const reachability = this.buildReachabilityMap();
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

    // Helper: check fan-in readiness for a stage
    const isFanInReady = (stageName: string): boolean => {
      const cfg = stagesByName.get(stageName);
      const fanInMode = cfg?.fan_in ?? 'all';
      if (fanInMode === 'dynamic') {
        // Compute alive stages: running + pending + waiting-for-fan-in, excluding self
        const aliveStages = new Set<string>([
          ...runningNames,
          ...pendingStages.map((s) => s.name),
          ...waitingForFanIn,
        ]);
        aliveStages.delete(stageName);
        return PipelineRunner.fanInReadyDynamic(
          stageName,
          predecessors,
          activations,
          completions,
          reachability,
          aliveStages,
        );
      }
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
          pendingFanoutPayloads: Object.fromEntries(this.pendingFanoutPayloads),
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

const FANOUT_FORBIDDEN_FIELDS = [
  'prompt',
  'prompts',
  'prompt_append',
  'command',
  'image',
  'chat',
  'successMarker',
  'errorMarker',
  'mcpAccess',
  'exclusive',
  'runAsRoot',
  'privileged',
  'hostMounts',
  'devices',
  'gpu',
  'env',
  'resumeSession',
] as const;

const FANOUT_SUBSTITUTION_ALLOWED_FIELDS = new Set([
  'prompt',
  'prompts',
  'prompt_append',
  'mounts',
  'hostMounts',
  'env',
  'image',
  'command',
]);

function validateFanoutStage(
  stage: PipelineStage,
  groupFolder: string,
): boolean {
  if (typeof stage.template !== 'string' || stage.template.length === 0) {
    logger.error(
      { groupFolder, stage: stage.name },
      'dynamic-fanout stage requires non-empty template path',
    );
    return false;
  }

  if (stage.inputFrom !== 'payload') {
    logger.error(
      { groupFolder, stage: stage.name, inputFrom: stage.inputFrom },
      'dynamic-fanout stage requires inputFrom: "payload"',
    );
    return false;
  }

  if (stage.substitutions !== undefined) {
    const subs = stage.substitutions;
    if (
      typeof subs !== 'object' ||
      subs === null ||
      !Array.isArray(subs.fields) ||
      subs.fields.some((f) => typeof f !== 'string')
    ) {
      logger.error(
        { groupFolder, stage: stage.name, substitutions: subs },
        'Invalid substitutions (must be { fields: string[] })',
      );
      return false;
    }
    for (const f of subs.fields) {
      if (!FANOUT_SUBSTITUTION_ALLOWED_FIELDS.has(f)) {
        logger.error(
          { groupFolder, stage: stage.name, field: f },
          `substitutions.fields may only include [${[...FANOUT_SUBSTITUTION_ALLOWED_FIELDS].join(', ')}]`,
        );
        return false;
      }
    }
  }

  if (
    stage.concurrency !== undefined &&
    (typeof stage.concurrency !== 'number' ||
      !Number.isInteger(stage.concurrency) ||
      stage.concurrency < 1)
  ) {
    logger.error(
      { groupFolder, stage: stage.name, concurrency: stage.concurrency },
      'concurrency must be a positive integer',
    );
    return false;
  }

  if (
    stage.failurePolicy !== undefined &&
    stage.failurePolicy !== 'all-success'
  ) {
    logger.error(
      { groupFolder, stage: stage.name, failurePolicy: stage.failurePolicy },
      'failurePolicy must be "all-success"',
    );
    return false;
  }

  for (const field of FANOUT_FORBIDDEN_FIELDS) {
    if ((stage as unknown as Record<string, unknown>)[field] !== undefined) {
      logger.error(
        { groupFolder, stage: stage.name, field },
        `dynamic-fanout stages cannot declare "${field}"`,
      );
      return false;
    }
  }

  return true;
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
        stage.kind !== 'command' &&
        stage.kind !== 'dynamic-fanout'
      ) {
        logger.error(
          { groupFolder, stage: stage.name, kind: stage.kind },
          'Invalid stage kind (must be "agent", "command", or "dynamic-fanout")',
        );
        return null;
      }

      const effectiveKind = resolveStageKind(stage);

      if (effectiveKind === 'dynamic-fanout') {
        if (!validateFanoutStage(stage, groupFolder)) return null;
        // Skip agent/command-only validations below
        // but still run transition validation at the bottom of the loop.
        for (const t of stage.transitions) {
          if (t.next_dynamic) {
            logger.error(
              { groupFolder, stage: stage.name, marker: t.marker },
              'dynamic-fanout stages cannot use next_dynamic transitions',
            );
            return null;
          }
        }
        continue;
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

      // Validate fan_in value
      if (
        stage.fan_in !== undefined &&
        stage.fan_in !== 'all' &&
        stage.fan_in !== 'dynamic'
      ) {
        logger.error(
          { groupFolder, stage: stage.name, fan_in: stage.fan_in },
          'Invalid fan_in value (must be "all" or "dynamic")',
        );
        return null;
      }

      for (const t of stage.transitions) {
        // next_dynamic + retry mutual exclusion
        if (t.next_dynamic && t.retry) {
          logger.error(
            { groupFolder, stage: stage.name, marker: t.marker },
            'next_dynamic and retry cannot be used together',
          );
          return null;
        }
        // next_dynamic requires non-null next
        if (t.next_dynamic && t.next == null) {
          logger.error(
            { groupFolder, stage: stage.name, marker: t.marker },
            'next_dynamic requires next to be a non-null array (allowlist)',
          );
          return null;
        }
        // Validate transition targets exist
        if (!t.retry) {
          const targets = Array.isArray(t.next)
            ? t.next
            : t.next != null
              ? [t.next]
              : [];
          for (const target of targets) {
            if (!stageNames.has(target)) {
              logger.warn(
                { groupFolder, stage: stage.name, target },
                'Transition target references non-existent stage',
              );
            }
          }
        }
      }
    }

    return config;
  } catch (err) {
    logger.error({ groupFolder, err }, 'Failed to parse PIPELINE.json');
    return null;
  }
}
