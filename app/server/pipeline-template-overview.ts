/**
 * "Template overview" graph — shown on Live tab when no run is in
 * progress. Each unique template (and each base-pipeline stage that
 * references templates) appears once. Stitch transitions are edges
 * between template nodes; recursive self-stitches collapse into a
 * self-loop on the template instead of expanding into a new node.
 *
 * This view is intentionally distinct from the per-stage post-stitch
 * graph (built by buildGraph in pipeline-graph.ts). The post-stitch
 * graph shows the materialized lanes of a specific run; the template
 * overview shows the *space of possible flows* before any run.
 */
import fs from 'fs';
import path from 'path';

import type {
  Graph,
  GraphEdge,
  GraphNode,
  PipelineConfig,
  PipelineStage,
} from './types.ts';

export interface TemplateFile {
  entry?: string;
  stages: PipelineStage[];
}

function asArray(x: string | string[] | null | undefined): string[] {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

/**
 * Walk pipeline.stages, follow every `template:` reference transitively,
 * and return the raw template files. Used so the client can expand a
 * template inline without round-tripping to the server. Same containment
 * check as readTemplate.
 */
export function collectReferencedTemplates(
  config: PipelineConfig | null,
  artDir: string,
): Record<string, TemplateFile> {
  const out: Record<string, TemplateFile> = {};
  const queue: string[] = [];
  const seen = new Set<string>();
  function enqueue(name: string): void {
    if (seen.has(name)) return;
    seen.add(name);
    queue.push(name);
  }
  for (const s of config?.stages ?? []) {
    for (const t of s.transitions ?? []) {
      if (t.template) enqueue(t.template);
    }
  }
  while (queue.length > 0) {
    const name = queue.shift()!;
    const tpl = readTemplate(artDir, name);
    if (!tpl) continue;
    out[name] = tpl;
    for (const s of tpl.stages ?? []) {
      for (const t of s.transitions ?? []) {
        if (t.template) enqueue(t.template);
      }
    }
  }
  return out;
}

const AGENT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function readTemplate(
  artDir: string,
  name: string,
): TemplateFile | null {
  // Mirrors src/pipeline-template.ts:resolveTemplatePath containment check.
  const dir = path.join(artDir, 'templates');
  const resolved = path.resolve(dir, `${name}.json`);
  const rel = path.relative(dir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try {
    const raw = fs.readFileSync(resolved, 'utf-8');
    const tpl = JSON.parse(raw) as TemplateFile;
    // Best-effort agent-ref inlining (read-only) so the overview
    // inspector can render template-internal agent prompts.
    for (const stage of tpl.stages ?? []) {
      const ref = (stage as { agent?: string }).agent;
      const existing = (stage as { prompt?: string }).prompt;
      if (!ref || existing) continue;
      if (!AGENT_REF_PATTERN.test(ref)) continue;
      try {
        (stage as { prompt?: string }).prompt = fs.readFileSync(
          path.join(artDir, 'agents', `${ref}.md`),
          'utf-8',
        );
        (stage as { promptSource?: string }).promptSource = `agents/${ref}.md`;
      } catch {
        /* leave prompt empty */
      }
    }
    return tpl;
  } catch {
    return null;
  }
}

function inferKind(stage: PipelineStage): 'agent' | 'command' {
  return (stage.kind as 'agent' | 'command' | undefined) ??
    (stage.command ? 'command' : 'agent');
}

export function buildTemplateOverview(
  config: PipelineConfig | null,
  artDir: string,
): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();
  let edgeId = 0;

  function addNode(n: GraphNode): void {
    if (nodeIds.has(n.id)) return;
    nodes.push(n);
    nodeIds.add(n.id);
  }

  // Edge dedup — same stitch edge can be reached via multiple stages.
  const edgeKeys = new Set<string>();
  function addEdge(e: Omit<GraphEdge, 'id'>): void {
    const key = `${e.source}\0${e.target}\0${e.marker ?? ''}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ id: `e${edgeId++}`, ...e });
  }

  // Track per-template self-stitch count so the template node can render
  // a retry badge ("↻×N").
  const selfStitches = new Map<string, number>();

  // 1. Base pipeline stages: add each as a normal stage node.
  for (const s of config?.stages ?? []) {
    addNode({
      id: s.name,
      name: s.name,
      kind: inferKind(s),
      status: 'pending',
      isStitched: false,
      isTemplatePlaceholder: false,
    });
  }

  // 2. Worklist BFS over templates referenced from anywhere.
  const queue: string[] = [];
  const seen = new Set<string>();
  function enqueueTemplate(t: string): void {
    if (seen.has(t)) return;
    seen.add(t);
    queue.push(t);
  }

  // Seed: emit every base-stage transition (plain edges + template
  // references). Plain transitions with `next: "B"` or `next: ["B", "C"]`
  // produce one edge per target so fan-out is visible in the static
  // overview view too. Template transitions also drop a `tpl:` node and
  // a post-stitch return edge for each `next` target.
  for (const s of config?.stages ?? []) {
    for (const t of s.transitions ?? []) {
      if (t.template) {
        enqueueTemplate(t.template);
        addEdge({
          source: s.name,
          target: `tpl:${t.template}`,
          marker: t.marker,
          isTemplate: true,
        });
        // Optional post-stitch return-to: if the host transition has a
        // concrete `next`, draw it from the template back to that stage so
        // the user can see where this stitch resumes after join.
        for (const n of asArray(t.next)) {
          addEdge({
            source: `tpl:${t.template}`,
            target: n,
            isTemplate: true,
          });
        }
      } else {
        for (const target of asArray(t.next)) {
          addEdge({
            source: s.name,
            target,
            marker: t.marker,
          });
        }
      }
    }
  }

  // Body: each template adds its own outgoing stitch edges + enqueues
  // newly-referenced templates.
  while (queue.length > 0) {
    const name = queue.shift()!;
    const tpl = readTemplate(artDir, name);
    const tplId = `tpl:${name}`;
    addNode({
      id: tplId,
      name,
      kind: 'template',
      status: 'pending',
      isStitched: false,
      isTemplatePlaceholder: false,
      templateName: name,
      templateStageCount: tpl?.stages.length ?? 0,
      templateSelfStitches: 0, // back-filled below
    });

    if (!tpl) continue;
    for (const s of tpl.stages ?? []) {
      for (const t of s.transitions ?? []) {
        if (!t.template) continue;
        const targetId = `tpl:${t.template}`;
        if (t.template === name) {
          selfStitches.set(name, (selfStitches.get(name) ?? 0) + 1);
        } else {
          enqueueTemplate(t.template);
        }
        addEdge({
          source: tplId,
          target: targetId,
          marker: t.marker,
          isTemplate: true,
        });
      }
    }
  }

  for (const n of nodes) {
    if (n.kind === 'template' && selfStitches.has(n.templateName ?? '')) {
      n.templateSelfStitches = selfStitches.get(n.templateName ?? '') ?? 0;
    }
  }

  return { nodes, edges };
}
