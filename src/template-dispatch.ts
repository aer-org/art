import type {
  PipelineConfig,
  PipelineDispatchBarrier,
  PipelineDispatchNode,
  TransitionOutcome,
} from './pipeline-types.js';
import type {
  ResumeDispatchContext,
  SchedulerSnapshotOptions,
} from './node-scheduler.js';
import { logger } from './logger.js';
import { ROOT_DISPATCH_NODE_ID, type StitchInvocation } from './stitch.js';

export class TemplateDispatchState {
  private tree = new Map<string, PipelineDispatchNode>();
  private barriers = new Map<string, PipelineDispatchBarrier>();
  private activeBarrierIds = new Set<string>();

  currentNodeId(scopeId?: string): string {
    return scopeId ?? ROOT_DISPATCH_NODE_ID;
  }

  currentEntryStage(config: PipelineConfig): string | null {
    return config.entryStage ?? config.stages[0]?.name ?? null;
  }

  ensureCurrentNode(
    scopeId: string | undefined,
    config: PipelineConfig,
  ): PipelineDispatchNode {
    const nodeId = this.currentNodeId(scopeId);
    const existing = this.tree.get(nodeId);
    if (existing) {
      existing.config = config;
      existing.entryStage =
        existing.entryStage ?? this.currentEntryStage(config);
      existing.stageNames = config.stages.map((stage) => stage.name);
      return existing;
    }

    const firstDispatch = config.stages.find(
      (stage) => stage.dispatch,
    )?.dispatch;
    const node: PipelineDispatchNode = {
      id: nodeId,
      parentId: firstDispatch?.parentNodeId ?? null,
      originStage: null,
      template: null,
      copyIndex: firstDispatch?.copyIndex ?? null,
      entryStage: this.currentEntryStage(config),
      stageNames: config.stages.map((stage) => stage.name),
      childIds: [],
      status: 'running',
      config,
    };
    this.tree.set(nodeId, node);
    return node;
  }

  serializeTree(
    scopeId: string | undefined,
    config: PipelineConfig,
  ): Record<string, PipelineDispatchNode> {
    this.ensureCurrentNode(scopeId, config);
    return Object.fromEntries(this.tree);
  }

  serializeBarriers(): Record<string, PipelineDispatchBarrier> {
    return Object.fromEntries(this.barriers);
  }

  restoreTree(
    raw: Record<string, PipelineDispatchNode> | undefined,
    scopeId: string | undefined,
    config: PipelineConfig,
  ): void {
    this.tree = new Map(Object.entries(raw ?? {}));
    this.ensureCurrentNode(scopeId, config);
  }

  restoreBarriers(
    raw: Record<string, PipelineDispatchBarrier> | undefined,
  ): void {
    this.barriers = new Map(Object.entries(raw ?? {}));
  }

  restoreActiveBarrierIds(ids: string[] | undefined): void {
    this.activeBarrierIds = new Set(ids ?? []);
  }

  clear(): void {
    this.tree = new Map();
    this.barriers = new Map();
    this.activeBarrierIds = new Set();
  }

  activeBarrierIdsArray(): string[] {
    return [...this.activeBarrierIds];
  }

  activeBarrierCount(): number {
    return this.activeBarrierIds.size;
  }

  addActiveBarrier(id: string): void {
    this.activeBarrierIds.add(id);
  }

  deleteActiveBarrier(id: string): void {
    this.activeBarrierIds.delete(id);
  }

  getBarrier(id: string): PipelineDispatchBarrier | undefined {
    return this.barriers.get(id);
  }

  setBarrier(barrier: PipelineDispatchBarrier): void {
    this.barriers.set(barrier.id, barrier);
  }

  getNode(id: string): PipelineDispatchNode | undefined {
    return this.tree.get(id);
  }

  stageNodeId(
    config: PipelineConfig,
    scopeId: string | undefined,
    stageName: string,
  ): string {
    return (
      config.stages.find((stage) => stage.name === stageName)?.dispatch
        ?.nodeId ?? this.currentNodeId(scopeId)
    );
  }

