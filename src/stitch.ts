/**
 * Tree-based stitch core.
 *
 * A template transition materializes child dispatch nodes. The parent graph is
 * not mutated and no synthetic join stage is created. Fan-in is represented by
 * a parent-owned dispatch barrier.
 */
import { createHash } from 'crypto';

import type { PipelineTemplate } from './pipeline-template.js';
import type {
  JoinPolicy,
  PipelineConfig,
  PipelineDispatchBarrier,
  PipelineDispatchNode,
  PipelineStage,
  PipelineTransition,
} from './pipeline-types.js';

export const STITCH_SUBSTITUTION_FIELDS: readonly string[] = [
  'prompt',
  'mounts',
  'hostMounts',
  'env',
  'image',
  'command',
  'successMarker',
  'errorMarker',
  'transitions',
];

// Reserved substitution keys that callers may not include in per-copy
// substitution maps. They are injected by stitch core.
export const RESERVED_SUBSTITUTION_KEYS = ['index', 'insertId'] as const;

const SUBSTITUTION_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export const ROOT_DISPATCH_NODE_ID = 'root';

export type SubstitutionValue = string | number | boolean;
export type SubstitutionMap = Record<string, SubstitutionValue>;

export interface StitchChildRun {
  node: PipelineDispatchNode;
  config: PipelineConfig;
  entryName: string;
}

export interface StitchInvocation {
  invocationId: string;
  barrier: PipelineDispatchBarrier;
  children: StitchChildRun[];
}

export interface BuildStitchInvocationInput {
  originStage: string;
  originTransitionIdx: number;
  template: PipelineTemplate;
  downstreamNext: string | null;
  joinPolicy: JoinPolicy;
  parentDispatchNodeId?: string;
  mode: 'single' | 'parallel';
  count?: number;
  substitutions?: SubstitutionMap;
  perCopySubstitutions?: SubstitutionMap[];
  invocationId?: string;
}

export function dispatchInvocationIdFor(
  parentDispatchNodeId: string,
  originStage: string,
  originTransitionIdx: number,
  templateName: string,
): string {
  const hash = createHash('sha1')
    .update(
      `${parentDispatchNodeId}\0${originStage}\0${originTransitionIdx}\0${templateName}`,
    )
    .digest('hex')
    .slice(0, 10);
  return `d_${hash}`;
}

export function dispatchStageName(
  invocationId: string,
  copyIndex: number,
  stageName: string,
): string {
  return `${invocationId}_${copyIndex}__${stageName}`;
}

export function dispatchChildNodeId(
  invocationId: string,
  copyIndex: number,
): string {
  return `${invocationId}_${copyIndex}`;
}

export function buildStitchInvocation(
  input: BuildStitchInvocationInput,
): StitchInvocation {
  const {
    originStage,
    originTransitionIdx,
    template,
    downstreamNext,
    joinPolicy,
  } = input;
  const parentDispatchNodeId =
    input.parentDispatchNodeId ?? ROOT_DISPATCH_NODE_ID;
  const invocationId =
    input.invocationId ??
    dispatchInvocationIdFor(
      parentDispatchNodeId,
      originStage,
      originTransitionIdx,
      template.name,
    );
  const count = input.mode === 'parallel' ? (input.count ?? 1) : 1;
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(
      `buildStitchInvocation: count must be a positive integer, got ${count}`,
    );
  }

  const children: StitchChildRun[] = [];
  for (let i = 0; i < count; i++) {
    const childNodeId = dispatchChildNodeId(invocationId, i);
    const subs: SubstitutionMap = {
      insertId: childNodeId,
      index: i,
      ...(input.mode === 'parallel'
        ? (input.perCopySubstitutions?.[i] ?? {})
        : (input.substitutions ?? {})),
    };
    const stages = cloneTemplateCopyForNode(
      template,
      originStage,
      i,
      subs,
      invocationId,
      parentDispatchNodeId,
    );
    const entryName = dispatchStageName(invocationId, i, template.entry);
    const config: PipelineConfig = { stages, entryStage: entryName };
    assertNoNameCollision(config);
    assertConfigAcyclic(config);
    children.push({
      node: {
        id: childNodeId,
        parentId: parentDispatchNodeId,
        originStage,
        template: template.name,
        copyIndex: i,
        entryStage: entryName,
        stageNames: stages.map((stage) => stage.name),
        childIds: [],
        status: 'pending',
        config,
      },
      config,
      entryName,
    });
  }

  return {
    invocationId,
    barrier: {
      id: invocationId,
      ownerNodeId: parentDispatchNodeId,
      originStage,
      originTransitionIdx,
      template: template.name,
      childNodeIds: children.map((child) => child.node.id),
      joinPolicy,
      downstreamNext,
      settlements: {},
      status: 'running',
    },
    children,
  };
}

