import { logger } from './logger.js';
import type { PipelineStage, TransitionOutcome } from './pipeline-types.js';
import type { PipelineStageQueueEntry } from './pipeline-state.js';
import { primaryTransition } from './pipeline-transitions.js';
import type { StitchInvocation } from './stitch.js';

export interface SchedulerSnapshotOptions {
  excludeRunningStages?: string[];
}

export interface NodeSchedulerSnapshot {
  currentStage: string | string[] | null;
  runningStages: string[];
  pendingStages: PipelineStageQueueEntry[];
  waitingStages: PipelineStageQueueEntry[];
  completedStages: string[];
}

export interface NodeStageResult {
  stageName: string;
  nextStages: string | string[] | null;
  nextInitialPrompt: string | null;
  nextEphemeralSystemPrompt: string | null;
  stitchInvocation: StitchInvocation | null;
  stitchPayload: string | null;
  result: 'success' | 'error' | null;
}

export interface ResumeDispatchContext {
  completedStages: string[];
  pendingStages: PipelineStageQueueEntry[];
  waitingForFanIn: Map<string, PipelineStageQueueEntry>;
  saveSchedulerState: (options?: SchedulerSnapshotOptions) => void;
  setLastResult: (result: 'success' | 'error') => void;
  failPipeline: () => void;
}

export interface NodeSchedulerOptions {
  initialStages: PipelineStageQueueEntry[];
  restoredWaitingStages: PipelineStageQueueEntry[];
  completedStages: string[];
  stagesByName: Map<string, PipelineStage>;
  isAborted: () => boolean;
  isStageReady: (stageName: string, completedStages: string[]) => boolean;
  runStage: (entry: PipelineStageQueueEntry) => Promise<NodeStageResult>;
  runStitchInvocation: (
    invocation: StitchInvocation,
    completedStages: string[],
    saveSchedulerState: (options?: SchedulerSnapshotOptions) => void,
  ) => Promise<TransitionOutcome>;
  resumeBlockedDispatch?: (ctx: ResumeDispatchContext) => Promise<void>;
  buildPayloadHandoff: (
    payload: string | null,
    finishedStage: string,
    targetName: string | string[] | null,
  ) => {
    nextInitialPrompt: string | null;
    nextEphemeralSystemPrompt: string | null;
  };
  saveSnapshot: (snapshot: NodeSchedulerSnapshot) => void;
  recordActivation: (stageName: string) => void;
  recordCompletion: (stageName: string) => void;
  finalize: (
    completedStages: string[],
    lastResult: 'success' | 'error',
  ) => Promise<void>;
}

