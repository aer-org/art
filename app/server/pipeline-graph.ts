import type {
  Graph,
  GraphEdge,
  GraphNode,
  GraphNodeStatus,
  GraphRunContext,
  PipelineConfig,
  PipelineStage,
  PipelineState,
} from './types.ts';

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
  const stages: PipelineStage[] = [
    ...(config?.stages ?? []),
    ...(effectiveState?.insertedStages ?? []),
  ];

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
  for (const stage of stageByName.values()) {
    for (const t of stage.transitions ?? []) {
      const targets = asArray(t.next);

      if (t.template) {
        // Template placeholder: dashed ghost node between this stage and t.next (or terminal).
        const ghostId = `${stage.name}__template:${t.template}`;
        // Only add the ghost if the template has not materialized yet. Once it
        // has, connect the host transition to each stitched copy's entry node.
        const materializedEntries = stitchedEntries(stage.name, t.template, stageByName);
        const materialized = materializedEntries.length > 0;
        if (!materialized) {
          nodes.push({
            id: ghostId,
            name: t.template,
            kind: 'agent',
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

        for (const entry of materializedEntries) {
          edges.push({
            id: `e${edgeId++}`,
            source: stage.name,
            target: entry,
            marker: t.marker,
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

  return { nodes, edges };
}
