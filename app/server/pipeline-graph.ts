import type {
  Graph,
  GraphEdge,
  GraphNode,
  GraphNodeStatus,
  GraphRunContext,
  PipelineConfig,
  PipelineDispatchBarrier,
  PipelineStage,
  PipelineState,
} from './types.ts';

function barrierPseudoId(barrierId: string): string {
  return `barrier_${barrierId}`;
}

function barrierStatusToNodeStatus(
  s: PipelineDispatchBarrier['status'],
): GraphNodeStatus {
  if (s === 'success') return 'success';
  if (s === 'error') return 'error';
  if (s === 'running') return 'running';
  return 'pending';
}

function inferKind(stage: PipelineStage): 'agent' | 'command' {
  return stage.kind ?? (stage.command ? 'command' : 'agent');
}

function asArray(x: string | string[] | null | undefined): string[] {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOccurrences(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function asTime(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stateBelongsToActiveRun(
  state: PipelineState | null,
  runContext?: GraphRunContext,
): boolean {
  if (!runContext?.isRunning && !runContext?.isRunStarting) return true;
  const activeRunStartedAt = asTime(runContext.activeRunStartedAt);
  if (activeRunStartedAt == null) return true;
  const stateUpdatedAt = asTime(state?.lastUpdated);
  return stateUpdatedAt != null && stateUpdatedAt >= activeRunStartedAt;
}

// Fallback for older runs whose state.dispatchBarriers is missing: discover
// stitched copies by the legacy `${origin}__${templateName}<idx>__` naming
// in flat stage lists.
function stitchedEntries(
  origin: string,
  templateName: string,
  stageByName: Map<string, PipelineStage>,
): string[] {
  const prefixPattern = new RegExp(
    `^${escapeRegExp(origin)}__${escapeRegExp(templateName)}(\\d+)__`,
  );
  const groups = new Map<string, { index: number; names: string[] }>();

  for (const name of stageByName.keys()) {
    const match = prefixPattern.exec(name);
    if (!match) continue;
    const prefix = name.slice(0, match[0].length);
    const index = Number(match[1]);
    const group = groups.get(prefix) ?? { index, names: [] };
    group.names.push(name);
    groups.set(prefix, group);
  }

  const entries: Array<{ index: number; name: string }> = [];
  for (const group of groups.values()) {
    const groupNames = new Set(group.names);
    const internalTargets = new Set<string>();
    for (const name of group.names) {
      const stage = stageByName.get(name);
      for (const transition of stage?.transitions ?? []) {
        for (const target of asArray(transition.next)) {
          if (groupNames.has(target)) internalTargets.add(target);
        }
      }
    }
    const entry = group.names.find((name) => !internalTargets.has(name));
    if (entry) entries.push({ index: group.index, name: entry });
  }

  return entries.sort((a, b) => a.index - b.index).map((entry) => entry.name);
}

export function buildGraph(
  config: PipelineConfig | null,
  state: PipelineState | null,
  runContext?: GraphRunContext,
): Graph {
  const effectiveState = stateBelongsToActiveRun(state, runContext) ? state : null;
  const dispatchTree = effectiveState?.dispatchTree;

  // Collect stages from: base config + state.insertedStages + every non-root
  // dispatch node's config. The dispatch nodes carry the per-lane stages
  // produced by stitching (e.g. `fp-init__d_400d365517_0`); without them
  // the graph never shows lane internals.
  const stages: PipelineStage[] = [
    ...(config?.stages ?? []),
    ...(effectiveState?.insertedStages ?? []),
  ];
  const stageOwner = new Map<string, string>(); // stage name → dispatch nodeId
  const stageTemplate = new Map<string, string>(); // stage name → template
  for (const s of config?.stages ?? []) stageOwner.set(s.name, 'root');
  if (dispatchTree) {
    for (const [nodeId, dnode] of Object.entries(dispatchTree)) {
      if (nodeId === 'root') continue; // root.config duplicates the base
      for (const s of dnode.config?.stages ?? []) {
        stages.push(s);
        stageOwner.set(s.name, nodeId);
        if (dnode.template) stageTemplate.set(s.name, dnode.template);
      }
    }
  }

  // Deduplicate by name (insertedStages may overlap on resume)
  const stageByName = new Map<string, PipelineStage>();
  for (const s of stages) stageByName.set(s.name, s);

  const knownNames = new Set(stageByName.keys());
  const baseNames = new Set((config?.stages ?? []).map((s) => s.name));

  const currentSet = new Set(asArray(effectiveState?.currentStage));
  const completed = effectiveState?.completedStages ?? [];
  const completedSet = new Set(completed);
  const completedCounts = countOccurrences(completed);
  const lastCompleted = completed.length > 0 ? completed[completed.length - 1] : null;
  const erroredSet = new Set<string>();

  if (effectiveState?.status === 'error') {
    if (currentSet.size > 0) {
      for (const name of currentSet) erroredSet.add(name);
    } else {
      for (const [name, count] of Object.entries(effectiveState.activations ?? {})) {
        const completions = effectiveState.completions?.[name] ?? 0;
        if (count > completions) erroredSet.add(name);
      }
      for (const [name, count] of Object.entries(effectiveState.completions ?? {})) {
        if (count > (completedCounts.get(name) ?? 0)) erroredSet.add(name);
      }
      if (erroredSet.size === 0 && lastCompleted) erroredSet.add(lastCompleted);
    }
  }

  function statusOf(name: string): GraphNodeStatus {
    if (erroredSet.has(name)) return 'error';
    if (currentSet.has(name)) return 'running';
    if (completedSet.has(name)) return 'success';
    return 'pending';
  }

  const nodes: GraphNode[] = [];
  for (const stage of stageByName.values()) {
    nodes.push({
      id: stage.name,
      name: stage.name,
      kind: inferKind(stage),
      status: statusOf(stage.name),
      isStitched: !baseNames.has(stage.name),
      isTemplatePlaceholder: false,
      nodeId: stageOwner.get(stage.name),
      // For lane stages, expose the template the lane was instantiated
      // from. The frontend uses this to wrap the lane in a containment
      // box matching the template-overview style.
      templateName: stageTemplate.get(stage.name),
    });
  }
  const nodeIds = new Set(nodes.map((node) => node.id));

  // Add an "unknown stage" node if currentStage points at a name we don't know.
  for (const name of currentSet) {
    if (!knownNames.has(name) && !nodeIds.has(name)) {
      nodes.push({
        id: name,
        name,
        kind: 'agent',
        status: erroredSet.has(name) ? 'error' : 'unknown',
        isStitched: false,
        isTemplatePlaceholder: false,
      });
      nodeIds.add(name);
    }
  }

  // Add an unknown failed node if failure accounting names a stage that has not
  // appeared in the graph yet.
  for (const name of erroredSet) {
    if (!knownNames.has(name) && !nodeIds.has(name)) {
      nodes.push({
        id: name,
        name,
        kind: 'agent',
        status: 'error',
        isStitched: false,
        isTemplatePlaceholder: false,
      });
      nodeIds.add(name);
    }
  }

  const edges: GraphEdge[] = [];
  let edgeId = 0;

  // Materialized stitches surface as `dispatchBarriers` in state.
  //
  // Barrier semantics: a barrier is the JOIN at the end of a stitched
  // lane, NOT the spawn point. The origin stage spawns the child
  // lane directly (one edge per child to its entry stage); lane
  // terminals converge at the barrier; the barrier's `downstreamNext`
  // (or cascade target) continues the outer flow.
  //
  // We pre-index barriers by their origin (stage + transition index)
  // so the per-stage loop can emit `origin → entry(child)` straight
  // from each materialized child of the transition's barrier.
  const dispatchBarriers = effectiveState?.dispatchBarriers;
  const barrierByOrigin = new Map<string, PipelineDispatchBarrier>();
  for (const b of Object.values(dispatchBarriers ?? {})) {
    barrierByOrigin.set(`${b.originStage}#${b.originTransitionIdx}`, b);
  }

  for (const stage of stageByName.values()) {
    const txs = stage.transitions ?? [];
    for (let txIdx = 0; txIdx < txs.length; txIdx++) {
      const t = txs[txIdx];
      const targets = asArray(t.next);

      if (t.template) {
        // Materialized? — emit one spawn edge per child lane,
        // straight from origin to that lane's entry stage. The
        // barrier (lane's exit) is emitted by the barrier pass.
        const barrier = barrierByOrigin.get(`${stage.name}#${txIdx}`);
        if (barrier) {
          for (const childId of barrier.childNodeIds) {
            const childNode = dispatchTree?.[childId];
            if (childNode?.entryStage) {
              edges.push({
                id: `e${edgeId++}`,
                source: stage.name,
                target: childNode.entryStage,
                marker: t.marker,
                isTemplate: true,
              });
            }
          }
          continue;
        }

        // Legacy fallback (no dispatchBarriers, e.g. pre-merge state from
        // older runs): retain name-pattern matching for materialized lanes.
        const legacyEntries = stitchedEntries(stage.name, t.template, stageByName);
        if (legacyEntries.length > 0) {
          for (const entry of legacyEntries) {
            edges.push({
              id: `e${edgeId++}`,
              source: stage.name,
              target: entry,
              marker: t.marker,
              isTemplate: true,
            });
          }
          for (const target of targets) {
            edges.push({
              id: `e${edgeId++}`,
              source: stage.name,
              target,
              isTemplate: true,
            });
          }
          continue;
        }

        // Not materialized yet — show a ghost placeholder. Rendered as
        // a collapsed template card so it visually reads as "this
        // template stitch is queued behind the current stage", same
        // shape as the template-overview collapsed state.
        const ghostId = `${stage.name}__template:${t.template}`;
        nodes.push({
          id: ghostId,
          name: t.template,
          kind: 'template',
          status: 'pending',
          isStitched: false,
          isTemplatePlaceholder: true,
          templateName: t.template,
        });
        edges.push({
          id: `e${edgeId++}`,
          source: stage.name,
          target: ghostId,
          marker: t.marker,
          isTemplate: true,
        });
        for (const target of targets) {
          edges.push({
            id: `e${edgeId++}`,
            source: ghostId,
            target,
            isTemplate: true,
          });
        }
        continue;
      }

      for (const target of targets) {
        edges.push({
          id: `e${edgeId++}`,
          source: stage.name,
          target,
          marker: t.marker,
        });
      }
    }
  }

  // Barrier pass: one pseudo-node per materialized stitch + the edges
  // that wire the lane into the surrounding graph. Each barrier appears
  // between its origin stage and its downstreamNext (or hangs as an
  // inner join when the origin's transition has no explicit next, which
  // is the common shape for recursive sub-stitches).
  for (const [bId, barrier] of Object.entries(dispatchBarriers ?? {})) {
    const pseudoId = barrierPseudoId(bId);
    nodes.push({
      id: pseudoId,
      name: barrier.template,
      kind: 'barrier',
      status: barrierStatusToNodeStatus(barrier.status),
      isStitched: false,
      isTemplatePlaceholder: false,
      templateName: barrier.template,
      barrierId: barrier.id,
      ownerNodeId: barrier.ownerNodeId,
      joinPolicy: barrier.joinPolicy,
      downstreamNext: barrier.downstreamNext,
      childNodeIds: [...barrier.childNodeIds],
    });

    // Lane terminals → barrier (the join). One edge per pure terminal
    // transition (next: null AND no template) across all child lanes.
    // Sub-stitch terminals (transitions with `template`) don't need a
    // direct edge — their resolution propagates here via the cascade
    // rule below. The fan-out edge (origin → child entry) was already
    // emitted in the stage transition loop, so the barrier itself has
    // no outgoing fan-out: it sits AFTER the lane, not in front of it.
    for (const childId of barrier.childNodeIds) {
      const childNode = dispatchTree?.[childId];
      for (const s of childNode?.config?.stages ?? []) {
        for (const t of s.transitions ?? []) {
          if (asArray(t.next).length === 0 && !t.template) {
            edges.push({
              id: `e${edgeId++}`,
              source: s.name,
              target: pseudoId,
              marker: t.marker,
              isTemplate: true,
            });
          }
        }
      }
    }

    // Downstream OR cascade. If this barrier has no `downstreamNext`,
    // resolution propagates up to the barrier that spawned the scope
    // containing this barrier's origin. We find that parent by looking
    // for the barrier whose `childNodeIds` includes our `ownerNodeId`
    // — the dispatch model already encodes this relationship.
    if (barrier.downstreamNext) {
      edges.push({
        id: `e${edgeId++}`,
        source: pseudoId,
        target: barrier.downstreamNext,
        isTemplate: true,
      });
    } else {
      const parentId = findParentBarrierId(barrier, dispatchBarriers ?? {});
      if (parentId && parentId !== barrier.id) {
        edges.push({
          id: `e${edgeId++}`,
          source: pseudoId,
          target: barrierPseudoId(parentId),
          isTemplate: true,
        });
      }
    }
  }

  return { nodes, edges };
}

function findParentBarrierId(
  barrier: PipelineDispatchBarrier,
  all: Record<string, PipelineDispatchBarrier>,
): string | null {
  for (const [id, candidate] of Object.entries(all)) {
    if (candidate.childNodeIds?.includes(barrier.ownerNodeId)) return id;
  }
  return null;
}
