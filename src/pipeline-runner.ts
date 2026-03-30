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

import { spawn, execSync } from 'child_process';

import { CONTAINER_IMAGE, DATA_DIR } from './config.js';
import {
  buildContainerArgs,
  ContainerOutput,
  runContainerAgent,
} from './container-runner.js';
import { getRuntime } from './container-runtime.js';
import { getImageForStage, loadImageRegistry } from './image-registry.js';
import { validateAdditionalMounts } from './mount-security.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  generateRunId,
  writeCurrentRun,
  removeCurrentRun,
  writeRunManifest,
  type RunManifest,
  type CurrentRunInfo,
} from './run-manifest.js';
import { AdditionalMount, RegisteredGroup } from './types.js';

// --- Pipeline JSON Schema ---

export interface PipelineTransition {
  marker: string; // Marker name (e.g. "STAGE_COMPLETE")
  next?: string | string[] | null; // Target stage(s) (null = pipeline end, array = fan-out)
  retry?: boolean; // true = retry current stage (error tracking applies)
  prompt?: string; // Description for the agent on when to use this marker
}

export interface PipelineStage {
  name: string;
  prompt: string;
  image?: string; // Registry key (agent mode) or image name (command mode)
  command?: string; // Shell command mode (runs sh -c, no agent)
  mounts: Record<string, 'ro' | 'rw' | null | undefined>;
  devices?: string[];
  gpu?: boolean;
  runAsRoot?: boolean;
  privileged?: boolean; // Run container with --privileged flag
  env?: Record<string, string>; // Environment variables passed to container
  exclusive?: string;
  hostMounts?: AdditionalMount[]; // Host path mounts validated against allowlist
  resumeSession?: boolean; // false = always start fresh session. default true = resume
  transitions: PipelineTransition[];
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
}

const PIPELINE_STATE_FILE = 'PIPELINE_STATE.json';

export function savePipelineState(
  groupDir: string,
  state: PipelineState,
): void {
  const filepath = path.join(groupDir, PIPELINE_STATE_FILE);
  atomicWrite(filepath, JSON.stringify(state, null, 2));
}

