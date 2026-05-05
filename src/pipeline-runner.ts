/**
 * Host-Side Pipeline FSM with Multi-Container Isolation
 *
 * When a group has PIPELINE.json, this runner spawns separate containers
 * per stage with different mount policies. The host FSM routes work via IPC
 * and each container maintains its session across retries.
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import { spawn } from 'child_process';

import { CONTAINER_IMAGE, getDataDir } from './config.js';
import {
  buildContainerArgs,
  ContainerOutput,
  prefixLogLines,
  runContainerAgent,
} from './container-runner.js';
import { getRuntime } from './container-runtime.js';
import { getImageForStage } from './image-registry.js';
import { validateAdditionalMounts } from './mount-security.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  generateRunId,
  writeRunManifest,
  type RunManifest,
} from './run-manifest.js';
import {
  formatStageMcpAccessSummary,
  resolveStageMcpServers,
} from './mcp-registry.js';
import { loadPipelineTemplate } from './pipeline-template.js';
import {
  assertNoNameCollision,
  buildStitchInvocation,
  type StitchInvocation,
} from './stitch.js';
import {
  type PipelineConfig,
  type PipelineStage,
  type PipelineTransition,
  type TransitionOutcome,
} from './pipeline-types.js';
import {
  assertValidScopeId,
  loadPipelineState,
  savePipelineState,
  type PipelineStageQueueEntry,
  type PipelineState,
} from './pipeline-state.js';
import {
  buildPredecessorMap,
  fanInReady,
  nextTargets,
  normalizeStageEntries,
  runNodeLocalScheduler,
  stageEntries,
  type SchedulerSnapshotOptions,
} from './node-scheduler.js';
import {
  parseStageMarkers,
  primaryTransition,
  resolveStitchInputs,
  transitionDisplayName,
  transitionOutcome,
  type StageMarkerResult,
} from './pipeline-transitions.js';
import { createStageIpcEndpoint, type StageIpcEndpoint } from './stage-ipc.js';
import {
  resumeActiveTemplateDispatchBarriers,
  runTemplateStitchInvocation,
  TemplateDispatchState,
  type TemplateDispatchRuntime,
} from './template-dispatch.js';
import { RegisteredGroup } from './types.js';

export type {
  PipelineDispatchBarrier,
  PipelineDispatchNode,
  JoinPolicy,
  PipelineConfig,
  PipelineStage,
  PipelineTransition,
  TransitionOutcome,
} from './pipeline-types.js';
export type { PipelineState } from './pipeline-state.js';
export {
  assertValidScopeId,
  loadPipelineState,
  savePipelineState,
} from './pipeline-state.js';
export type { StitchDirective } from './pipeline-transitions.js';
export {
  parseStageMarkers,
  resolveStitchInputs,
} from './pipeline-transitions.js';
export { loadPipelineConfig } from './pipeline-config.js';

function resolveProvider(): 'claude' | 'codex' {
  return process.env.ART_AGENT_PROVIDER === 'claude' ? 'claude' : 'codex';
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

// --- Internal types ---

interface StageHandle {
  name: string;
  ipc: StageIpcEndpoint;
  containerPromise: Promise<ContainerOutput>;
  outboundPoller: NodeJS.Timeout | null;
  pendingResult: {
    promise: Promise<StageMarkerResult>;
    resolve: (r: StageMarkerResult) => void;
  } | null;
  resultTexts: string[];
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
  private stateDir: string;
  private bundleDir: string;
  private runId: string;
  private scopeId: string | undefined;
  private manifest: RunManifest;
  private aborted = false;
  private activeHandles = new Map<string, StageHandle>();
  private stageSessionIds = new Map<string, string>();
  private dispatch = new TemplateDispatchState();
  private activations = new Map<string, number>();
  private completions = new Map<string, number>();

  // --- Public API ---

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
    scopeId?: string,
    bundleDir?: string,
  ) {
    this.group = group;
    this.chatJid = chatJid;
    this.config = pipelineConfig;
    this.notify = notify;
    this.onProcess = onProcess;
    this.groupDir = groupDir ?? resolveGroupFolderPath(this.group.folder);
    this.stateDir = path.join(this.groupDir, '.state');
    this.bundleDir = bundleDir ?? this.groupDir;
    this.runId = runId ?? generateRunId();
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

  getRunId(): string {
    return this.runId;
  }

  async abort(): Promise<void> {
    this.aborted = true;
    const handles = [...this.activeHandles.values()];
    await Promise.all(handles.map((h) => this.closeAndWait(h)));
  }

  /**
   * Run this dispatch node. The node-local scheduler owns fan-out/fan-in
   * mechanics; this runner supplies stage execution and stitch dispatch hooks.
   */
  async run(): Promise<'success' | 'error'> {
    const init = await this.initRun();
    if (!init) return 'error';

    const { stagesByName, pipelineLogStream } = init;
    const {
      initialStages,
      waitingStages: restoredWaitingStages,
      completedStages,
    } = await this.resolveEntryStage(stagesByName);

    return runNodeLocalScheduler({
      initialStages,
      restoredWaitingStages,
      completedStages,
      stagesByName,
      isAborted: () => this.aborted,
      isStageReady: (stageName, latestCompletedStages) =>
        fanInReady(
          stageName,
          buildPredecessorMap(this.config.stages),
          latestCompletedStages,
        ),
      runStage: (entry) =>
        this.runSingleStage(
          entry.name,
          stagesByName,
          completedStages,
          pipelineLogStream,
          entry.initialPrompt,
          entry.ephemeralSystemPrompt,
        ),
      runStitchInvocation: (invocation, latestCompletedStages, saveState) =>
        this.runStitchInvocation(invocation, latestCompletedStages, saveState),
      resumeBlockedDispatch: (ctx) =>
        resumeActiveTemplateDispatchBarriers(
          this.templateDispatchRuntime(),
          ctx,
        ),
      buildPayloadHandoff: (payload, finishedStage, targetName) =>
        this.buildPayloadHandoff(
          payload,
          finishedStage,
          targetName,
          stagesByName,
        ),
      saveSnapshot: (snapshot) => {
        this.saveRunnerState({
          ...snapshot,
          lastUpdated: new Date().toISOString(),
          status: 'running',
        });
      },
      recordActivation: (stageName) => {
        this.activations.set(
          stageName,
          (this.activations.get(stageName) ?? 0) + 1,
        );
      },
      recordCompletion: (stageName) => {
        this.completions.set(
          stageName,
          (this.completions.get(stageName) ?? 0) + 1,
        );
      },
      finalize: (latestCompletedStages, lastResult) =>
        this.finalizeRun(latestCompletedStages, lastResult, pipelineLogStream),
    });
  }

  // --- Run Setup And State ---

  /**
   * Write manifest and create log stream.
   * Returns null on validation failure.
   */
  private async initRun(): Promise<{
    stagesByName: Map<string, PipelineStage>;
    pipelineLogStream: fs.WriteStream;
  } | null> {
    // Write initial manifest
    writeRunManifest(this.stateDir, this.manifest);
    logger.info(
      {
        group: this.group.name,
        runId: this.runId,
        stageCount: this.config.stages.length,
      },
      'Pipeline starting',
    );

    const stageNames = this.config.stages.map((s) => s.name).join(' → ');
    await this.notifyBanner(`🚀 Pipeline starting. Stages: ${stageNames}`);

    // Pipeline-wide log file
    const logsDir = this.scopeId
      ? path.join(this.stateDir, 'logs', this.scopeId)
      : path.join(this.stateDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const pipelineLogFile = path.join(logsDir, `pipeline-${ts}.log`);
    this.manifest.logFile = this.scopeId
      ? `logs/${this.scopeId}/pipeline-${ts}.log`
      : `logs/pipeline-${ts}.log`;
    writeRunManifest(this.stateDir, this.manifest);
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

    return { stagesByName, pipelineLogStream };
  }

  /**
   * Determine entry stage and resume from previous state if applicable.
   * Restores node-local scheduler state and active stitch barriers.
   */
  private async resolveEntryStage(
    stagesByName: Map<string, PipelineStage>,
  ): Promise<{
    initialStages: PipelineStageQueueEntry[];
    waitingStages: PipelineStageQueueEntry[];
    completedStages: string[];
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
          const targets = nextTargets(t.next);
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

    // Resume from the last durable scheduler snapshot if the pipeline was
    // interrupted. Newer snapshots persist the whole runtime frontier; older
    // state files fall back to deriving a frontier from currentStage.
    const existingState = loadPipelineState(
      this.stateDir,
      undefined,
      this.scopeId,
    );
    if (existingState && existingState.status !== 'success') {
      const completedStages = [...existingState.completedStages];
      this.dispatch.restoreTree(
        existingState.dispatchTree,
        this.scopeId,
        this.config,
      );
      this.dispatch.restoreBarriers(existingState.dispatchBarriers);
      const selfNode =
        existingState.dispatchTree?.[this.dispatch.currentNodeId(this.scopeId)];
      if (selfNode?.config) {
        this.config = selfNode.config;
        assertNoNameCollision(this.config);
        stagesByName.clear();
        for (const stage of this.config.stages)
          stagesByName.set(stage.name, stage);
      }
      this.activations = new Map(
        Object.entries(existingState.activations ?? {}),
      );
      this.completions = new Map(
        Object.entries(existingState.completions ?? {}),
      );
      this.dispatch.restoreActiveBarrierIds(existingState.activeBarrierIds);
      this.stageSessionIds = new Map(
        Object.entries(existingState.stageSessions ?? {}),
      );

      const restoredRunning = stageEntries(
        existingState.runningStages ?? [],
        stagesByName,
        completedStages,
      );
      const restoredPending = normalizeStageEntries(
        existingState.pendingStages,
        stagesByName,
        completedStages,
      );
      const restoredWaiting = normalizeStageEntries(
        existingState.waitingStages,
        stagesByName,
        completedStages,
      );

      let initialStages: PipelineStageQueueEntry[] = [
        ...restoredRunning,
        ...restoredPending.filter(
          (entry) => !restoredRunning.some((r) => r.name === entry.name),
        ),
      ];
      const waitingStages = restoredWaiting;

      // Legacy fallback: derive the frontier from currentStage when the
      // scheduler-specific frontier fields are absent.
      if (
        initialStages.length === 0 &&
        waitingStages.length === 0 &&
        this.dispatch.activeBarrierCount() === 0 &&
        existingState.currentStage
      ) {
        const current = Array.isArray(existingState.currentStage)
          ? existingState.currentStage
          : [existingState.currentStage];
        initialStages = stageEntries(
          current
            .flatMap((name) => {
              if (!stagesByName.has(name)) return [];
              if (!completedStages.includes(name)) return [name];
              const stage = stagesByName.get(name)!;
              const primary = primaryTransition(stage);
              return primary ? nextTargets(primary.next) : [];
            })
            .filter((s, index, items) => items.indexOf(s) === index)
            .filter((s) => stagesByName.has(s)),
          stagesByName,
          completedStages,
        );
      } else if (
        initialStages.length === 0 &&
        waitingStages.length === 0 &&
        this.dispatch.activeBarrierCount() === 0
      ) {
        // Pipeline finished with error (currentStage: null). Find the first
        // unfinished stage as a best-effort legacy fallback.
        const completedSet = new Set(completedStages);
        const unfinished = this.config.stages
          .filter((s) => !completedSet.has(s.name))
          .map((s) => s.name);
        initialStages = stageEntries(
          unfinished.length > 0 ? [unfinished[0]] : [],
          stagesByName,
          completedStages,
        );
      }
      if (
        initialStages.length === 0 &&
        waitingStages.length === 0 &&
        this.dispatch.activeBarrierCount() === 0
      ) {
        initialStages = [{ name: resolveEntry() }];
      }
      const frontierNames = [
        ...initialStages.map((s) => s.name),
        ...waitingStages.map((s) => s.name),
        ...this.dispatch.activeBarrierIdsArray().map((id) => `barrier:${id}`),
      ];
      await this.notifyBanner(
        `🔄 Resuming from ${frontierNames.join(', ')} (previously completed: ${existingState.completedStages.join(' → ')})`,
      );
      return { initialStages, waitingStages, completedStages };
    }

    this.dispatch.clear();
    this.dispatch.ensureCurrentNode(this.scopeId, this.config);
    this.activations = new Map();
    this.completions = new Map();
    this.stageSessionIds = new Map();
    return {
      initialStages: [{ name: resolveEntry() }],
      waitingStages: [],
      completedStages: [],
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
    this.dispatch.markCurrentNodeSettled(this.scopeId, this.config, lastResult);
    this.saveRunnerState({
      currentStage: null,
      completedStages,
      lastUpdated: new Date().toISOString(),
      status: lastResult,
    });

    this.manifest.endTime = new Date().toISOString();
    this.manifest.status = lastResult;
    writeRunManifest(this.stateDir, this.manifest);

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

  private saveRunnerState(
    state: Omit<
      PipelineState,
      | 'version'
      | 'dispatchTree'
      | 'dispatchBarriers'
      | 'activeBarrierIds'
      | 'activations'
      | 'completions'
      | 'stageSessions'
    >,
  ): void {
    savePipelineState(
      this.stateDir,
      {
        ...state,
        activations: Object.fromEntries(this.activations),
        completions: Object.fromEntries(this.completions),
        dispatchTree: this.dispatch.serializeTree(this.scopeId, this.config),
        dispatchBarriers: this.dispatch.serializeBarriers(),
        activeBarrierIds: this.dispatch.activeBarrierIdsArray(),
        stageSessions: Object.fromEntries(this.stageSessionIds),
      },
      undefined,
      this.scopeId,
    );
  }

  // --- Stage Scheduling ---

  /**
   * Run a single stage to completion (spawn → turn loop → close).
   * Self-contained: handles retries and container respawns internally.
   */
  private async runSingleStage(
    stageName: string,
    stagesByName: Map<string, PipelineStage>,
    completedStages: string[],
    pipelineLogStream: fs.WriteStream,
    initialPromptOverride?: string | null,
    ephemeralSystemPromptOverride?: string | null,
  ): Promise<{
    stageName: string;
    nextStages: string | string[] | null;
    nextInitialPrompt: string | null;
    nextEphemeralSystemPrompt: string | null;
    stitchInvocation: StitchInvocation | null;
    stitchPayload: string | null;
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
        stitchInvocation: null,
        stitchPayload: null,
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
    let outStitchInvocation: StitchInvocation | null = null;
    let outStitchPayload: string | null = null;

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

        const initialPrompt =
          nextInitialPrompt || `${stageConfig.prompt ?? ''}\n${commonRules}`;
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
          { stage: stageName },
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
            const prompt = `${stageConfig.prompt ?? ''}\n${commonRules}`;
            handle.ipc.sendToContainer(prompt);
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
              outStitchInvocation = outcome.stitchInvocation ?? null;
              outStitchPayload = outcome.stitchPayload ?? null;
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
      stitchInvocation: outStitchInvocation,
      stitchPayload: outStitchPayload,
      result: stageResult,
    };
  }

  /**
   * Handle stage result: no-match → feedback prompt and re-send,
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
      stagesByName: Map<string, PipelineStage>;
      containerRespawnCount: number;
      maxContainerRespawns: number;
    },
  ): Promise<{
    stageResolved: boolean;
    nextStageName: string | string[] | null;
    nextInitialPrompt: string | null;
    nextEphemeralSystemPrompt?: string | null;
    stitchInvocation?: StitchInvocation | null;
    stitchPayload?: string | null;
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
      stagesByName,
    } = ctx;

    if (!matched) {
      if (stageConfig.chat) {
        // Chatting stage: read user input and send to container
        const userInput = await readUserInput('\n> ');
        handle.pendingResult = createDeferred();
        handle.ipc.sendToContainer(userInput);
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
      handle.ipc.sendToContainer(
        `No stage markers found in the previous response. Continue working and emit the appropriate marker when done.\n\n${stageConfig.prompt}\n${commonRules}`,
      );
      return {
        stageResolved: false,
        nextStageName: null,
        nextInitialPrompt: null,
        lastResult: null,
      };
    }
    const matchedLabel = transitionDisplayName(matched);

    // Synthetic container exit/error — container is dead, must respawn in place.
    if (matched.marker?.startsWith('_CONTAINER')) {
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
        nextInitialPrompt: `The container exited abnormally in the previous attempt: ${errorDesc}\n\nPlease retry.\n\n${stageConfig.prompt}\n${commonRules}`,
        lastResult: null,
      };
    }

    // Regular transition — move to next stage or end pipeline. Template
    // transitions spawn child run nodes and wait on a parent-owned barrier
    // instead of appending stages to this node's graph.
    let targetName: string | string[] | null = matched.next ?? null;
    let stitchInvocation: StitchInvocation | null = null;
    if (matched.template) {
      try {
        const directive = resolveStitchInputs(matched, payload);
        const transitionIdx = stageConfig.transitions.indexOf(matched);
        const downstreamNext = Array.isArray(matched.next)
          ? (() => {
              throw new Error(
                'Template transitions cannot carry authored multi-target "next" arrays',
              );
            })()
          : (matched.next ?? null);
        const template = loadPipelineTemplate(this.bundleDir, matched.template);
        stitchInvocation = buildStitchInvocation({
          originStage: stageConfig.name,
          originTransitionIdx: transitionIdx,
          template,
          downstreamNext,
          joinPolicy: matched.joinPolicy ?? 'all_success',
          parentDispatchNodeId: this.dispatch.stageNodeId(
            this.config,
            this.scopeId,
            stageConfig.name,
          ),
          mode: directive.mode,
          count: directive.mode === 'parallel' ? directive.count : undefined,
          substitutions:
            directive.mode === 'single' ? directive.subs : undefined,
          perCopySubstitutions:
            directive.mode === 'parallel' ? directive.perCopySubs : undefined,
        });
        targetName = null;
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
    const transitionStageOutcome = transitionOutcome(matched);
    const isErrorTransition = transitionStageOutcome === 'error';
    if (isErrorTransition) {
      await this.notifyBanner(
        targetDisplay
          ? `⚠️ Warning: ${payload || matchedLabel}\n🔄 Returning to ${targetDisplay}`
          : `⚠️ Warning: ${payload || matchedLabel}`,
      );
    } else {
      await this.notifyBanner(
        targetDisplay
          ? `✅ ${currentStageName} → ${targetDisplay} (${matchedLabel})`
          : `✅ ${currentStageName} completed! (${matchedLabel})`,
      );
    }

    // Track completed stage
    completedStages.push(currentStageName);
    this.manifest.stages.push({
      name: currentStageName,
      status: isErrorTransition ? 'error' : 'success',
      duration: Date.now() - stageStartTime,
    });
    writeRunManifest(this.stateDir, this.manifest);

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
    const { nextInitialPrompt, nextEphemeralSystemPrompt } =
      this.buildPayloadHandoff(
        payload,
        currentStageName,
        targetName,
        stagesByName,
        commonRules,
      );
    const targets = nextTargets(targetName);

    return {
      stageResolved: true,
      nextStageName: targetName,
      nextInitialPrompt,
      nextEphemeralSystemPrompt,
      stitchInvocation,
      stitchPayload: stitchInvocation ? payload : null,
      // Terminal transition: error-classified transitions (including
      // `afterTimeout`) end the pipeline with 'error'; success-classified
      // transitions end it with 'success'. Non-terminal transitions leave
      // the result undetermined until a later stage decides.
      lastResult:
        !stitchInvocation && targets.length === 0
          ? transitionStageOutcome
          : null,
    };
  }

  private buildPayloadHandoff(
    payload: string | null,
    currentStageName: string,
    targetName: string | string[] | null,
    stagesByName: Map<string, PipelineStage>,
    fallbackRules = '',
  ): {
    nextInitialPrompt: string | null;
    nextEphemeralSystemPrompt: string | null;
  } {
    const targets = nextTargets(targetName);
    if (targets.length !== 1 || !payload) {
      return { nextInitialPrompt: null, nextEphemeralSystemPrompt: null };
    }

    const targetConfig = stagesByName.get(targets[0]);
    const targetRules = targetConfig
      ? this.buildCommonRules(targetConfig)
      : fallbackRules;
    const isResumedTarget =
      targetConfig?.resumeSession !== false &&
      this.stageSessionIds.has(targets[0]);

    if (isResumedTarget) {
      return {
        nextInitialPrompt: null,
        nextEphemeralSystemPrompt: `Forwarded from previous stage (${currentStageName}):\n\n${payload}`,
      };
    }

    return {
      nextInitialPrompt: `Forwarded from previous stage (${currentStageName}):\n\n${payload}\n\n${targetConfig?.prompt || ''}\n${targetRules}`,
      nextEphemeralSystemPrompt: null,
    };
  }

  /**
   * Build commonRules dynamically from a stage's transitions.
   */
  private buildCommonRules(stageConfig: PipelineStage): string {
    const markerLines = stageConfig.transitions
      .filter((t) => !t.afterTimeout && t.marker)
      .map((t) => {
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

  // --- Stitch Dispatch Tree ---

  private async runStitchInvocation(
    invocation: StitchInvocation,
    completedStages: string[],
    saveSchedulerState?: (options?: SchedulerSnapshotOptions) => void,
  ): Promise<TransitionOutcome> {
    return runTemplateStitchInvocation(
      this.templateDispatchRuntime(),
      invocation,
      completedStages,
      saveSchedulerState,
    );
  }

  private templateDispatchRuntime(): TemplateDispatchRuntime {
    return {
      state: this.dispatch,
      scopeId: this.scopeId,
      config: this.config,
      notifyBanner: (text) => this.notifyBanner(text),
      saveBlockedState: (completedStages, saveSchedulerState) =>
        this.saveBlockedOnBarrierState(completedStages, saveSchedulerState),
      settlementFromChildState: (childNodeId) =>
        this.settlementFromChildState(childNodeId),
      runChildNode: (childNodeId, childConfig) =>
        this.runChildDispatchNode(childNodeId, childConfig),
    };
  }

  private async runChildDispatchNode(
    childNodeId: string,
    childConfig: PipelineConfig,
  ): Promise<{
    result: TransitionOutcome;
    dispatch: TemplateDispatchState;
  }> {
    const runner = new PipelineRunner(
      this.group,
      this.chatJid,
      childConfig,
      this.notify,
      this.onProcess,
      this.groupDir,
      this.runId,
      childNodeId,
      this.bundleDir,
    );
    return {
      result: await runner.run(),
      dispatch: runner.dispatch,
    };
  }

  private saveBlockedOnBarrierState(
    completedStages: string[],
    saveSchedulerState?: (options?: SchedulerSnapshotOptions) => void,
  ): void {
    if (saveSchedulerState) {
      saveSchedulerState();
      return;
    }
    this.saveRunnerState({
      currentStage: null,
      runningStages: [],
      pendingStages: [],
      waitingStages: [],
      completedStages,
      lastUpdated: new Date().toISOString(),
      status: 'running',
    });
  }

  private settlementFromChildState(
    childNodeId: string,
  ): TransitionOutcome | null {
    const state = loadPipelineState(this.stateDir, undefined, childNodeId);
    if (state?.status === 'success' || state?.status === 'error') {
      return state.status;
    }
    return null;
  }

  // --- Stage Containers ---

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

    const ipc = createStageIpcEndpoint(subFolder);
    ipc.clearCloseSentinel();

    const handle: StageHandle = {
      name: stageConfig.name,
      ipc,
      containerPromise: null!,
      outboundPoller: null,
      pendingResult: createDeferred(),
      resultTexts: [],
    };

    let outboundDrainRunning = false;
    const pollOutboundMessages = (): void => {
      if (outboundDrainRunning) return;
      outboundDrainRunning = true;
      void this.drainStageOutboundMessages(handle)
        .catch((err) => {
          logger.warn(
            { stage: stageConfig.name, err },
            'Failed to drain stage IPC outbound messages',
          );
        })
        .finally(() => {
          outboundDrainRunning = false;
        });
    };
    handle.outboundPoller = setInterval(pollOutboundMessages, 500);
    handle.outboundPoller.unref?.();

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
      if (output.newSessionId) {
        this.stageSessionIds.set(stageConfig.name, output.newSessionId);
      }
      await this.drainStageOutboundMessages(handle);
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
      })
      .finally(() => {
        this.stopStageOutboundPolling(handle);
        pollOutboundMessages();
      });

    return handle;
  }

  private stopStageOutboundPolling(handle: StageHandle): void {
    if (!handle.outboundPoller) return;
    clearInterval(handle.outboundPoller);
    handle.outboundPoller = null;
  }

  private async drainStageOutboundMessages(handle: StageHandle): Promise<void> {
    for (const message of handle.ipc.drainFromContainer()) {
      if (message.type !== 'message' || typeof message.text !== 'string') {
        logger.warn(
          { stage: handle.name, type: message.type },
          'Ignoring unsupported stage IPC outbound message',
        );
        continue;
      }
      const sender =
        typeof message.sender === 'string' && message.sender.length > 0
          ? message.sender
          : handle.name;
      await this.notify(`[${sender}] ${message.text}`);
    }
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
      resolveProvider(),
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
      let cmdNotifyRemainder = '';
      // Streaming marker detection: resolve pendingResult as soon as a marker
      // is found in stdout, without waiting for process exit.
      let markerResolved = false;

      const completeTransition = stageConfig.transitions.find(
        (t) => !t.afterTimeout && t.marker === 'STAGE_COMPLETE',
      );
      const errorTransition = stageConfig.transitions.find(
        (t) => !t.afterTimeout && t.marker === 'STAGE_ERROR',
      );
      const timeoutTransition = stageConfig.transitions.find(
        (t) => t.afterTimeout,
      );

      const resolveTransition = (
        transition: PipelineTransition | undefined,
        fallback: PipelineTransition,
        payload: string | null,
        isSuccess: boolean,
        shouldTerminateProcess = false,
      ) => {
        if (markerResolved || !handle.pendingResult) return;
        markerResolved = true;
        // On success, scan stdout for a fenced marker payload to forward to
        // the next stage. Command stages don't emit payload structurally, but
        // fenced `[MARKER] ... ---PAYLOAD_START--- ... ---PAYLOAD_END---`
        // blocks in stdout are picked up so a command stage can feed a
        // downstream payload-driven template fanout.
        let effectivePayload = payload;
        if (
          isSuccess &&
          transition &&
          !transition.afterTimeout &&
          effectivePayload === null
        ) {
          const parsed = parseStageMarkers([stdout], [transition]);
          if (parsed.matched && parsed.payload !== null) {
            effectivePayload = parsed.payload;
          }
        }
        handle.pendingResult.resolve({
          matched: transition ?? fallback,
          payload: effectivePayload,
        });
        handle.pendingResult = null;
        if (shouldTerminateProcess) {
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
          const { prefixed, remainder } = prefixLogLines(
            chunk,
            stageConfig.name,
            cmdNotifyRemainder,
          );
          cmdNotifyRemainder = remainder;
          const trimmed = prefixed.trimEnd();
          if (trimmed) {
            this.notify(trimmed).catch(() => {});
          }
        }

        // Streaming marker detection
        if (!markerResolved) {
          if (
            stageConfig.successMarker &&
            stdout.includes(stageConfig.successMarker)
          ) {
            resolveTransition(
              completeTransition,
              { marker: 'STAGE_COMPLETE', next: null },
              null,
              true,
            );
          } else if (
            stageConfig.errorMarker &&
            stdout.includes(stageConfig.errorMarker)
          ) {
            resolveTransition(
              errorTransition,
              { marker: 'STAGE_ERROR', next: null, outcome: 'error' },
              `errorMarker detected: ${stageConfig.errorMarker}`,
              false,
              true,
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

      const configTimeout =
        stageConfig.timeout ?? this.group.containerConfig?.timeout ?? 14400000; // 4 hour default for commands
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

        if (process.env.ART_TUI_MODE && cmdNotifyRemainder) {
          this.notify(`[${stageConfig.name}] ${cmdNotifyRemainder}`).catch(
            () => {},
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
          resolveTransition(
            timeoutTransition ?? errorTransition,
            timeoutTransition
              ? { afterTimeout: true, next: null, outcome: 'error' }
              : { marker: 'STAGE_ERROR', next: null, outcome: 'error' },
            `Command timed out after ${configTimeout}ms`,
            false,
          );
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

        resolveTransition(
          isSuccess ? completeTransition : errorTransition,
          isSuccess
            ? { marker: 'STAGE_COMPLETE', next: null }
            : { marker: 'STAGE_ERROR', next: null, outcome: 'error' },
          isSuccess
            ? null
            : code !== 0
              ? `Exit code ${code}: ${stderr.slice(-500)}`
              : `successMarker not found in output`,
          isSuccess,
        );

        resolve({
          status: code === 0 ? 'success' : 'error',
          result: stdout,
          error: code !== 0 ? `Command exited with code ${code}` : undefined,
        });
      });

      container.on('error', (err) => {
        clearTimeout(timeout);
        resolveTransition(
          errorTransition,
          { marker: 'STAGE_ERROR', next: null, outcome: 'error' },
          err.message,
          false,
        );
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
    handle.ipc.closeContainerInput();
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
    this.stopStageOutboundPolling(handle);
    await this.drainStageOutboundMessages(handle);
  }

  // --- Mounts And Paths ---

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

    const emptyDir = path.join(getDataDir(), 'empty');
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

  // --- Notifications ---

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
}
