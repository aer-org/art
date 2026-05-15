/**
 * Client-side template overview graph builder.
 *
 * Builds the pipeline-as-template view from scratch on every render so
 * expansion changes don't need a server round-trip. The model — one
 * barrier pseudo-node per referenced template, edges per the rules in
 * app/GRAPH-MODEL.md — is shared with the live-run barrier graph; only
 * the metadata source differs (synthesized from the template config vs.
 * pulled from runtime dispatch state).
 *
 * Inputs:
 *   - pipeline:   base PIPELINE.json
 *   - templates:  raw template files, keyed by name
 *   - expanded:   set of template names the user has opened
 *
 * Output: a flat { nodes, edges } graph ready for PipelineGraph layout.
 */
import type {
  GraphEdge,
  GraphNode,
  PipelineSnapshot,
  TemplateFile,
} from './api.ts';

const BARRIER_ID_PREFIX = 'barrier_tpl_';
const BASE_SCOPE = '__base__';

interface BarrierMeta {
  id: string;
  template: string;
  joinPolicy: 'all_success' | 'any_success' | 'all_settled';
  downstreamNext: string | null;
  spawnSites: Array<{
    originId: string;
    marker: string | undefined;
    scopeOfOrigin: string; // template name, or BASE_SCOPE
  }>;
  scopeOfPrimary: string; // template name OR BASE_SCOPE — used for cascade
  stageCount: number;
  retryCount: number; // self-stitches counted across all spawn sites
}

interface BasicStage {
  name: string;
  kind?: 'agent' | 'command';
  command?: string;
  transitions?: Array<{
    marker?: string;
    next?: string | string[] | null;
    template?: string;
    joinPolicy?: 'all_success' | 'any_success' | 'all_settled';
  }>;
}

interface BasicPipeline {
  stages?: BasicStage[];
}

function asArray(x: string | string[] | null | undefined): string[] {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function inferKind(s: BasicStage): 'agent' | 'command' {
  return s.kind ?? (s.command ? 'command' : 'agent');
}

function stageIdInTpl(tplName: string, stageName: string): string {
  return `tpl::${tplName}::${stageName}`;
}

function barrierId(tplName: string): string {
  return `${BARRIER_ID_PREFIX}${tplName}`;
}

/**
 * Walk every `template:` reference reachable from the base pipeline,
 * loading templates' transitions transitively. Returns the set of
 * referenced template names.
 */
function collectReferencedTemplates(
  pipeline: BasicPipeline | null | undefined,
  templates: Record<string, TemplateFile>,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const s of pipeline?.stages ?? []) {
    for (const t of s.transitions ?? []) {
      if (t.template && !seen.has(t.template)) {
        seen.add(t.template);
        queue.push(t.template);
      }
    }
  }
  while (queue.length > 0) {
    const name = queue.shift()!;
    const tpl = templates[name];
    if (!tpl) continue;
    for (const s of tpl.stages ?? []) {
      for (const t of s.transitions ?? []) {
        if (t.template && !seen.has(t.template)) {
          seen.add(t.template);
          queue.push(t.template);
        }
      }
    }
  }
  return seen;
}

/**
 * Walk every `template:` transition in every visible scope and bucket
 * the spawn sites by template. While walking, lock in each barrier's
 * `downstreamNext` to the first non-null `next` we see (the primary
 * spawn) and remember the scope it was in so we can compute cascade
 * targets later.
 *
 * "Visible scope" = base pipeline + each template (we still want to
 * collect spawn metadata for templates that are collapsed — the spawn
 * may be invisible, but downstreamNext determination should still
 * happen consistently).
 */
function buildBarrierTable(
  pipeline: BasicPipeline | null | undefined,
  templates: Record<string, TemplateFile>,
  referenced: Set<string>,
): Map<string, BarrierMeta> {
  const out = new Map<string, BarrierMeta>();

  function ensure(tplName: string): BarrierMeta {
    const existing = out.get(tplName);
    if (existing) return existing;
    const tpl = templates[tplName];
    const fresh: BarrierMeta = {
      id: barrierId(tplName),
      template: tplName,
      joinPolicy: 'all_success',
      downstreamNext: null,
      spawnSites: [],
      scopeOfPrimary: '',
      stageCount: tpl?.stages?.length ?? 0,
      retryCount: 0,
    };
    out.set(tplName, fresh);
    return fresh;
  }
  for (const t of referenced) ensure(t);

  function visit(
    stages: BasicStage[] | undefined,
    scope: string,
    idFor: (stageName: string) => string,
  ): void {
    for (const s of stages ?? []) {
      for (const t of s.transitions ?? []) {
        if (!t.template) continue;
        const meta = ensure(t.template);
        const nextVal =
          (Array.isArray(t.next) ? t.next[0] : t.next) ?? null;
        meta.spawnSites.push({
          originId: idFor(s.name),
          marker: t.marker,
          scopeOfOrigin: scope,
        });
        if (nextVal != null && meta.downstreamNext == null) {
          meta.downstreamNext = nextVal;
          meta.scopeOfPrimary = scope;
          meta.joinPolicy = t.joinPolicy ?? 'all_success';
        }
        if (t.template === scope) meta.retryCount += 1;
      }
    }
  }

  visit(pipeline?.stages, BASE_SCOPE, (name) => name);
  for (const tplName of referenced) {
    const tpl = templates[tplName];
    visit(tpl?.stages, tplName, (name) => stageIdInTpl(tplName, name));
  }

  // Templates whose every spawn has null `next` still need a
  // `scopeOfPrimary` for the cascade rule. Pick the first non-self
  // spawn; fall back to the first spawn if all are self-stitches; fall
  // back to base if there are no spawns at all (shouldn't happen for
  // referenced templates).
  for (const meta of out.values()) {
    if (meta.scopeOfPrimary) continue;
    const nonSelf = meta.spawnSites.find(
      (s) => s.scopeOfOrigin !== meta.template,
    );
    meta.scopeOfPrimary =
      nonSelf?.scopeOfOrigin ??
      meta.spawnSites[0]?.scopeOfOrigin ??
      BASE_SCOPE;
  }

  return out;
}

