# Plan: Payload-driven parallel fanout

Follow-up to `PLAN_typed_transition.md`. Restores the dynamic lane count
and per-copy substitution behavior that the pre-stitch `dynamic-fanout`
stage kind provided, on top of the current typed-transition / stitch
schema.

## Motivation

The stitch-based transitions shipped so far only support **static**
parallel fanout: `{ template, count: N }` with lane count baked into the
JSON and substitutions limited to `{{index}}` / `{{insertId}}`. Real
workloads (imcflow `PIPELINE_B_PARALLEL_v1.json`, and any per-ID /
per-section enumerate-then-fanout flow) need two things the current
schema can't express:

1. **Dynamic lane count**: the planner agent decides at runtime how many
   lanes to spawn (one per discovered ID / section / variant). Hardcoding
   the count in the JSON defeats the whole pattern.
2. **Per-copy custom substitutions**: each lane needs distinct field
   values (`{{id}}`, `{{kind}}`, `{{filename}}`, whatever the planner
   emits), not just the lane index.

The `stitch.ts` core already supports this — `stitchParallel`'s
`perCopySubstitutions: SubstitutionMap[]` parameter is plumbed through
to `cloneTemplateCopy`. It just isn't reachable from JSON because
`handleStageResult` only calls `performStitch(template, count)` with a
static count and no per-copy subs. This plan wires a payload → stitch
path and exposes the capability at the transition schema level.

## Target schema

```jsonc
// Payload-driven parallel stitch
{
  "marker": "PLAN_READY",
  "template": "per_id",
  "countFrom": "payload",          // lane count = payload array length
  "substitutionsFrom": "payload"   // lane i subs = payload[i] object's fields
}
```

Rules:

- `countFrom: "payload"` is mutually exclusive with `count`. Either you
  hardcode `count: N` at authoring time, or you defer count to the
  marker payload — never both.
- `substitutionsFrom: "payload"` requires `countFrom: "payload"`. (No
  "static count + dynamic subs" combo — the payload is the single
  source of truth in dynamic mode, and mixing would be error-prone.)
- Both fields require `template`. Without `template`, they are meaningless.
- `{{index}}` and `{{insertId}}` remain available in all modes — they're
  always injected by the stitch core and take precedence is not
  required (payload fields use their own keys, no collision by design).

The three supported parallel forms end up being:

| Transition shape                                                                | Count                 | Per-copy subs            |
| ------------------------------------------------------------------------------- | --------------------- | ------------------------ |
| `{ template, count: N }`                                                        | N (literal)           | index + insertId only    |
| `{ template, countFrom: "payload" }`                                            | len(payload)          | index + insertId only    |
| `{ template, countFrom: "payload", substitutionsFrom: "payload" }`              | len(payload)          | payload[i] fields + idx  |

Single stitch (`{ template }` without `count*`) is unchanged.

## Payload format

Reuse the existing fenced-block convention already supported by
`parseStageMarkers` (`src/pipeline-runner.ts:274`). The agent emits:

```
[PLAN_READY]
---PAYLOAD_START---
[
  { "id": "stim_foo",  "kind": "stimulus", "filename": "stim_foo.sv" },
  { "id": "mon_bar",   "kind": "monitor",  "filename": "mon_bar.sv" },
  { "id": "probe_baz", "kind": "probe",    "filename": "probe_baz.sv" }
]
---PAYLOAD_END---
```

The runtime:

1. Already parses the fenced block → `matched.payload` as a raw string.
2. In the new dispatch branch, parses it as JSON.
3. Validates it's a **non-empty array of flat objects** whose values are
   strings / numbers / booleans (the existing `SubstitutionValue` union).
4. Derives `count = payload.length`, `perCopySubstitutions = payload`.

Empty array, non-array, nested objects, or non-primitive values → the
stitch fails with a clear error, transition resolves as `STAGE_ERROR`
(same failure path as a stitch throw today).

## Type changes (`src/pipeline-runner.ts`)

```ts
export interface PipelineTransition {
  marker: string;
  next?: string | string[] | null;
  template?: string;
  count?: number;
  countFrom?: 'payload';                     // NEW
  substitutionsFrom?: 'payload';             // NEW
  prompt?: string;
}
```

Narrow the value space to the single literal `'payload'` for now — if we
later add other sources (config file, env var, sibling-stage output) we
expand the union deliberately.

## Validator changes

### `loadPipelineConfig` (base) + `validatePipelineTemplate`

Both layers enforce the same rules (factor into a shared helper or keep
two copies — same pattern as typed-transition mutex). On top of the
existing rules:

- Reject `countFrom` with any value other than `"payload"`.
- Reject `substitutionsFrom` with any value other than `"payload"`.
- Reject `countFrom` without `template`.
- Reject `countFrom` together with `count` (mutual exclusion —
  dynamic vs static).