export async function runNodeLocalScheduler(
  options: NodeSchedulerOptions,
): Promise<'success' | 'error'> {
  for (const entry of options.initialStages) {
    options.recordActivation(entry.name);
  }

  let pendingStages: PipelineStageQueueEntry[] = [...options.initialStages];
  const waitingForFanIn = new Map<string, PipelineStageQueueEntry>(
    options.restoredWaitingStages.map((entry) => [entry.name, entry]),
  );
  let lastResult: 'success' | 'error' = 'success';
  let fatalError = false;

  const resultQueue: NodeStageResult[] = [];
  let notifyResolve: (() => void) | null = null;
  const running = new Set<Promise<void>>();
  const runningNames = new Set<string>();

  const durableCurrentStage = (
    snapshotOptions: SchedulerSnapshotOptions = {},
  ): string | string[] | null => {
    const excluded = new Set(snapshotOptions.excludeRunningStages ?? []);
    const names = [
      ...[...runningNames].filter((name) => !excluded.has(name)),
      ...pendingStages.map((entry) => entry.name),
      ...[...waitingForFanIn.values()].map((entry) => entry.name),
    ].filter((name, index, items) => items.indexOf(name) === index);
    if (names.length === 0) return null;
    return names.length === 1 ? names[0] : names;
  };

  const saveSchedulerState = (
    snapshotOptions: SchedulerSnapshotOptions = {},
  ): void => {
    const excluded = new Set(snapshotOptions.excludeRunningStages ?? []);
    options.saveSnapshot({
      currentStage: durableCurrentStage(snapshotOptions),
      runningStages: [...runningNames].filter((name) => !excluded.has(name)),
      pendingStages,
      waitingStages: [...waitingForFanIn.values()],
      completedStages: options.completedStages,
    });
  };

  const setLastResult = (result: 'success' | 'error'): void => {
    lastResult = result;
  };

  const failPipeline = (): void => {
    lastResult = 'error';
    fatalError = true;
    pendingStages.length = 0;
    waitingForFanIn.clear();
  };

  const waitForResult = (): Promise<void> => {
    if (resultQueue.length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      notifyResolve = resolve;
    });
  };

  const signalResult = (): void => {
    if (notifyResolve) {
      const resolve = notifyResolve;
      notifyResolve = null;
      resolve();
    }
  };

  const launchStage = (entry: PipelineStageQueueEntry): void => {
    if (runningNames.has(entry.name)) return;
    runningNames.add(entry.name);
    const p = options
      .runStage(entry)
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
          stitchInvocation: null,
          stitchPayload: null,
          result: 'error',
        });
        running.delete(p);
        runningNames.delete(entry.name);
        signalResult();
      });
    running.add(p);
  };

  const isStageReady = (stageName: string): boolean =>
    options.isStageReady(stageName, options.completedStages);

  const tryLaunch = (entry: PipelineStageQueueEntry): void => {
    const cfg = options.stagesByName.get(entry.name);
    if (cfg?.chat && running.size > 0) {
      pendingStages.push(entry);
      return;
    }
    launchStage(entry);
  };

  await options.resumeBlockedDispatch?.({
    completedStages: options.completedStages,
    pendingStages,
    waitingForFanIn,
    saveSchedulerState,
    setLastResult,
    failPipeline,
  });

  for (const entry of fatalError ? [] : pendingStages) {
    if (isStageReady(entry.name)) {
      tryLaunch(entry);
    } else {
      waitingForFanIn.set(entry.name, entry);
    }
  }
  pendingStages = [];
  for (const [name, entry] of fatalError
    ? []
    : [...waitingForFanIn.entries()]) {
    if (isStageReady(name)) {
      waitingForFanIn.delete(name);
      tryLaunch(entry);
    }
  }
  saveSchedulerState();

  while (
    running.size > 0 ||
    waitingForFanIn.size > 0 ||
    pendingStages.length > 0
  ) {
    if (options.isAborted()) break;

    if (fatalError) {
      pendingStages.length = 0;
      waitingForFanIn.clear();
    }

    if (!fatalError && pendingStages.length > 0 && running.size === 0) {
      const deferred = [...pendingStages];
      pendingStages = [];
      for (const entry of deferred) {
        tryLaunch(entry);
      }
    }

    if (
      running.size === 0 &&
      resultQueue.length === 0 &&
      pendingStages.length === 0
    ) {
      if (waitingForFanIn.size > 0) {
        logger.warn(
          { waiting: [...waitingForFanIn.keys()] },
          'Fan-in stages stuck - predecessors did not complete',
        );
        lastResult = 'error';
      }
      break;
    }

    saveSchedulerState();
    await waitForResult();

    while (resultQueue.length > 0) {
      const {
        stageName: finishedStage,
        nextStages,
        nextInitialPrompt,
        nextEphemeralSystemPrompt,
        stitchInvocation,
        stitchPayload,
        result,
      } = resultQueue.shift()!;

      if (result === 'error') failPipeline();
      options.recordCompletion(finishedStage);
      if (fatalError) continue;

      let resolvedNextStages = nextStages;
      let resolvedNextInitialPrompt = nextInitialPrompt;
      let resolvedNextEphemeralSystemPrompt = nextEphemeralSystemPrompt;

      if (stitchInvocation) {
        const stitchOutcome = await options.runStitchInvocation(
          stitchInvocation,
          options.completedStages,
          saveSchedulerState,
        );
        if (stitchOutcome === 'error') {
          failPipeline();
          resolvedNextStages = null;
          resolvedNextInitialPrompt = null;
          resolvedNextEphemeralSystemPrompt = null;
        } else {
          resolvedNextStages = stitchInvocation.barrier.downstreamNext;
          const handoff = options.buildPayloadHandoff(
            stitchPayload,
            finishedStage,
            resolvedNextStages,
          );
          resolvedNextInitialPrompt = handoff.nextInitialPrompt;
          resolvedNextEphemeralSystemPrompt = handoff.nextEphemeralSystemPrompt;
          if (nextTargets(resolvedNextStages).length === 0) {
            lastResult = stitchOutcome;
          }
        }
      }

      if (fatalError) continue;
      const targets = nextTargets(resolvedNextStages);
      for (const target of targets) {
        if (
          runningNames.has(target) ||
          pendingStages.some((s) => s.name === target) ||
          waitingForFanIn.has(target)
        ) {
          continue;
        }
        options.recordActivation(target);
        const targetEntry: PipelineStageQueueEntry = {
          name: target,
          initialPrompt:
            targets.length === 1 ? resolvedNextInitialPrompt : null,
          ephemeralSystemPrompt:
            targets.length === 1 ? resolvedNextEphemeralSystemPrompt : null,
        };

        if (isStageReady(target)) {
          tryLaunch(targetEntry);
        } else {
          waitingForFanIn.set(target, targetEntry);
        }
      }
    }

    for (const [name, entry] of fatalError
      ? []
      : [...waitingForFanIn.entries()]) {
      if (isStageReady(name)) {
        waitingForFanIn.delete(name);
        tryLaunch(entry);
      }
    }

    saveSchedulerState();
  }

  await options.finalize(options.completedStages, lastResult);
  return lastResult;
}