export function buildTemplateOverviewGraph(
  snapshot: PipelineSnapshot,
  expanded: Set<string>,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const pipeline = (snapshot.pipeline as BasicPipeline | null | undefined) ?? {
    stages: [],
  };
  const templates = snapshot.templates ?? {};

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIds = new Set<string>();
  let edgeId = 0;
  const seenEdge = new Set<string>();

  function addNode(n: GraphNode): void {
    if (nodeIds.has(n.id)) return;
    nodes.push(n);
    nodeIds.add(n.id);
  }
  function addEdge(e: Omit<GraphEdge, 'id'>): void {
    const key = `${e.source}\0${e.target}\0${e.marker ?? ''}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    edges.push({ id: `e${edgeId++}`, ...e });
  }

  // ---- 1) Base stages always visible
  for (const s of pipeline.stages ?? []) {
    addNode({
      id: s.name,
      name: s.name,
      kind: inferKind(s),
      status: 'pending',
      isStitched: false,
      isTemplatePlaceholder: false,
    });
  }

  // ---- 2) Expanded template stages
  for (const tplName of expanded) {
    const tpl = templates[tplName];
    if (!tpl) continue;
    for (const s of tpl.stages ?? []) {
      addNode({
        id: stageIdInTpl(tplName, s.name),
        name: s.name,
        kind: inferKind(s),
        status: 'pending',
        isStitched: true,
        isTemplatePlaceholder: false,
        templateName: tplName,
      });
    }
  }

  // ---- 3) Barrier metadata + visibility filter
  const referenced = collectReferencedTemplates(pipeline, templates);
  const barriers = buildBarrierTable(pipeline, templates, referenced);

  function scopeVisible(scope: string): boolean {
    return scope === BASE_SCOPE || expanded.has(scope);
  }

  // A barrier is visible if its primary scope is visible (otherwise it
  // represents a stitch from a still-collapsed inner template). The
  // template's collapsed pill is replaced by the barrier itself, so
  // there's no separate pill node — the barrier IS the placeholder.
  const visibleBarriers = new Map<string, BarrierMeta>();
  for (const [tplName, meta] of barriers) {
    if (!scopeVisible(meta.scopeOfPrimary)) continue;
    visibleBarriers.set(tplName, meta);
    addNode({
      id: meta.id,
      name: meta.template,
      kind: 'barrier',
      status: 'pending',
      isStitched: false,
      isTemplatePlaceholder: false,
      templateName: meta.template,
      joinPolicy: meta.joinPolicy,
      downstreamNext: meta.downstreamNext,
      templateStageCount: meta.stageCount,
      templateSelfStitches: meta.retryCount,
    });
  }

  // ---- 4) Edges
  // 4a) Intra-template stage transitions for every expanded template.
  for (const tplName of expanded) {
    const tpl = templates[tplName];
    if (!tpl) continue;
    for (const s of tpl.stages ?? []) {
      const srcId = stageIdInTpl(tplName, s.name);
      for (const t of s.transitions ?? []) {
        const nexts = asArray(t.next);
        // Plain stage-to-stage transition inside the same template.
        for (const nxt of nexts) {
          addEdge({
            source: srcId,
            target: stageIdInTpl(tplName, nxt),
            marker: t.marker,
          });
        }
        // Pure terminal (next: null, no template): join into this scope's barrier.
        if (nexts.length === 0 && !t.template) {
          const b = visibleBarriers.get(tplName);
          if (b) {
            addEdge({
              source: srcId,
              target: b.id,
              marker: t.marker,
              isTemplate: true,
            });
          }
        }
      }
    }
  }

  // 4b) Per-barrier wiring: spawn invocations, fan-out, downstream/cascade.
  for (const b of visibleBarriers.values()) {
    // Incoming: each spawn site whose origin is currently visible.
    for (const site of b.spawnSites) {
      if (!nodeIds.has(site.originId)) continue;
      addEdge({
        source: site.originId,
        target: b.id,
        marker: site.marker,
        isTemplate: true,
      });
    }

    // Fan-out: when the template is expanded, point at its entry stage.
    // When collapsed, no fan-out edge — the barrier alone represents
    // the unopened lane.
    if (expanded.has(b.template)) {
      const tpl = templates[b.template];
      const entryName = tpl?.entry ?? tpl?.stages?.[0]?.name;
      if (entryName) {
        addEdge({
          source: b.id,
          target: stageIdInTpl(b.template, entryName),
          isTemplate: true,
        });
      }
    }

    // Downstream OR cascade to parent.
    if (b.downstreamNext) {
      addEdge({
        source: b.id,
        target: b.downstreamNext,
        isTemplate: true,
      });
    } else if (b.scopeOfPrimary !== BASE_SCOPE) {
      const parent = visibleBarriers.get(b.scopeOfPrimary);
      // Skip self-cascade (would form a 0-length loop on the same node).
      if (parent && parent.id !== b.id) {
        addEdge({
          source: b.id,
          target: parent.id,
          isTemplate: true,
        });
      }
    }
  }

  return { nodes, edges };
}

export function isTemplateStageId(id: string): boolean {
  return id.startsWith('tpl::');
}

export function templateOfStageId(id: string): string | null {
  if (!isTemplateStageId(id)) return null;
  const m = /^tpl::([^:]+)::/.exec(id);
  return m ? m[1] : null;
}
