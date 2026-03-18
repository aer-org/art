import type { Node, Edge } from '@xyflow/react';
import type { PipelineConfig, PipelineStage, AgentConfig } from '../types';

export interface ValidationError {
  message: string;
}

export function validate(nodes: Node[], edges: Edge[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const names = nodes.map((n) => n.id);

  if (nodes.length === 0) {
    errors.push({ message: 'At least one stage is required' });
    return errors;
  }

  // Check unique names
  const seen = new Set<string>();
  for (const name of names) {
    if (!name) errors.push({ message: 'Stage name cannot be empty' });
    if (seen.has(name)) errors.push({ message: `Duplicate stage name: "${name}"` });
    seen.add(name);
  }

  // Check edge targets exist
  for (const edge of edges) {
    if (!seen.has(edge.target)) {
      errors.push({ message: `Edge target "${edge.target}" does not exist` });
    }
  }

  // Check no node has multiple edges from the same handle (marker)
  const edgeCounts = new Map<string, number>();
  for (const edge of edges) {
    const key = `${edge.source}:${edge.sourceHandle}`;
    edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
    if (edgeCounts.get(key)! > 1) {
      errors.push({ message: `Stage "${edge.source}" has multiple ${edge.sourceHandle} connections` });
    }
  }

  return errors;
}

export function serialize(
  nodes: Node[],
  edges: Edge[],
  errorPolicy: PipelineConfig['errorPolicy'],
  entryStage?: string,
): PipelineConfig {
  // Build edge lookup: source+handle(marker) -> target
  const edgeMap = new Map<string, string>();
  for (const edge of edges) {
    edgeMap.set(`${edge.source}:${edge.sourceHandle}`, edge.target);
  }

  // Find entry node: use explicit entryStage if set, else heuristic
  let entry: Node | undefined;
  if (entryStage) {
    entry = nodes.find((n) => n.id === entryStage);
  }
  if (!entry) {
    const hasIncoming = new Set<string>();
    const hasOutgoing = new Set<string>();
    for (const edge of edges) {
      hasIncoming.add(edge.target);
      hasOutgoing.add(edge.source);
    }
    // Prefer nodes without incoming that DO have outgoing (avoid picking standalone dead-ends)
    entry = nodes.find((n) => !hasIncoming.has(n.id) && hasOutgoing.has(n.id));
    // Fallback: any node without incoming
    if (!entry) entry = nodes.find((n) => !hasIncoming.has(n.id));
    // Fallback for full loops: prefer node with outgoing edges
    if (!entry) entry = nodes.find((n) => hasOutgoing.has(n.id));
  }
  if (!entry) entry = nodes[0];

  // Topological sort: walk first non-retry transition chain
  const ordered: string[] = [];
  const visited = new Set<string>();

  let current: string | undefined = entry.id;
  while (current && !visited.has(current)) {
    visited.add(current);
    ordered.push(current);
    // Find the first non-retry transition's edge
    const node = nodes.find((n) => n.id === current);
    const stage = node?.data?.stage as PipelineStage | undefined;
    if (stage?.transitions) {
      const firstNonRetry = stage.transitions.find((t) => !t.retry);
      if (firstNonRetry) {
        current = edgeMap.get(`${current}:${firstNonRetry.marker}`) || undefined;
      } else {
        current = undefined;
      }
    } else {
      current = undefined;
    }
  }

  // Append remaining nodes
  for (const node of nodes) {
    if (!visited.has(node.id)) ordered.push(node.id);
  }

  const nodeMap = new Map<string, Node>();
  nodes.forEach((n) => nodeMap.set(n.id, n));

  const stages: PipelineStage[] = ordered.map((name) => {
    const node = nodeMap.get(name)!;
    const stage: PipelineStage = { ...(node.data.stage as PipelineStage) };
    stage.name = name;

    // Update transitions' next targets from edges
    stage.transitions = (stage.transitions || []).map((t) => {
      if (t.retry) return { ...t };
      const target = edgeMap.get(`${name}:${t.marker}`) || null;
      return { ...t, next: target };
    });

    return stage;
  });

  const config: PipelineConfig = { stages, errorPolicy };
  if (entryStage && nodes.some((n) => n.id === entryStage)) {
    config.entryStage = entryStage;
  }
  return config;
}

// AGENT_TEAM.json structure mirrors the runtime format
interface AgentTeamEntry {
  name: string;
  folder: string;
}

export function serializeTeam(agents: AgentConfig[]): {
  teamJson: string;
  pipelines: Map<string, string>;
} {
  const team: { agents: AgentTeamEntry[] } = {
    agents: agents.map((a) => ({ name: a.name, folder: a.folder })),
  };

  const pipelines = new Map<string, string>();
  for (const agent of agents) {
    pipelines.set(agent.folder, JSON.stringify(agent.pipeline, null, 2));
  }

  return {
    teamJson: JSON.stringify(team, null, 2),
    pipelines,
  };
}
