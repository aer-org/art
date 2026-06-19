# Graph Model — Unified Barrier Pseudo-Node Design

This document captures the design philosophy for the visualizer's
pipeline graph. It is the source of truth for what nodes/edges go into a
graph regardless of whether the graph is a live-run snapshot or a static
template overview.

## Goal

One graph model for two surfaces:

1. **Live-run graph** (RunDetail page, `buildGraph` in
   `app/server/pipeline-graph.ts`): renders an in-flight or sealed run's
   actual dispatch state. Barriers exist as concrete runtime objects with
   status, settlements, ownerNodeId.
2. **Template overview** (Live page when no run is active,
   `buildTemplateOverviewGraph` in `app/web/src/lib/templateOverview.ts`,
   client-side only): renders the *space* of possible flows declared
   by `PIPELINE.json` + `templates/*.json`, independent of any run.
   Barriers are *synthesized* from the static template structure.

Both views render the same topology. The only difference is whether
barriers carry runtime metadata (status, settlements) or only structural
metadata (originStage, template, joinPolicy, downstreamNext).

## Core abstraction: barrier pseudo-node

A `template:X` transition does not "go to" anything directly. It spawns
a **stitch** — N lanes of the X template run in parallel; when they
settle per `joinPolicy`, control resumes at `next`. The thing that
represents this fan-out + join + resume operation in the graph is a
**barrier pseudo-node**:

- `kind: 'barrier'`
- `templateName`: the template being stitched
- `joinPolicy`: `all_success` | `any_success` | `all_settled`
- `downstreamNext`: the host transition's `next` (may be null)
- Live runs also carry `status`, `settlements`, `childNodeIds`, `barrierId`,
  `ownerNodeId` — template overview synthesizes these as static-only fields.

There is **one barrier per template** in the template overview. (Live
runs may have multiple if the same template is stitched repeatedly with
distinct invocation ids — the live-run code keys barriers by their
runtime invocation id.)

## Edge rules around a barrier B

**Barrier semantics: the barrier is the JOIN at the *end* of the lane,
not a spawn point in front of it.** A `template: X, next: N` transition
spawns the child lane directly; the barrier ⋈X collects lane terminals
and feeds the post-stitch hop. When X is collapsed there are no lane
stages to draw, so ⋈X also doubles as the visible placeholder for the
unopened lane — the spawn edge then lands on the barrier itself.

For each barrier B with `templateName = X`:

| Edge | When |
|---|---|
| `origin_stage → entry(X)` | for each spawn site of X, **when X is expanded**; lands on X's first stage (marker = host transition's marker) |
| `origin_stage → B` | for each spawn site of X, **when X is collapsed**; the barrier stands in for the hidden lane |
| `lane_terminal(X) → B` | for every "pure terminal" transition (`next: null` AND no `template`) in any stage of X, **when X is expanded** |
| `B → downstreamNext` | iff `downstreamNext` is set |
| `B → parent_barrier` | iff `downstreamNext` is null AND a parent exists (cascade) |

Sub-stitch terminals (transitions with `template`) do NOT get a direct
lane-terminal edge. Their resolution propagates here via the sub-
barrier's cascade — drawing both would double-count the join.

### Cascade rule

When B has no `downstreamNext`, control returns "up the scope chain".
The **parent_barrier** is the unique barrier that stitched the scope
containing B's origin stage:

- If B's origin stage is in the base pipeline → no parent (terminate).
- If B's origin stage is in template T → parent is the barrier for T
  (i.e., `B(T)`).

For self-stitches (origin in template T, `template: T`), parent would
be `B(T)` itself. Filter the self-cascade — the back-edge to entry
(`origin → entry(T)`) already represents the retry loop.

### `downstreamNext` selection (template overview only)

A template X may be stitched from many sites with different `next`
values. For the synthesized barrier `B(X)`, pick the first non-null
`next` across all spawn transitions; fall back to null. (In the user's
pipeline this is unambiguous — only the canonical spawn has non-null
next; retries always have `next: null`.)

## Worked example (`VLSI_design_flow` pipeline)

Pipeline + templates:

- `init` (base) STAGE_COMPLETE → `template: shrink-floorplan, next: summarize`
- `summarize` (base) — terminal
- `shrink-floorplan` template: fp-init → fp-guard → fp-plan → fp-run → fp-filter
  - fp-filter STAGE_COMPLETE → `template: shrink-powerplan, next: null`
  - fp-filter STAGE_ERROR → `template: shrink-floorplan, next: null` (retry)
- `shrink-powerplan`: pp-init → ... → pp-filter
  - pp-filter STAGE_COMPLETE → `template: shrink-pnr, next: null`
  - pp-filter STAGE_ERROR → `template: shrink-powerplan, next: null` (retry)