  registerNodes(
    scopeId: string | undefined,
    config: PipelineConfig,
    nodes: PipelineDispatchNode[],
    parentDispatchNodeId: string,
  ): void {
    this.ensureCurrentNode(scopeId, config);
    const parent = this.tree.get(parentDispatchNodeId);
    if (parent) {
      const childIds = new Set(parent.childIds);
      for (const node of nodes) childIds.add(node.id);
      parent.childIds = [...childIds];
    }
    for (const node of nodes) {
      this.tree.set(node.id, node);
    }
  }

  markNodeSettled(nodeId: string, outcome: TransitionOutcome): void {
    const node = this.tree.get(nodeId);
    if (!node) return;
    node.status = outcome;
  }

  markCurrentNodeSettled(
    scopeId: string | undefined,
    config: PipelineConfig,
    outcome: TransitionOutcome,
  ): void {
    const node = this.ensureCurrentNode(scopeId, config);
    node.status = outcome;
  }

  childConfigForBarrier(
    barrier: PipelineDispatchBarrier,
    childNodeId: string,
  ): PipelineConfig {
    const node = this.tree.get(childNodeId);
    if (!node?.config) {
      throw new Error(
        `Dispatch barrier "${barrier.id}" is missing child config for node "${childNodeId}"`,
      );
    }
    return node.config;
  }

  mergeChild(child: TemplateDispatchState): void {
    for (const [id, node] of child.tree) {
      if (id === ROOT_DISPATCH_NODE_ID) continue;
      const existing = this.tree.get(id);
      if (!existing) {
        this.tree.set(id, { ...node, childIds: [...node.childIds] });
        continue;
      }
      existing.childIds = [
        ...new Set([...existing.childIds, ...node.childIds]),
      ];
      existing.stageNames = [
        ...new Set([...existing.stageNames, ...node.stageNames]),
      ];
      existing.entryStage = node.entryStage;
      existing.config = node.config;
      existing.status = node.status;
    }
    for (const [id, barrier] of child.barriers) {
      this.barriers.set(id, {
        ...barrier,
        childNodeIds: [...barrier.childNodeIds],
        settlements: { ...barrier.settlements },
      });
    }
  }

  evaluateBarrierOutcome(barrier: PipelineDispatchBarrier): TransitionOutcome {
    const values = Object.values(barrier.settlements);
    const successCount = values.filter((value) => value === 'success').length;
    switch (barrier.joinPolicy) {
      case 'all_success':
        return successCount === barrier.childNodeIds.length
          ? 'success'
          : 'error';
      case 'any_success':
        return successCount > 0 ? 'success' : 'error';
      case 'all_settled':
        return 'success';
    }
  }
}

export interface TemplateDispatchRuntime {
  state: TemplateDispatchState;
  scopeId: string | undefined;
  config: PipelineConfig;
  notifyBanner: (text: string) => Promise<void>;
  saveBlockedState: (
    completedStages: string[],
    saveSchedulerState?: (options?: SchedulerSnapshotOptions) => void,
  ) => void;
  settlementFromChildState: (childNodeId: string) => TransitionOutcome | null;
  runChildNode: (
    childNodeId: string,
    childConfig: PipelineConfig,
    resumeExistingState: boolean,
  ) => Promise<{
    result: TransitionOutcome;
    dispatch: TemplateDispatchState;
  }>;
}

export async function runTemplateStitchInvocation(
  runtime: TemplateDispatchRuntime,
  invocation: StitchInvocation,
  completedStages: string[],
  saveSchedulerState?: (options?: SchedulerSnapshotOptions) => void,
): Promise<TransitionOutcome> {
  runtime.state.registerNodes(
    runtime.scopeId,
    runtime.config,
    invocation.children.map((child) => child.node),
    invocation.barrier.ownerNodeId,
  );
  runtime.state.setBarrier(invocation.barrier);

  await runtime.notifyBanner(
    `🧵 Stitched template "${invocation.barrier.template}" after ${invocation.barrier.originStage} — spawned ${invocation.children.length} child node(s)`,
  );

  return runTemplateDispatchBarrier(
    runtime,
    invocation.barrier,
    completedStages,
    saveSchedulerState,
    {
      resumeChildState: false,
      useSavedChildSettlements: false,
    },
  );
}