export function assertConfigAcyclic(config: PipelineConfig): void {
  const stageNames = new Set(config.stages.map((s) => s.name));
  const adj = new Map<string, Set<string>>();
  for (const s of config.stages) {
    const out = new Set<string>();
    for (const t of s.transitions) {
      for (const target of transitionTargets(t)) {
        if (stageNames.has(target)) out.add(target);
      }
    }
    adj.set(s.name, out);
  }

  const UNVISITED = 0;
  const ON_STACK = 1;
  const DONE = 2;
  const state = new Map<string, number>();
  for (const s of config.stages) state.set(s.name, UNVISITED);

  const dfs = (node: string, stack: string[]): void => {
    state.set(node, ON_STACK);
    stack.push(node);
    for (const nxt of adj.get(node) ?? []) {
      const c = state.get(nxt);
      if (c === ON_STACK) {
        const from = stack.indexOf(nxt);
        const cyclePath = [...stack.slice(from), nxt].join(' -> ');
        throw new Error(`Cycle detected in pipeline config: ${cyclePath}`);
      }
      if (c === UNVISITED) dfs(nxt, stack);
    }
    stack.pop();
    state.set(node, DONE);
  };

  for (const s of config.stages) {
    if (state.get(s.name) === UNVISITED) dfs(s.name, []);
  }
}

export function assertNoNameCollision(config: PipelineConfig): void {
  const seen = new Set<string>();
  for (const s of config.stages) {
    if (seen.has(s.name)) {
      throw new Error(`Duplicate stage name after stitch: "${s.name}"`);
    }
    seen.add(s.name);
  }
}

function transitionTargets(t: PipelineTransition): string[] {
  if (t.next == null) return [];
  return Array.isArray(t.next) ? t.next : [t.next];
}

function cloneTemplateCopyForNode(
  template: PipelineTemplate,
  origin: string,
  copyIndex: number,
  subs: SubstitutionMap,
  invocationId: string,
  parentDispatchNodeId: string,
): PipelineStage[] {
  const rename = (n: string): string =>
    dispatchStageName(invocationId, copyIndex, n);
  const childNodeId = dispatchChildNodeId(invocationId, copyIndex);

  return template.stages.map((stage) => {
    const renamed: PipelineStage = {
      ...stage,
      name: rename(stage.name),
      dispatch: {
        nodeId: childNodeId,
        parentNodeId: parentDispatchNodeId,
        invocationId,
        copyIndex,
        localName: stage.name,
      },
      transitions: stage.transitions.map((t) =>
        rewireTransitionForNode(t, rename),
      ),
    };
    const substituted = applySubstitutionsToStage(renamed, subs);
    assertNoUnresolvedPlaceholders(substituted, origin, template.name);
    return substituted;
  });
}

function rewireTransitionForNode(
  t: PipelineTransition,
  rename: (n: string) => string,
): PipelineTransition {
  const out: PipelineTransition = { ...t };
  if (typeof t.next === 'string') {
    out.next = rename(t.next);
  } else {
    // Authored `next: null` means this child node has reached its terminal edge.
    out.next = null;
  }
  return out;
}

function applySubstitutionsToStage(
  stage: PipelineStage,
  subs: SubstitutionMap,
): PipelineStage {
  const out: PipelineStage = { ...stage };
  const rec = out as unknown as Record<string, unknown>;
  for (const field of STITCH_SUBSTITUTION_FIELDS) {
    if (!(field in rec)) continue;
    rec[field] = substituteValue(rec[field], subs);
  }
  return out;
}

function substituteValue(value: unknown, subs: SubstitutionMap): unknown {
  if (typeof value === 'string') return substituteString(value, subs);
  if (Array.isArray(value)) return value.map((v) => substituteValue(v, subs));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const newKey = substituteString(k, subs);
      out[newKey] = substituteValue(v, subs);
    }
    return out;
  }
  return value;
}

function substituteString(text: string, subs: SubstitutionMap): string {
  return text.replace(SUBSTITUTION_PATTERN, (match, key: string) => {
    if (!(key in subs)) return match;
    return String(subs[key]);
  });
}

function assertNoUnresolvedPlaceholders(
  stage: PipelineStage,
  origin: string,
  templateName: string,
): void {
  for (const field of STITCH_SUBSTITUTION_FIELDS) {
    const value = (stage as unknown as Record<string, unknown>)[field];
    if (value === undefined) continue;
    const unresolved = collectPlaceholders(value);
    if (unresolved.size > 0) {
      const keys = [...unresolved].map((k) => `{{${k}}}`).join(', ');
      throw new Error(
        `Unresolved placeholder(s) ${keys} in stitched stage "${stage.name}" field "${field}" (origin: "${origin}", template: "${templateName}"). The substitution map did not provide values for these keys.`,
      );
    }
  }
}

function collectPlaceholders(value: unknown): Set<string> {
  const found = new Set<string>();
  walkPlaceholders(value, found);
  return found;
}

function walkPlaceholders(value: unknown, acc: Set<string>): void {
  if (typeof value === 'string') {
    for (const m of value.matchAll(SUBSTITUTION_PATTERN)) {
      acc.add(m[1]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) walkPlaceholders(v, acc);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      walkPlaceholders(k, acc);
      walkPlaceholders(v, acc);
    }
  }
}