export function loadPipelineState(groupDir: string): PipelineState | null {
  const filepath = path.join(groupDir, PIPELINE_STATE_FILE);
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
 * Matches `[MARKER]` or `[MARKER: payload]` patterns, first match wins.
 */
export function parseStageMarkers(
  resultTexts: string[],
  transitions: PipelineTransition[],
): StageMarkerResult {
  const combined = resultTexts.join('\n');
  for (const transition of transitions) {
    // Match [MARKER] or [MARKER: payload]
    const regex = new RegExp(
      `\\[${escapeRegExp(transition.marker)}(?::\\s*(.+?))?\\]`,
    );
    const match = regex.exec(combined);
    if (match) {
      return { matched: transition, payload: match[1] ?? null };
    }
  }
  return { matched: null, payload: null };
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
  private manifest: RunManifest;
  private aborted = false;
  private activeHandles = new Map<string, StageHandle>();
  private stageSessionIds = new Map<string, string>();
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
  ) {
    this.group = group;
    this.chatJid = chatJid;
    this.config = pipelineConfig;
    this.notify = notify;
    this.onProcess = onProcess;
    this.groupDir = groupDir ?? resolveGroupFolderPath(this.group.folder);
    this.runId = runId ?? generateRunId();
    this.manifest = {
      runId: this.runId,
      pid: process.pid,
      startTime: new Date().toISOString(),
      status: 'running',
      stages: [],
    };
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

    // Stage mounts (e.g. "src": "rw" → /workspace/src)
    for (const [key, policy] of Object.entries(stageConfig.mounts)) {
      if (key.startsWith('project:')) continue;
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
    if (effectivePolicy) {
      mounts.push({
        hostPath: path.dirname(this.groupDir),
        containerPath: '/workspace/project',
        readonly: effectivePolicy === 'ro',
      });

      // Shadow __art__/ with empty dir
      const emptyDir = path.join(DATA_DIR, 'empty');
      fs.mkdirSync(emptyDir, { recursive: true });
      const artDirName = path.basename(this.groupDir);
      mounts.push({
        hostPath: emptyDir,
        containerPath: `/workspace/project/${artDirName}`,
        readonly: true,
      });

      // Process project:* sub-mount overrides (directory-level only)
      // File-level bind mounts are not supported because Docker tracks inodes,
      // and git operations (reset, checkout) replace files with new inodes,
      // making the bind mount stale.
      const projectRoot = path.dirname(this.groupDir);
      for (const [key, subPolicy] of Object.entries(stageConfig.mounts)) {
        if (!key.startsWith('project:')) continue;
        const subPath = key.slice('project:'.length);
        if (subPath === artDirName || subPath.startsWith(artDirName + '/'))
          continue;

        const subHostPath = path.join(projectRoot, subPath);
        const isFile =
          fs.existsSync(subHostPath) && fs.statSync(subHostPath).isFile();
        if (isFile) {
          logger.warn(
            { key, subPath },
            'File-level project mount ignored (only directories supported)',
          );
          continue;
        }

        if (subPolicy === null) {
          mounts.push({
            hostPath: emptyDir,
            containerPath: `/workspace/project/${subPath}`,
            readonly: true,
          });
        } else if (subPolicy && subPolicy !== effectivePolicy) {
          mounts.push({
            hostPath: subHostPath,
            containerPath: `/workspace/project/${subPath}`,
            readonly: subPolicy === 'ro',
          });
        }
      }
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
    const subFolder = `${this.group.folder}__pipeline_${stageConfig.name}`;
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
  ): StageHandle {
    const subFolder = `${this.group.folder}__pipeline_${stageConfig.name}`;

    // Build internal mounts (group + project + sub-path overrides)
    const internalMounts = this.buildStageMounts(stageConfig);

    // Resolve container image from registry (agent mode only)
    let resolvedImage: string | undefined;
    if (!stageConfig.command) {
      resolvedImage = getImageForStage(stageConfig.image, false);
    }

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
        image: resolvedImage,
        additionalMounts: filteredParentMounts,
        additionalDevices: stageConfig.devices || [],
        gpu: stageConfig.gpu === true,
        runAsRoot: stageConfig.runAsRoot === true,
        privileged: stageConfig.privileged === true,
        env: stageConfig.env,
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

      // Stream agent output to TUI so user can see progress
      if (process.env.ART_TUI_MODE) {
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
          groupFolder: subFolder,
          chatJid: this.chatJid,
          isMain: false,
          assistantName: `pipeline-${stageConfig.name}`,
          runId: this.runId,
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

      container.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        if (logStream) logStream.write(chunk);

        // Stream output to TUI
        if (process.env.ART_TUI_MODE) {
          const trimmed = chunk.trim();
          if (trimmed) {
            this.notify(`[${stageConfig.name}] ${trimmed}`).catch(() => {});
          }
        }
      });

      container.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        if (logStream) logStream.write(`[stderr] ${chunk}`);
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
          logStream.write(
            `\n=== Command Stage ${stageConfig.name} exited: code=${code} ===\n`,
          );
        }

        if (timedOut) {
          if (handle.pendingResult) {
            handle.pendingResult.resolve({
              matched: {
                marker: '_CONTAINER_TIMEOUT',
                retry: true,
                prompt: 'Command timed out',
              },
              payload: 'Command timed out',
            });
            handle.pendingResult = null;
          }
          resolve({
            status: 'error',
            result: null,
            error: `Command timed out after ${configTimeout}ms`,
          });
          return;
        }

        // Parse markers from stdout
        const markerResult = parseStageMarkers(
          [stdout],
          stageConfig.transitions,
        );

        if (handle.pendingResult) {
          if (markerResult.matched) {
            handle.pendingResult.resolve(markerResult);
          } else if (code !== 0) {
            handle.pendingResult.resolve({
              matched: {
                marker: '_COMMAND_FAILED',
                retry: true,
                prompt: 'Command failed',
              },
              payload: `Exit code ${code}: ${stderr.slice(-500)}`,
            });
          } else {
            // Exited 0 but no markers found
            handle.pendingResult.resolve({
              matched: null,
              payload: null,
            });
          }
          handle.pendingResult = null;
        }

        resolve({
          status: code === 0 ? 'success' : 'error',
          result: stdout,
          error: code !== 0 ? `Command exited with code ${code}` : undefined,
        });
      });

      container.on('error', (err) => {
        clearTimeout(timeout);
        if (handle.pendingResult) {
          handle.pendingResult.resolve({
            matched: {
              marker: '_CONTAINER_ERROR',
              retry: true,
              prompt: 'Container spawn error',
            },
            payload: err.message,
          });
          handle.pendingResult = null;
        }
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

    return `
RULES:
- Do NOT ask questions. Always assume "yes" and proceed autonomously.
- Read files before editing. Use tools freely.
- Do not stop until this stage is complete or you hit a blocking error.
- 프로젝트 소스는 /workspace/project/ 에서 읽기 전용으로 볼 수 있다.
- 스테이지 작업 디렉토리는 /workspace/ 아래에 마운트되어 있다 (plan/, src/, tb/, build/, sim/ 등). 반드시 이 경로에서 파일을 읽고 작업하라.

STAGE MARKERS — use the correct one:
${markerLines.join('\n')}`;
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

    if (!fs.existsSync(planPath)) {
      await this.notify(
        '⚠️ PLAN.md가 없습니다. 먼저 구현 계획을 작성해주세요.',
      );
      return null;
    }

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

    // Write _current.json and initial manifest
    writeCurrentRun(this.groupDir, {
      runId: this.runId,
      pid: process.pid,
      startTime: this.manifest.startTime,
    });
    writeRunManifest(this.groupDir, this.manifest);

    const planContent = fs.readFileSync(planPath, 'utf-8');
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
    await this.notifyBanner(`🚀 파이프라인 시작. 스테이지: ${stageNames}`);

    // Pipeline-wide log file
    const logsDir = path.join(this.groupDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const pipelineLogFile = path.join(logsDir, `pipeline-${ts}.log`);
    this.manifest.logFile = `logs/pipeline-${ts}.log`;
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

    return { planContent, stagesByName, pipelineLogStream };
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
      for (const t of s.transitions) {
        if (t.retry) continue;
        for (const target of PipelineRunner.nextTargets(t.next)) {
          let set = predecessors.get(target);
          if (!set) {
            set = new Set();
            predecessors.set(target, set);
          }
          set.add(s.name);
        }
      }
    }
    return predecessors;
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
   * Determine entry stage and resume from previous state if applicable.
   */
  private async resolveEntryStage(
    stagesByName: Map<string, PipelineStage>,
  ): Promise<{ initialStages: string[]; completedStages: string[] }> {
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
    const existingState = loadPipelineState(this.groupDir);
    if (
      existingState &&
      existingState.status !== 'success' &&
      existingState.completedStages.length > 0
    ) {
      const completedStages = [...existingState.completedStages];
      // Find where to resume: look at the last completed stage's forward transition
      const lastCompleted = completedStages[completedStages.length - 1];
      const lastConfig = stagesByName.get(lastCompleted);
      const completeTransition = lastConfig?.transitions.find(
        (t) => !t.retry && t.next,
      );
      let initialStages: string[];
      if (completeTransition?.next) {
        const targets = PipelineRunner.nextTargets(completeTransition.next);
        // Only resume targets not yet completed
        const remaining = targets.filter((t) => !completedStages.includes(t));
        initialStages = remaining.length > 0 ? remaining : [resolveEntry()];
      } else {
        initialStages = [resolveEntry()];
      }
      await this.notifyBanner(
        `🔄 ${initialStages.join(', ')}부터 재개 (이전 완료: ${existingState.completedStages.join(' → ')})`,
      );
      return { initialStages, completedStages };
    }

    return { initialStages: [resolveEntry()], completedStages: [] };
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
      // No markers found — retry
      logger.warn(
        { stage: currentStageName, turn: turnCount },
        'No stage markers found',
      );
      handle.pendingResult = createDeferred();
      sendToStage(
        handle,
        `이전 응답에 스테이지 마커가 없었습니다. 작업을 계속하고 완료 시 적절한 마커를 출력하세요.\n\n${stageConfig.prompt}\n${commonRules}`,
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
        `⚠️ [턴 ${turnCount}] ${currentStageName} 에러: ${errorDesc}`,
      );

      // Synthetic container exit/error — container is dead, must respawn
      if (matched.marker.startsWith('_CONTAINER')) {
        if (ctx.containerRespawnCount >= ctx.maxContainerRespawns) {
          await this.notify(
            `❌ [턴 ${turnCount}] ${currentStageName} 컨테이너 재시작 ${ctx.maxContainerRespawns}회 초과 — 스테이지 실패`,
          );
          return {
            stageResolved: true,
            nextStageName: null,
            nextInitialPrompt: null,
            lastResult: 'error',
          };
        }
        await this.notify(
          `🔄 [턴 ${turnCount}] ${currentStageName} 컨테이너 재시작 (${ctx.containerRespawnCount + 1}/${ctx.maxContainerRespawns})...`,
        );
        return {
          stageResolved: true,
          nextStageName: currentStageName,
          nextInitialPrompt: `이전 시도에서 컨테이너가 비정상 종료되었습니다: ${errorDesc}\n\n다시 시도하세요.\n\n${stageConfig.prompt}\n${commonRules}\n\n## Plan\n\n${planContent}`,
          lastResult: null,
        };
      }

      // Normal retry — container is still alive, re-send prompt via IPC
      handle.pendingResult = createDeferred();
      sendToStage(
        handle,
        `이전 시도에서 에러가 발생했습니다: ${errorDesc}\n\n다시 시도하세요.\n\n${stageConfig.prompt}\n${commonRules}\n\n## Plan\n\n${planContent}`,
      );
      return {
        stageResolved: false,
        nextStageName: null,
        nextInitialPrompt: null,
        lastResult: null,
      };
    }

    // Non-retry transition — move to next stage(s) or end pipeline
    const targetName = matched.next ?? null;
    const targetDisplay = Array.isArray(targetName)
      ? targetName.join(', ')
      : targetName;
    const isErrorTransition = matched.marker.includes('ERROR');
    if (isErrorTransition) {
      await this.notifyBanner(
        targetDisplay
          ? `⚠️ 주의: ${payload || matched.marker}\n🔄 ${targetDisplay}으로 복귀`
          : `⚠️ 주의: ${payload || matched.marker}`,
      );
    } else {
      await this.notifyBanner(
        targetDisplay
          ? `✅ ${currentStageName} → ${targetDisplay} (${matched.marker})`
          : `✅ ${currentStageName} 완료! (${matched.marker})`,
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
    savePipelineState(this.groupDir, {
      currentStage: targetName,
      completedStages,
      lastUpdated: new Date().toISOString(),
      status: 'running',
    });

    // Close the container first, then retrieve session ID
    await this.closeAndWait(handle);
    const containerResult = await handle.containerPromise;
    if (containerResult.newSessionId) {
      this.stageSessionIds.set(currentStageName, containerResult.newSessionId);
    }
    this.activeHandles.delete(currentStageName);

    // Payload forwarding only works for single-target transitions
    let nextInitialPrompt: string | null = null;
    const targets = PipelineRunner.nextTargets(targetName);
    if (targets.length === 1 && payload) {
      const targetConfig = stagesByName.get(targets[0]);
      const targetRules = targetConfig
        ? this.buildCommonRules(targetConfig)
        : commonRules;
      nextInitialPrompt = `이전 스테이지(${currentStageName})에서 전달된 내용:\n\n${payload}\n\n${targetConfig?.prompt || ''}\n${targetRules}\n\n## Plan\n\n${planContent}`;
    }

    return {
      stageResolved: true,
      nextStageName: targetName,
      nextInitialPrompt,
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
    savePipelineState(this.groupDir, {
      currentStage: null,
      completedStages,
      lastUpdated: new Date().toISOString(),
      status: lastResult,
    });

    this.manifest.endTime = new Date().toISOString();
    this.manifest.status = lastResult;
    writeRunManifest(this.groupDir, this.manifest);
    removeCurrentRun(this.groupDir);

    pipelineLogStream.write(
      `\n=== Pipeline ${lastResult === 'success' ? 'completed' : 'failed'}: ${new Date().toISOString()} ===\n`,
    );
    pipelineLogStream.end();

    await this.notifyBanner(
      lastResult === 'success'
        ? '🏁 전체 파이프라인 완료!'
        : '❌ 파이프라인이 에러로 종료되었습니다.',
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
  ): Promise<{
    stageName: string;
    nextStages: string | string[] | null;
    nextInitialPrompt: string | null;
    result: 'success' | 'error' | null;
  }> {
    const stageConfig = stagesByName.get(stageName);
    if (!stageConfig) {
      logger.error({ stage: stageName }, 'Stage config not found');
      return {
        stageName,
        nextStages: null,
        nextInitialPrompt: null,
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
        `🔒 ${stageName}: 대기 중 (${stageConfig.exclusive} lock)...`,
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

    try {
      const commonRules = this.buildCommonRules(stageConfig);
      let nextInitialPrompt: string | null = initialPromptOverride ?? null;
      let containerRespawnCount = 0;
      const MAX_CONTAINER_RESPAWNS = 3;
      let turnCount = 0;
      let currentStage: string | null = stageName;

      while (currentStage === stageName) {
        if (this.aborted) {
          stageResult = 'error';
          break;
        }

        const initialPrompt =
          nextInitialPrompt ||
          `${stageConfig.prompt}\n${commonRules}\n\n## Plan\n\n${planContent}`;
        nextInitialPrompt = null;

        const stageStartTime = Date.now();
        const handle = this.spawnStageContainer(
          stageConfig,
          initialPrompt,
          pipelineLogStream,
        );
        this.activeHandles.set(stageName, handle);

        logger.info(
          { stage: stageName },
          'Stage container spawned (on-demand)',
        );
        logger.info({ stage: stageName }, 'Entering stage');
        await this.notifyBanner(`📌 Stage: ${stageName} 시작`);

        let isFirstTurn = true;
        let stageResolved = false;

        while (!stageResolved) {
          turnCount++;

          if (!handle.pendingResult) {
            handle.pendingResult = createDeferred();
          }

          if (!isFirstTurn) {
            const prompt = `${stageConfig.prompt}\n${commonRules}\n\n## Plan\n\n${planContent}`;
            sendToStage(handle, prompt);
          }
          isFirstTurn = false;

          logger.debug(
            { stage: stageName, turn: turnCount },
            'Waiting for stage result',
          );
          await this.notify(`🔧 [턴 ${turnCount}] ${stageName} 진행 중...`);

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
              currentStage = stageName; // stay in outer while
            } else {
              // Advance to next stage(s) or end
              nextStages = outcome.nextStageName;
              outNextInitialPrompt = outcome.nextInitialPrompt;
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
    const { initialStages, completedStages } =
      await this.resolveEntryStage(stagesByName);

    savePipelineState(this.groupDir, {
      currentStage:
        initialStages.length === 1 ? initialStages[0] : initialStages,
      completedStages,
      lastUpdated: new Date().toISOString(),
      status: 'running',
    });

    const predecessors = this.buildPredecessorMap();
    // Each entry: { name, initialPrompt } — prompt is set when payload forwarding applies
    let pendingStages: Array<{ name: string; initialPrompt?: string | null }> =
      initialStages.map((name) => ({ name }));
    const waitingForFanIn = new Set<string>();
    let lastResult: 'success' | 'error' = 'success';

    while (pendingStages.length > 0 || waitingForFanIn.size > 0) {
      if (this.aborted) break;

      // Check fan-in gates
      for (const w of waitingForFanIn) {
        if (PipelineRunner.fanInReady(w, predecessors, completedStages)) {
          waitingForFanIn.delete(w);
          pendingStages.push({ name: w });
        }
      }

      if (pendingStages.length === 0) {
        // All pending stages are waiting for fan-in that will never be satisfied
        // (predecessor failed or pipeline is stuck)
        logger.warn(
          { waiting: [...waitingForFanIn] },
          'Fan-in stages stuck — predecessors did not complete',
        );
        lastResult = 'error';
        break;
      }

      // Save current active stages
      const activeNames = pendingStages.map((s) => s.name);
      savePipelineState(this.groupDir, {
        currentStage: activeNames.length === 1 ? activeNames[0] : activeNames,
        completedStages,
        lastUpdated: new Date().toISOString(),
        status: 'running',
      });

      // Launch all pending stages concurrently
      const batch = [...pendingStages];
      pendingStages = [];

      const results = await Promise.all(
        batch.map((entry) =>
          this.runSingleStage(
            entry.name,
            stagesByName,
            completedStages,
            planContent,
            pipelineLogStream,
            entry.initialPrompt,
          ),
        ),
      );

      // Process results and collect next stages
      for (const { nextStages, nextInitialPrompt, result } of results) {
        if (result === 'error') lastResult = 'error';

        const targets = PipelineRunner.nextTargets(nextStages);
        for (const target of targets) {
          // Skip if already queued in this round (fan-in dedup)
          if (
            pendingStages.some((s) => s.name === target) ||
            waitingForFanIn.has(target)
          ) {
            continue;
          }
          if (
            PipelineRunner.fanInReady(target, predecessors, completedStages)
          ) {
            pendingStages.push({
              name: target,
              initialPrompt: targets.length === 1 ? nextInitialPrompt : null,
            });
          } else {
            waitingForFanIn.add(target);
          }
        }
      }
    }

    await this.finalizeRun(completedStages, lastResult, pipelineLogStream);
    return lastResult;
  }
}

// --- Agent Team Config ---

export interface AgentTeamConfig {
  agents: Array<{ name: string; folder: string }>;
}

/**
 * Load and validate AGENT_TEAM.json from a group folder.
 * Returns null if the file doesn't exist.
 */
export function loadAgentTeamConfig(
  groupFolder: string,
): AgentTeamConfig | null {
  const groupDir = resolveGroupFolderPath(groupFolder);
  const teamPath = path.join(groupDir, 'AGENT_TEAM.json');

  if (!fs.existsSync(teamPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(teamPath, 'utf-8');
    const config: AgentTeamConfig = JSON.parse(raw);

    if (!Array.isArray(config.agents) || config.agents.length === 0) {
      logger.warn({ groupFolder }, 'AGENT_TEAM.json has no agents');
      return null;
    }

    // Validate folder names: no path traversal, alphanumeric + underscore/hyphen only
    const folderPattern = /^[a-zA-Z0-9_-]+$/;
    for (const agent of config.agents) {
      if (!agent.name || !agent.folder || !folderPattern.test(agent.folder)) {
        logger.warn(
          { groupFolder, agent },
          'AGENT_TEAM.json has invalid agent entry',
        );
        return null;
      }
    }

    return config;
  } catch (err) {
    logger.error({ groupFolder, err }, 'Failed to parse AGENT_TEAM.json');
    return null;
  }
}

/**
 * Load and validate PIPELINE.json from a group folder.
 * Returns null if the file doesn't exist.
 */
export function loadPipelineConfig(
  groupFolder: string,
  groupDir?: string,
): PipelineConfig | null {
  const dir = groupDir ?? resolveGroupFolderPath(groupFolder);
  const pipelinePath = path.join(dir, 'PIPELINE.json');

  if (!fs.existsSync(pipelinePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(pipelinePath, 'utf-8');
    const config: PipelineConfig = JSON.parse(raw);

    // Basic validation
    if (!Array.isArray(config.stages) || config.stages.length === 0) {
      logger.warn({ groupFolder }, 'PIPELINE.json has no stages');
      return null;
    }

    return config;
  } catch (err) {
    logger.error({ groupFolder, err }, 'Failed to parse PIPELINE.json');
    return null;
  }
}
