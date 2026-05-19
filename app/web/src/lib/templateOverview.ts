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

/**
 * Compute the set of spawn-site keys (`originId\0targetTemplate`) that
 * are *back-edges* in the template DAG — i.e. a stitch that points to
 * a template that already sits earlier in topological order. Includes
 * self-stitches (origin scope === target template) and any cross-
 * template stitch that loops back to a sibling already laid out before
 * the source.
 *
 * Renderer uses this to swap the edge to `RetryEdge` (curved arc) so
 * the user can tell "forward to a new lane" from "back to an already-
 * shown lane" — without it, dagre routes the back-edge through whatever
 * happens to be between the two templates and the visual cue is lost.
 */
function computeBackEdgeKeys(
  barriers: Map<string, BarrierMeta>,
): Set<string> {
  // 1) Template→template graph from cross spawns. Base origins and
  //    self-stitches are excluded from topo so they don't distort rank.
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const t of barriers.keys()) {
    inDeg.set(t, 0);
    adj.set(t, []);
  }
  for (const [target, meta] of barriers) {
    for (const site of meta.spawnSites) {
      const src = site.scopeOfOrigin;
      if (src === BASE_SCOPE || src === target) continue;
      adj.get(src)?.push(target);
      inDeg.set(target, (inDeg.get(target) ?? 0) + 1);
    }
  }
  // 2) Kahn's topological sort, alphabetic tie-break for stability.
  const rank = new Map<string, number>();
  const q: string[] = [];
  for (const [t, d] of inDeg) if (d === 0) q.push(t);
  q.sort();
  let nextRank = 0;
  while (q.length > 0) {
    const cur = q.shift()!;
    rank.set(cur, nextRank++);
    const next: string[] = [];
    for (const nb of adj.get(cur) ?? []) {
      const d = (inDeg.get(nb) ?? 0) - 1;
      inDeg.set(nb, d);
      if (d === 0) next.push(nb);
    }
    next.sort();
    q.push(...next);
  }
  // 3) Templates left without a rank are in a cycle. Assign ascending
  //    ranks alphabetically so the back-edge selection is deterministic
  //    across reloads.
  const stragglers = [...barriers.keys()]
    .filter((k) => !rank.has(k))
    .sort();
  for (const k of stragglers) rank.set(k, nextRank++);

  // 4) A spawn is a back-edge iff origin's rank >= target's rank.
  //    Self-stitches satisfy this with equality. Base-origin spawns
  //    are forward by definition (base sits "above" every template).
  const out = new Set<string>();
  for (const [target, meta] of barriers) {
    const targetRank = rank.get(target)!;
    for (const site of meta.spawnSites) {
      if (site.scopeOfOrigin === BASE_SCOPE) continue;
      const srcRank = rank.get(site.scopeOfOrigin);
      if (srcRank === undefined) continue;
      if (srcRank >= targetRank) {
        out.add(`${site.originId}\0${target}`);
      }
    }
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
      localName: s.name,
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
        localName: s.name,
      });
    }
  }

  // ---- 3) Barrier metadata + visibility filter
  const referenced = collectReferencedTemplates(pipeline, templates);
  const barriers = buildBarrierTable(pipeline, templates, referenced);
  const backEdgeKeys = computeBackEdgeKeys(barriers);

  function scopeVisible(scope: string): boolean {
    return scope === BASE_SCOPE || expanded.has(scope);
  }

  // A barrier-entity is visible if its primary scope is visible
  // (otherwise it represents a stitch from a still-collapsed inner
  // template). The node kind shifts with expansion state — these are
  // two visual roles for the same entity:
  //   - Collapsed (`kind: 'template'`): substantial card that signals
  //     "click here to open this template". Doubles as the placeholder
  //     for the hidden lane: spawn lands on it, cascade exits from it.
  //   - Expanded (`kind: 'barrier'`): small sync-point lozenge at the
  //     visible lane's exit. Lane terminals converge here, cascade /
  //     downstream leaves from here.
  // Same id in both cases so edges don't have to re-route on toggle.
  const visibleBarriers = new Map<string, BarrierMeta>();
  for (const [tplName, meta] of barriers) {
    if (!scopeVisible(meta.scopeOfPrimary)) continue;
    visibleBarriers.set(tplName, meta);
    const isOpen = expanded.has(meta.template);
    addNode({
      id: meta.id,
      name: meta.template,
      kind: isOpen ? 'barrier' : 'template',
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
  // 4a-base) Plain transitions between base-pipeline stages. Stage
  // chains like `cleanup → init → summarize` only exist in the base
  // pipeline (no template), so they aren't picked up by the per-
  // template or per-barrier loops below. Skip transitions that
  // already participate in a barrier wiring (template-bearing) since
  // those are emitted in 4b.
  for (const s of pipeline.stages ?? []) {
    for (const t of s.transitions ?? []) {
      if (t.template) continue; // 4b handles template-bearing transitions
      const nexts = asArray(t.next);
      for (const nxt of nexts) {
        if (!nodeIds.has(nxt)) continue;
        addEdge({
          source: s.name,
          target: nxt,
          marker: t.marker,
        });
      }
    }
  }

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

  // 4b) Per-barrier wiring:
  //
  // The barrier sits AFTER the lane (join point), not before it. So:
  //   - Spawn: origin → entry(X) directly, OR origin → ⋈X when X is
  //     collapsed (the barrier doubles as the lane placeholder then).
  //   - Lane terminals (pure terminals only — sub-stitches cascade) →
  //     ⋈X. Handled above in 4a for expanded templates.
  //   - Post-join: ⋈X → downstreamNext OR cascade to ⋈parent.
  for (const b of visibleBarriers.values()) {
    const isOpen = expanded.has(b.template);

    // Spawn edges: one per visible spawn site. Edges that point to a
    // template earlier in topological order (self-stitches plus any
    // cross-template back-stitch) get tagged `isRetry` so the renderer
    // can arc around them — otherwise dagre would slice straight back
    // through whatever templates sit between source and target.
    for (const site of b.spawnSites) {
      if (!nodeIds.has(site.originId)) continue;
      const isRetry = backEdgeKeys.has(`${site.originId}\0${b.template}`);
      if (isOpen) {
        // Lane is visible — spawn straight into the entry stage.
        const tpl = templates[b.template];
        const entryName = tpl?.entry ?? tpl?.stages?.[0]?.name;
        if (entryName) {
          addEdge({
            source: site.originId,
            target: stageIdInTpl(b.template, entryName),
            marker: site.marker,
            isTemplate: true,
            isRetry,
          });
        }
      } else {
        // Lane is hidden — the barrier stands in for it. Spawn lands
        // on the barrier itself, which from the user's perspective IS
        // the collapsed template card.
        addEdge({
          source: site.originId,
          target: b.id,
          marker: site.marker,
          isTemplate: true,
          isRetry,
        });
      }
    }

    // Post-join: downstream OR cascade to parent's barrier.
    if (b.downstreamNext) {
      addEdge({
        source: b.id,
        target: b.downstreamNext,
        isTemplate: true,
      });
    } else if (b.scopeOfPrimary !== BASE_SCOPE) {
      const parent = visibleBarriers.get(b.scopeOfPrimary);
      // Skip self-cascade.
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

// Note: the `tpl::<name>::<stage>` id format is an internal unique-key
// scheme for the overview graph (base stage names can collide with
// stages inside templates). Consumers must never parse it — read
// `templateName` and `localName` off the GraphNode itself, both of
// which are set by every builder.