- `shrink-pnr` → … → `shrink-chip-finish-eco` → `shrink-eco-iter`
  (each with a retry self-stitch)

Synthesized barriers:

| Barrier | Origin scope | downstreamNext | Out-edge |
|---|---|---|---|
| `B(SF)` | base (init) | `summarize` | → `summarize` |
| `B(PP)` | SF | null | → `B(SF)` (cascade) |
| `B(PNR)` | PP | null | → `B(PP)` |
| `B(CFE)` | PNR | null | → `B(PNR)` |
| `B(eco-iter)` | CFE | null | → `B(CFE)` |

Fully collapsed (nothing expanded):

```
init  =STAGE_COMPLETE=>  ⋈B(SF)  →  summarize
```

The barrier is the lane placeholder; the unopened lane is hidden
inside it.

`SF` expanded — the lane spreads between `init` (the spawn) and the
barrier (the join):

```
                                                             [lane abandonment]
                                                            ┌───────────────────┐
                                                            │ STAGE_ERROR       │
                                                            ▼                   ▼
init =STAGE_COMPLETE=> fp-init → fp-guard → fp-plan → fp-run → fp-filter   ⋈B(SF) → summarize
                                                            ▲                   ▲
                                                            │                   │
                            fp-filter =STAGE_ERROR=> fp-init (retry back-edge)  │ (cascade)
                            fp-filter =STAGE_COMPLETE=> ⋈B(PP) ─────────────────┘
```

`SF` + `PP` expanded (both lanes between their respective spawns and
joins; cascade chain visible):

```
init → fp-init → ... → fp-filter →[STAGE_COMPLETE]→ pp-guard → ... → pp-filter →[STAGE_COMPLETE]→ ⋈B(PNR)
                                                                            │                       │
                                                                            │ (PP lane abandonment) │ (cascade)
                                                                            ▼                       ▼
                                                                          ⋈B(PP)         ←──────────┘
                                                                            │
                                                                            │ (cascade, PP.next=null)
                                                                            ▼
                                                                          ⋈B(SF) → summarize
```

The cascade chain `⋈B(PNR) → ⋈B(PP) → ⋈B(SF) → summarize` matches the
user's intuition: "child template이 모두 종료돼야 summarize로 갈 수
있고, child가 전부 success여야지 갈 수 있다." Each layer of nested
stitch adds one cascade hop.

## Why this generalizes

- Arbitrary depth of nested stitches: every barrier whose downstream is
  null cascades one level up. The chain length equals the stitch depth.
- Retries collapse into a back-edge to the template's entry
  (origin → entry(X) inside the expanded template) — no extra
  retry-barrier needed. The retry still settles into the same `B(X)`.
- Live runs and template overviews share the same topology — only
  `kind: 'barrier'` node metadata differs (live nodes carry status etc.).

## Implementation notes for template overview

The template-overview graph is rebuilt **on the client** any time
expansion state changes. Inputs:

- `pipeline: PipelineConfig` (from snapshot)
- `templates: Record<name, TemplateFile>` (from snapshot)
- `expanded: Set<string>` (local UI state)

Steps:

1. Walk visible stages: `pipeline.stages` ∪ `templates[t].stages` for
   each `t` in `expanded`. Determine which templates are referenced.
2. For each unique template T referenced anywhere → synthesize `B(T)`
   with `downstreamNext = first non-null next across all spawn
   transitions for T`. There are no separate pill nodes — `B(T)` IS
   the placeholder when T is collapsed.
3. Add nodes: base stages, expanded template stages, synthesized
   barriers.
4. Add edges per the rules in the table above. Spawn-edge target
   depends on whether T is currently expanded.
5. For barrier cascades:
   - For each `B(T)` with `downstreamNext = null`, determine its
     parent template T_parent = "the template (or base) containing the
     primary spawn site of T". Emit `B(T) → B(T_parent)` (or to
     base-stage equivalent if T_parent is base; usually unused because
     base spawns always carry an explicit `next`).
   - Skip self-cascades.

The template-overview graph is built entirely on the client. The
server snapshot ships `pipeline` + `templates` and an empty graph in
overview mode; `buildTemplateOverviewGraph` consumes them and rebuilds
the graph in response to per-template expansion toggles without a
round-trip.

Live-run `buildGraph` implements the same node/edge shape: every
spawn site emits `origin → child.entryStage` directly, the barrier
sits at the lane's exit, and downstream/cascade behave as above.

## Containment box (visual only)

When a template is expanded, its lane stages are wrapped in a dashed
accent box (`templateGroup` node, layout via inner sub-dagre + outer
dagre). The box is **purely visual grouping** — never an edge endpoint.
All semantic edges (entry, terminal join, cascade) attach to the
**barrier**, not the box.