- Reject `substitutionsFrom` without `countFrom` (forbid "static count +
  dynamic subs" to keep the matrix simple).

No change needed in `stitch.ts` validator functions — the graph-level
invariants (acyclic DAG, name collision) apply only after stitch runs
with concrete count/subs, which the runtime handles per dispatch.

## Runtime dispatch (`handleStageResult`)

Extend the `matched.template` branch introduced by
`PLAN_typed_transition.md`:

```ts
if (matched.template) {
  const { count, perCopySubs } = resolveStitchInputs(matched, /* payload */);
  const stitched = this.performStitch(
    stageConfig,
    stageConfig.transitions.indexOf(matched),
    matched.template,
    count,
    perCopySubs,                               // NEW
  );
  // …register inserted stages, set targetName to stitched.newNext…
}
```

`resolveStitchInputs` is a small pure helper that returns a tagged
stitch directive:

```ts
type StitchDirective =
  | { mode: 'single'; subs?: SubstitutionMap }
  | { mode: 'parallel'; count: number; perCopySubs?: SubstitutionMap[] };
```

| Transition shape                                                  | Directive                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------- |
| `{ template }`                                                    | `{ mode: 'single' }`                                          |
| `{ template, count: 1 }`                                          | `{ mode: 'single' }`                                          |
| `{ template, count: N }` (N ≥ 2)                                  | `{ mode: 'parallel', count: N }`                              |
| `{ template, countFrom: "payload" }` — payload length 1           | `{ mode: 'single', subs: payload[0] }`                        |
| `{ template, countFrom: "payload" }` — payload length N ≥ 2       | `{ mode: 'parallel', count: N, perCopySubs: payload }` (subs only when `substitutionsFrom: "payload"`) |

Rationale for the length-1 collapse: a 1-lane parallel stitch
synthesizes a useless barrier stage that waits for exactly one
predecessor. Routing length-1 payloads through `stitchSingle` keeps the
graph clean (no vestigial `{origin}__{template}__barrier` when there's
nothing to fan-in), reuses `stitchSingle`'s existing `substitutions`
field for the per-copy map, and still honors `{{id}}` etc. substitution.
Users don't observe any semantic difference — only a cleaner graph.

Payload parsing / validation lives in `resolveStitchInputs`. Error paths:

- No payload captured on the marker → error (transition authored as
  dynamic but agent didn't emit fenced block).
- Payload not JSON → error.
- Payload not an array, empty array, or element isn't a flat primitive
  object → error.
- Element uses reserved key `index` / `insertId` → error.

Each error is logged with `{ stage, template, reason }` and returned as a
`STAGE_ERROR` outcome (same shape as existing stitch-failure path at
`pipeline-runner.ts:1579-1585`).

`performStitch` changes to dispatch on the directive:

```ts
private performStitch(
  stageConfig: PipelineStage,
  transitionIdx: number,
  templateName: string,
  directive: StitchDirective,
): { insertedStages: PipelineStage[]; newNext: string | string[] }
```

`mode: 'single'` → `stitchSingle({ ..., substitutions: directive.subs })`.
`mode: 'parallel'` → `stitchParallel({ ..., count: directive.count, perCopySubstitutions: directive.perCopySubs })`.

## Stitch core changes (`src/stitch.ts`)

Almost nothing. Two small items:

1. **Add `transitions` to `STITCH_SUBSTITUTION_FIELDS`.** Current
   whitelist at `stitch.ts:22-33` covers stage-level fields only.
   Real-world templates (see imcflow `templates/per_id.pipeline.json`)
   put `{{id}}` and `{{kind}}` inside `transitions[].prompt`. Without
   `transitions` in the whitelist those placeholders never get
   substituted. Adding it lets `substituteValue`'s existing recursion
   reach into the array and objects.
2. **No API change** — `stitchParallel`'s `perCopySubstitutions` is
   already the right shape. Confirm `applySubstitutionsToStage` merges
   `{insertId, index}` *with* `perCopySubstitutions[i]` (it does:
   `stitch.ts:168-173`).

Edge case: a payload field named `index` or `insertId` would shadow the
lane metadata. Either (a) reserve those two keys and reject payloads
that use them, or (b) let payload win (user-intentional override).
Recommend **(a)** — reject with a clear error. Keeps `{{index}}`
semantics predictable.

## Documentation

### `docs/PIPELINE-REFERENCE.md`

Under *Templates & Stitch* → *Transition forms*, add a fourth form:

```jsonc
{ "marker": "PLAN_READY", "template": "per_id",
  "countFrom": "payload", "substitutionsFrom": "payload" }
```

And a new subsection *Payload-driven fanout* with:
- Fenced-block payload example.
- Payload shape requirements (array of flat primitive-valued objects).
- Interaction with `{{insertId}}` / `{{index}}` (they still apply per
  lane index; `index` / `insertId` as payload keys are rejected).
- Error behavior (bad payload → STAGE_ERROR).

### `.claude/skills/generate-pipeline/SKILL.md`

Add `countFrom` and `substitutionsFrom` to the `PipelineTransition`
interface block and the transition field table. Add one checklist item
for the new mutex (dynamic vs static count) and one entry under
"Payload-driven fanout" in the templates section.

## Migration

- `examples/`: no example currently demonstrates dynamic fanout — add
  one under `examples/payload-fanout-demo/` (planner stage emits a
  fixed payload from stdout, template has 1 stage that writes a
  per-id file). Optional but useful for docs linkage.
- `imcflow/__art__/PIPELINE_B_PARALLEL_v1.json`: migrate from the old
  `kind: "dynamic-fanout"` stage to a two-stage flow —
  (a) `id_planner` agent as today, emitting the same fenced payload,
  (b) a transition on `PLAN_READY` with
  `template: "per_id", countFrom: "payload", substitutionsFrom:
  "payload"`. The old `per_id_fanout` stage is deleted; `per_id.pipeline.json`
  becomes a template at `__art__/templates/per_id.json` (rename, same content
  — `{{id}}` / `{{kind}}` / `{{filename}}` placeholders already match).
  Note: `templates/per_id.pipeline.json` currently at
  `imcflow/__art__/templates/` — resolve `TEMPLATE_NAME_PATTERN` (no dots)
  by renaming to `per_id.json`.

Out of scope here but worth noting: `aggregate_filelist` (the stage after
fanout in the old file) stays a normal post-barrier stage. After this
plan it just runs after the synthesized `<origin>__per_id__barrier`.

## Tests

New unit tests:

- `parseStageMarkers` payload extraction (already tested; add one case
  that returns a valid JSON array payload end-to-end).
- Validator rejections:
  - `{ countFrom }` without `template`.
  - `{ countFrom, count }` both present.
  - `{ substitutionsFrom }` without `countFrom`.
  - `countFrom: "wrong"` literal.
- Runtime dispatch (`handleStageResult`):
  - Transition with `countFrom: "payload"` + valid JSON array payload →
    stitchParallel called with `count = payload.length`.
  - Transition with `substitutionsFrom: "payload"` → `perCopySubstitutions`
    reaches the stitched stages; placeholder `{{id}}` resolves to
    payload[i].id in `prompt`, `mounts`, and `transitions[].prompt`
    (verifying the `transitions` whitelist addition).
  - Empty array / non-array / nested-object payload → STAGE_ERROR with
    descriptive error.
  - Payload object using reserved keys `index` / `insertId` → rejected.

One integration test: a two-stage pipeline where stage A emits a 3-id
payload and stage B is payload-driven fanout over a 1-stage template
that writes per-id output. Assert 3 lanes spawned, 3 output files
created (mocked via existing `runContainerAgent` harness).

## Open questions (worth pausing)

- **Max payload size?** Set a soft cap (e.g. 1024 elements) to prevent
  a misbehaving agent from spawning a million lanes? Leave unbounded
  for v1, add knob later if it burns someone.
- **Failure policy across lanes?** Still implicit "all-success via
  barrier `fan_in: all`". If any lane hits `next: null` as
  `STAGE_ERROR`, the barrier just never fires. That's the same
  behavior as static `count` fanout today. Explicit policies
  (`any-success`, `best-effort`) are out of scope — separate plan.
- **Concurrency cap?** Same — out of scope. Current pipeline-runner
  scheduler behavior for parallel lanes (serial vs concurrent
  spawn) is a separate investigation and not blocking here.
- **Substitution of `transitions`** opens the door for users to put
  `{{payloadField}}` in `transitions[].next` or `transitions[].template`
  strings. The string substitution runs before the scope validator
  fired at template-load time, so a substituted `next` still needs
  to name an internal stage. Document that placeholders inside
  `next` / `template` are substituted lexically but the resulting
  string must satisfy scope rules.

## Resolved decisions

- **1-lane payload dispatch**: route length-1 `countFrom: "payload"` to
  `stitchSingle` (no barrier) rather than `stitchParallel(count=1)`.
  See *Runtime dispatch* section for the directive table.

## Implementation order

1. Add `countFrom` / `substitutionsFrom` to `PipelineTransition` type.
2. Extend base + template validators with mutex rules.
3. Add `transitions` to `STITCH_SUBSTITUTION_FIELDS`; verify payload
   reserved-key rejection in `cloneTemplateCopy` or at the dispatch
   helper.
4. Extend `performStitch` signature with `perCopySubs?` and pipe it
   through to `stitchParallel`.
5. Write `resolveStitchInputs(matched, payload)` helper and call it
   from `handleStageResult`. Hook up payload → JSON parse → validate.
6. Unit + integration tests (see Tests section).
7. Docs + SKILL.
8. Migrate `imcflow/__art__/PIPELINE_B_PARALLEL_v1.json` to the new
   schema; add `examples/payload-fanout-demo/`.
9. `npm run build && npm test` + real run of the payload-fanout-demo.

## What stays the same

- Typed transition mutex (`next` XOR `template`, `count` requires
  `template`) from the previous plan.
- `{{insertId}}` / `{{index}}` semantics and naming scheme.
- Barrier synthesis and Option 1 semantics (template owns downstream).
- State v2 format, parse-miss retry, container respawn via
  `_CONTAINER_*` markers.
- Fenced `---PAYLOAD_START---` block (not re-defining a payload format —
  reusing what `parseStageMarkers` already understands).
