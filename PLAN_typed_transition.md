# Plan: Typed transition — split `next` (node) and `template` (stitch)

Follow-up refactor for the stitch system landed in this branch. Tightens the
transition schema so that "go to stage X" and "stitch template Y" are
syntactically distinct, and enforces scope locality for node references.

## Motivation

Current behaviour (as shipped in this branch) resolves `next: "<name>"` at
runtime by checking `stagesByName`:

- If the name matches an existing stage → node transition.
- Otherwise → load `__art__/templates/<name>.json` and stitch.

Consequences:

1. Typos silently become stitch attempts and fail late with a file-not-found.
2. A template can legally reference any stage by bare name, including base
   pipeline stages or stages from sibling templates. This couples templates
   to the outer context and reintroduces the "name collision across scopes"
   problem the stitch redesign was meant to avoid.
3. The validator can't fail fast on missing references — it emits a warning
   because it can't know at load time whether an unknown name is a template.

## Target schema

```jsonc
// Node transition — scope-local stage name only
{ "marker": "OK", "next": "finalize" }

// Single stitch — insert one copy of the template
{ "marker": "OK", "template": "revert-tpl" }

// Parallel stitch — insert N copies + synthesized barrier
{ "marker": "OK", "template": "probe", "count": 4 }

// Pipeline end
{ "marker": "OK", "next": null }
```

Rules:

- `next` and `template` are **mutually exclusive** per transition. Exactly
  one of {`next`-string, `next`-null, `template`} is present.
- `count` is only valid together with `template`, must be a positive integer.
- `next` is always a stage reference. `string[]` on `next` is retained as a
  runtime-only shape for the parallel-stitch barrier's multi-target activation.

## Scope rules (strict, validated at load time)

| Where the transition lives | `next: "X"` must resolve to …                                | `template: "Y"` resolves at runtime by … |
| -------------------------- | ------------------------------------------------------------ | ---------------------------------------- |
| Base pipeline              | a stage name in the base pipeline                            | `__art__/templates/Y.json` existing      |
| Template `T`               | a stage name inside template `T` (after pre-rename)          | `__art__/templates/Y.json` existing      |

Cross-template node references (`next` to a stage of a *different* template)
are rejected outright. Cross-template stitch is the only way to hand control
off, and that's exactly what `template:` is for.

## Type changes (`src/pipeline-runner.ts`)

```ts
export interface PipelineTransition {
  marker: string;
  next?: string | string[] | null;   // stage name only; string[] runtime-only
  template?: string;                 // NEW — template name to stitch
  count?: number;                    // NEW — only meaningful with `template`
  prompt?: string;
}
```

## Validator changes

### `loadPipelineConfig` (base pipeline)

For every transition:

- Reject if both `next` (non-null) and `template` are present.
- Reject if `count` is present without `template`.
- If `next` is a string, it must appear in the base `stages[].name` set.
  (Today it emits a warning and defers to runtime — replace with an error.)
- `template` string is *not* validated at load — file existence is a runtime
  concern, same as today.

### `validatePipelineTemplate` (`src/pipeline-template.ts`)

For every transition inside the template:

- Reject if both `next` and `template` are present.
- Reject if `count` is present without `template`.
- If `next` is a string, it must appear in the template's own
  `stages[].name` set. (Today it accepts "any forward reference"; that
  permissive branch goes away.)

## Stitch core changes (`src/stitch.ts`)

`rewireTransition` simplifies — the "external reference pass-through" branch
is gone since template-internal `next` is guaranteed internal by the loader:

```ts
function rewireTransition(t, internalNames, rename, convergenceTarget) {
  const out = { ...t };
  if (typeof t.next === 'string') {
    // Validator guarantees t.next is in internalNames
    out.next = rename(t.next);
  } else if (t.next === null || t.next === undefined) {
    out.next = convergenceTarget ?? null;
  }
  // `template` field passes through unchanged — it's resolved at runtime
  // when the stitched stage fires its transition.
  return out;
}
```

Nothing else needs to change in stitch core — the cloning / barrier
synthesis / substitution all still apply.

## Runtime changes (`handleStageResult`)

Current dispatch:

```ts
if (typeof matched.next === 'string' && !stagesByName.has(matched.next)) {
  // …stitch…
}
```

Replace with explicit field check:

```ts
if (matched.template) {
  const stitched = this.performStitch(
    stageConfig,
    stageConfig.transitions.indexOf(matched),
    matched.template,
    matched.count,
  );
  // …register inserted stages, set targetName to stitched.newNext…
} else {
  // matched.next is a string (existing stage) or null (pipeline end)
  targetName = matched.next ?? null;
}
```

## Migration of existing artifacts

- `examples/stitch-demo/__art__/templates/*.json`: change
  `next: "demo" | "deep1" | "deep2" | "lane"` to `template: …`. Internal
  single-stage templates have no `next` to migrate.
- `examples/stitch-demo/__art__/PIPELINE.json`: `start` transition currently
  uses `next: "demo"` → `template: "demo"`.
- `examples/autoresearch/__art__/PIPELINE.json` + templates: wherever a
  template is referenced (`next: "experiment"`, `next: "revert-and-continue"`,
  etc.), move to `template:`.
- `src/pipeline-runner.test.ts`: all stitch integration tests use `next: "x"`
  for template refs — migrate to `template:`.
- `src/stitch.test.ts`: fixture templates that deliberately reference
  `"start"` (base stage) to test cycle detection will break under the new
  validator. Either drop that test case or replace with a different cycle
  scenario (e.g., template internal self-reference that the template
  validator already rejects).
- `docs/PIPELINE-REFERENCE.md` and `.claude/skills/generate-pipeline/SKILL.md`:
  regenerate the transition schema / examples / checklist.

## Implementation order

1. Update `PipelineTransition` type and template loader validator.
2. Update base pipeline validator.
3. Update stitch core (`rewireTransition` simplification).
4. Update `handleStageResult` dispatch.
5. Fix failing tests; add coverage for:
   - Rejection of `{next, template}` both-present.
   - Rejection of `count` without `template`.
   - Rejection of base `next` pointing to a non-existent stage.
   - Rejection of template internal `next` pointing outside the template.
   - Runtime: `template:` field triggers stitch correctly.
6. Migrate `examples/*` and `PIPELINE.json` / template JSON files.
7. Regenerate docs + SKILL.
8. Run `npm test` + real `art run examples/stitch-demo`.

## Open questions (worth a pause before implementing)

- **`next: string[]` at authoring time?** The current runtime still receives
  arrays from parallel stitch (barrier's lane-activation fan-out). Keep it
  runtime-only and reject at authoring time — no user should ever write an
  array. Validator already does this.
- **Should `template: X` accept `X` being a path (e.g. `subdir/probe`)?**
  Current `resolveTemplatePath` rejects slashes in the name via
  `TEMPLATE_NAME_PATTERN`. Leave it flat for v1.
- **Backwards compatibility?** None. This is a breaking change on top of the
  already-breaking stitch redesign. Existing configs on this branch (autoresearch,
  stitch-demo) get migrated in the same commit.

## What stays the same

- Option 1 semantics (template owns downstream; `next: null` terminates,
  barrier `next: null` terminates).
- Naming scheme (`{origin}__{template}{n}__{stage}`, barrier
  `{origin}__{template}__barrier`).
- `{{insertId}}` / `{{index}}` substitution.
- State v2 format (`insertedStages`, `version: 2`).
- Container-respawn via `_CONTAINER_*` markers.
- Parse-miss unlimited retry.
