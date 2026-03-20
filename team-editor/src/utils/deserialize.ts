import { type Node, type Edge, MarkerType } from '@xyflow/react';
import type { PipelineConfig, PipelineStage, PipelineTransition, AgentConfig } from '../types';
import { DEFAULT_AGENT_FILES } from '../types';

const X_GAP = 300;
const Y_GAP = 200;

/**
 * Ensure a stage has transitions array.
 */
function ensureTransitions(stage: PipelineStage): PipelineTransition[] {
  if (stage.transitions && stage.transitions.length > 0) return stage.transitions;
  return [
    { marker: 'STAGE_COMPLETE', next: null },
    { marker: 'STAGE_ERROR', retry: true, prompt: '환경/도구/설정 에러' },
  ];
}

export function deserialize(config: PipelineConfig): { nodes: Node[]; edges: Edge[] } {
  const stages = config.stages;
  const stageMap = new Map<string, PipelineStage>();
  stages.forEach((s) => stageMap.set(s.name, s));

  // Normalize transitions
  stages.forEach((s) => {
    s.transitions = ensureTransitions(s);
  });

  // BFS from entry stage along first non-retry transition (STAGE_COMPLETE equivalent) to determine columns
  let entryName: string;
  if (config.entryStage && stageMap.has(config.entryStage)) {
    entryName = config.entryStage;
  } else {
    // Heuristic: prefer stages that have outgoing non-retry transitions with targets
    const hasIncoming = new Set<string>();
    const hasOutgoing = new Set<string>();
    for (const s of stages) {
      for (const t of s.transitions) {
        if (!t.retry && t.next) {
          hasOutgoing.add(s.name);
          hasIncoming.add(t.next);
        }
      }
    }
    const preferred = stages.find((s) => !hasIncoming.has(s.name) && hasOutgoing.has(s.name));
    const fallback = stages.find((s) => !hasIncoming.has(s.name));
    const loopFallback = stages.find((s) => hasOutgoing.has(s.name));
    entryName = (preferred ?? fallback ?? loopFallback ?? stages[0]).name;
  }
  const colMap = new Map<string, number>();
  const queue: string[] = [entryName];
  colMap.set(entryName, 0);

  while (queue.length > 0) {
    const name = queue.shift()!;
    const stage = stageMap.get(name);
    if (!stage) continue;
    const col = colMap.get(name)!;

    // Follow all non-retry transitions for layout
    for (const t of stage.transitions) {
      if (!t.retry && t.next && !colMap.has(t.next)) {
        colMap.set(t.next, col + 1);
        queue.push(t.next);
      }
    }
  }

  // Place any stages not reached
  let maxCol = Math.max(0, ...colMap.values());
  stages.forEach((s) => {
    if (!colMap.has(s.name)) {
      colMap.set(s.name, ++maxCol);
    }
  });

  // Group by column for vertical stacking
  const colGroups = new Map<number, string[]>();
  stages.forEach((s) => {
    const col = colMap.get(s.name)!;
    if (!colGroups.has(col)) colGroups.set(col, []);
    colGroups.get(col)!.push(s.name);
  });

  const nodes: Node[] = stages.map((stage) => {
    const col = colMap.get(stage.name)!;
    const group = colGroups.get(col)!;
    const row = group.indexOf(stage.name);
    return {
      id: stage.name,
      type: 'stageNode',
      position: { x: 50 + col * X_GAP, y: 50 + row * Y_GAP },
      data: { stage, isEntry: stage.name === entryName },
    };
  });

  const edges: Edge[] = [];
  stages.forEach((stage) => {
    for (const t of stage.transitions) {
      if (t.retry || !t.next) continue;
      const isFirst = stage.transitions.indexOf(t) === 0;
      const color = isFirst ? '#22c55e' : '#ef4444';
      edges.push({
        id: `${stage.name}-${t.marker}-${t.next}`,
        source: stage.name,
        target: t.next,
        sourceHandle: t.marker,
        type: 'default',
        style: isFirst
          ? { stroke: color, strokeWidth: 3, filter: 'drop-shadow(0 0 3px rgba(34, 197, 94, 0.4))' }
          : { stroke: color, strokeWidth: 3, strokeDasharray: '6 3', filter: 'drop-shadow(0 0 3px rgba(239, 68, 68, 0.4))' },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 20, height: 20 },
        animated: false,
      });
    }
  });

  return { nodes, edges };
}

interface AgentTeamJson {
  agents: { name: string; folder: string }[];
}

export function deserializeTeam(
  teamJson: AgentTeamJson,
  pipelines: Map<string, PipelineConfig>,
): AgentConfig[] {
  return teamJson.agents.map((entry) => ({
    name: entry.name,
    folder: entry.folder,
    pipeline: pipelines.get(entry.folder) || { stages: [] },
    files: { ...DEFAULT_AGENT_FILES },
  }));
}