export async function resumeActiveTemplateDispatchBarriers(
  runtime: TemplateDispatchRuntime,
  ctx: ResumeDispatchContext,
): Promise<void> {
  for (const barrierId of runtime.state.activeBarrierIdsArray()) {
    const barrier = runtime.state.getBarrier(barrierId);
    if (!barrier) {
      runtime.state.deleteActiveBarrier(barrierId);
      continue;
    }
    const outcome = await runTemplateDispatchBarrier(
      runtime,
      barrier,
      ctx.completedStages,
      ctx.saveSchedulerState,
      {
        resumeChildState: true,
        useSavedChildSettlements: true,
      },
    );
    if (outcome === 'error') {
      ctx.failPipeline();
      break;
    }
    const targets = nextTargets(barrier.downstreamNext);
    if (targets.length === 0) {
      ctx.setLastResult(outcome);
      continue;
    }
    for (const target of targets) {
      if (
        ctx.pendingStages.some((entry) => entry.name === target) ||
        ctx.waitingForFanIn.has(target)
      ) {
        continue;
      }
      ctx.pendingStages.push({ name: target });
    }
  }
}

export async function runTemplateDispatchBarrier(
  runtime: TemplateDispatchRuntime,
  barrier: PipelineDispatchBarrier,
  completedStages: string[],
  saveSchedulerState?: (options?: SchedulerSnapshotOptions) => void,
  options: {
    resumeChildState: boolean;
    useSavedChildSettlements: boolean;
  } = { resumeChildState: true, useSavedChildSettlements: true },
): Promise<TransitionOutcome> {
  runtime.state.addActiveBarrier(barrier.id);
  runtime.state.setBarrier(barrier);
  runtime.saveBlockedState(completedStages, saveSchedulerState);

  await Promise.all(
    barrier.childNodeIds.map(async (childNodeId) => {
      if (barrier.settlements[childNodeId]) return;

      const savedOutcome = options.useSavedChildSettlements
        ? runtime.settlementFromChildState(childNodeId)
        : null;
      if (savedOutcome) {
        barrier.settlements[childNodeId] = savedOutcome;
        runtime.state.markNodeSettled(childNodeId, savedOutcome);
        return;
      }

      const childConfig = runtime.state.childConfigForBarrier(
        barrier,
        childNodeId,
      );
      const childNode = runtime.state.getNode(childNodeId);
      if (childNode) childNode.status = 'running';

      let result: TransitionOutcome;
      let childDispatch: TemplateDispatchState | null = null;
      try {
        const child = await runtime.runChildNode(
          childNodeId,
          childConfig,
          options.resumeChildState,
        );
        result = child.result;
        childDispatch = child.dispatch;
      } catch (err) {
        logger.error(
          { childNodeId, err },
          'Stitched child node failed unexpectedly',
        );
        result = 'error';
      }

      if (childDispatch) runtime.state.mergeChild(childDispatch);
      barrier.settlements[childNodeId] = result;
      runtime.state.markNodeSettled(childNodeId, result);
      runtime.state.setBarrier(barrier);
      runtime.saveBlockedState(completedStages, saveSchedulerState);
    }),
  );

  barrier.status = runtime.state.evaluateBarrierOutcome(barrier);
  runtime.state.setBarrier(barrier);
  runtime.state.deleteActiveBarrier(barrier.id);
  runtime.saveBlockedState(completedStages, saveSchedulerState);
  return barrier.status;
}

function nextTargets(next: string | string[] | null | undefined): string[] {
  if (!next) return [];
  return Array.isArray(next) ? next : [next];
}
