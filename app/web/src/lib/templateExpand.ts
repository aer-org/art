/**
 * Client-side template overview expansion.
 *
 * The server emits the collapsed overview (each template = one pill) plus
 * the raw template definitions (`snapshot.templates`). When the user
 * clicks a template pill, we recompute the graph on the client without a
 * round-trip: replace each expanded pill with its internal stage DAG,
 * and re-route incoming/outgoing template edges to point at the correct
 * stage (entry for in-bound, originating stage for out-bound).
 *
 * Recursive self-stitch: if a template is expanded and one of its stages
 * has `template: <self>`, the edge becomes a back-edge from that stage
 * to the template's entry stage.
 */
import type {
  GraphEdge,
  GraphNode,
  PipelineSnapshot,
  TemplateFile,
} from './api.ts';

const TPL_PREFIX = 'tpl:';

export function expandTemplateGraph(
  snapshot: PipelineSnapshot,
  expanded: Set<string>,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const base = snapshot.graph ?? { nodes: [], edges: [] };
  const templates = snapshot.templates ?? {};

  // Pipeline base stages we don't touch beyond keeping them.
  // Outputs.
  const outNodes: GraphNode[] = [];
  const outEdges: GraphEdge[] = [];
  let edgeId = 0;
  const seenEdge = new Set<string>();
  function addEdge(e: Omit<GraphEdge, 'id'>): void {
    const k = `${e.source}\0${e.target}\0${e.marker ?? ''}`;
    if (seenEdge.has(k)) return;
    seenEdge.add(k);
    outEdges.push({ id: `e${edgeId++}`, ...e });
  }

  // Copy over base stages + collapsed template pills (templates not in
  // `expanded`). Drop pills for templates that ARE being expanded.
  for (const n of base.nodes) {
    if (n.kind === 'template') {
      const tplName = n.templateName ?? n.name;
      if (expanded.has(tplName)) continue; // dropped — stages take its place
    }
    outNodes.push(n);
  }

  // Resolve a target identifier in a stage transition to the right node id
  // (collapsed pill, expanded entry stage, or pass-through for plain
  // stage names). Returns null when the reference cannot be resolved.
  function resolveTemplateTarget(targetTpl: string): string | null {
    if (expanded.has(targetTpl)) {
      const tpl = templates[targetTpl];
      const entryName = tpl?.entry ?? tpl?.stages?.[0]?.name;
      if (!entryName) return null;
      return tagStage(targetTpl, entryName);
    }
    return `${TPL_PREFIX}${targetTpl}`;
  }

  // Carry over edges from the base graph, redirecting any endpoint that
  // points at a pill we just removed.
  //
  // Out-bound from an expanded template (`tpl:X → Y`): post-stitch hops
  // (e.g. `tpl:SF → summarize`, induced by `init`'s `next: summarize`)
  // do not originate from any individual lane stage — they're a property
  // of the *scope*, mediated by the barrier that joins the stitch. So we
  // attach the edge to the containment box itself (`group:X → Y`) rather
  // than picking a lane terminal stage, which would mis-imply that the
  // stage transitions there directly.
  //
  // In-bound to an expanded template (`X → tpl:Y`): redirect to Y's
  // entry stage so the user sees which stage flow enters.
  for (const e of base.edges) {
    const sourceTpl =
      e.source.startsWith(TPL_PREFIX) &&
      expanded.has(e.source.slice(TPL_PREFIX.length))
        ? e.source.slice(TPL_PREFIX.length)
        : null;
    const newTarget =
      e.target.startsWith(TPL_PREFIX) &&
      expanded.has(e.target.slice(TPL_PREFIX.length))
        ? resolveTemplateTarget(e.target.slice(TPL_PREFIX.length))
        : e.target;
    if (!newTarget) continue;

    const newSource = sourceTpl ? `group:${sourceTpl}` : e.source;
    addEdge({
      source: newSource,
      target: newTarget,
      marker: e.marker,
      isTemplate: e.isTemplate,
    });
  }

  // Expand each requested template: emit its stages as nodes and wire
  // their transitions. Stage names are namespaced (tpl::stage) so two
  // expanded templates that happen to share a stage name don't collide.
  for (const tplName of expanded) {
    const tpl = templates[tplName];
    if (!tpl) continue;
    for (const s of tpl.stages ?? []) {
      const tagged = tagStage(tplName, s.name);
      outNodes.push({
        id: tagged,
        name: s.name,
        kind: s.kind ?? (s.command ? 'command' : 'agent'),
        status: 'pending',
        isStitched: true,
        isTemplatePlaceholder: false,
        // tag with the template it belongs to — used by the containment
        // box renderer in PipelineGraph.
        templateName: tplName,
      });
      for (const t of s.transitions ?? []) {
        const targets = asArray(t.next);
        // Plain `next` → another stage in the SAME template.
        for (const nxt of targets) {
          addEdge({
            source: tagged,
            target: tagStage(tplName, nxt),
            marker: t.marker,
          });
        }
        // Template stitch — could be self-stitch or cross-template.
        if (t.template) {
          const tgt = resolveTemplateTarget(t.template);
          if (tgt) {
            addEdge({
              source: tagged,
              target: tgt,
              marker: t.marker,
              isTemplate: true,
            });
          }
        }
      }
    }
  }

  return { nodes: outNodes, edges: outEdges };
}

function tagStage(tplName: string, stageName: string): string {
  return `tpl::${tplName}::${stageName}`;
}

export function isTemplateStageId(id: string): boolean {
  return id.startsWith('tpl::');
}

export function templateOfStageId(id: string): string | null {
  if (!isTemplateStageId(id)) return null;
  const m = /^tpl::([^:]+)::/.exec(id);
  return m ? m[1] : null;
}

function asArray(x: string | string[] | null | undefined): string[] {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}