export function nextTargets(
  next: string | string[] | null | undefined,
): string[] {
  if (!next) return [];
  return Array.isArray(next) ? next : [next];
}

export function stageEntries(
  names: string[],
  stagesByName: Map<string, PipelineStage>,
  completedStages: string[],
): PipelineStageQueueEntry[] {
  const completedSet = new Set(completedStages);
  const seen = new Set<string>();
  const entries: PipelineStageQueueEntry[] = [];
  for (const name of names) {
    if (seen.has(name) || completedSet.has(name) || !stagesByName.has(name)) {
      continue;
    }
    seen.add(name);
    entries.push({ name });
  }
  return entries;
}

export function normalizeStageEntries(
  entries: PipelineStageQueueEntry[] | undefined,
  stagesByName: Map<string, PipelineStage>,
  completedStages: string[],
): PipelineStageQueueEntry[] {
  const completedSet = new Set(completedStages);
  const seen = new Set<string>();
  const normalized: PipelineStageQueueEntry[] = [];
  for (const entry of entries ?? []) {
    if (
      seen.has(entry.name) ||
      completedSet.has(entry.name) ||
      !stagesByName.has(entry.name)
    ) {
      continue;
    }
    seen.add(entry.name);
    normalized.push(entry);
  }
  return normalized;
}

export function buildPredecessorMap(
  stages: PipelineStage[],
): Map<string, Set<string>> {
  const predecessors = new Map<string, Set<string>>();
  for (const stage of stages) {
    const primary = primaryTransition(stage);
    if (!primary) continue;
    for (const target of nextTargets(primary.next)) {
      let set = predecessors.get(target);
      if (!set) {
        set = new Set();
        predecessors.set(target, set);
      }
      set.add(stage.name);
    }
  }
  return predecessors;
}

export function fanInReady(
  stageName: string,
  predecessors: Map<string, Set<string>>,
  completedStages: string[],
): boolean {
  const deps = predecessors.get(stageName);
  if (!deps || deps.size <= 1) return true;
  const completed = new Set(completedStages);
  return [...deps].every((dep) => completed.has(dep));
}
