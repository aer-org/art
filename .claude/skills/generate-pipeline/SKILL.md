---
name: generate-pipeline
description: Generate a pipeline bundle (pipeline.json + agents/*.md + templates/) from a plan, description, or stage list. Use when the user wants to create or rebuild a pipeline configuration, describes workflow stages, or asks to set up an agent pipeline.
---

# Generate Pipeline

Convert a user's plan (free-form text, plan.md, or verbal description) into a **pipeline bundle** — a directory of files that `art push` can publish to a registry and `art run` can execute locally.

## Bundle Directory Structure

```
<pipeline-name>/
  pipeline.json              # Orchestration (stages, transitions, mounts) — NO inline prompts, NO command strings
  agents/
    scope-analysis.md        # Agent prompt for the "scope-analysis" stage
    implementation.md        # Agent prompt for the "implementation" stage
    review.md                # ...
  scripts/
    git-init.sh              # Shell script for the "git-init" command stage
    train.sh                 # ...
  templates/
    experiment.json          # Reusable sub-graph (prompts and commands also stripped)
  dockerfiles/
    custom-build.Dockerfile  # Custom Dockerfile definitions (optional)
```

**Key rule**: keep behavior out of `pipeline.json` and template JSON. Agent stages put their prompt in `agents/<ref>.md`; command stages put their shell logic in `scripts/<stage_name>.sh`. The pipeline JSON is pure orchestration: which stages exist, how they connect, what mounts/env they need. The loader rejects any command stage that authors a `command` field, or any stage that uses a reserved (`ART_*`) env key.

### How it works with the registry

- **`art push`**: Reads `pipeline.json` + `agents/*.md`, uploads changed pipeline/templates/agents/dockerfiles. Agent changes can trigger pipeline/template re-publication so registry content stays coherent.
- **`art pull`**: Downloads from registry, extracts inline prompts to `agents/*.md`, writes stripped `pipeline.json`, and records hashes in `.art-bundle.json`.
- **`art diff`**: Shows what changed locally since last pull/push.
- **`art fork` / `art promote`**: Copy shared agents into user scope, or promote user agents to shared scope.
- **`art run`**: Runs a local project pipeline. The pipeline file at `<project>/__art__/PIPELINE.json` is loaded; bundle-relative `agent` refs resolve from `<project>/__art__/agents/`.

---

## Schema Reference

```typescript
interface PipelineTransition {
  marker?: string;                    // Required unless afterTimeout is true. Bare name, e.g. "STAGE_COMPLETE"
  next: string | string[] | null;     // Required. Scope-local stage name, an array of names for heterogeneous fan-out, or null to end. Array form is incompatible with `template`.
  template?: string;                  // Template name (templates/<name>.json) to stitch before continuing to `next`
  count?: number;                     // Positive integer. Parallel stitch N lanes + synthesized join. Requires `template`
  countFrom?: "payload";              // Derive lane count from marker payload array length. Requires `template`; exclusive with count
  substitutionsFrom?: "payload";      // Per-lane subs from payload[i] fields. Requires `countFrom: "payload"`
  joinPolicy?: "all_success" | "any_success" | "all_settled"; // Requires `template`. Defaults to all_success
  outcome?: "success" | "error";      // Optional explicit transition outcome classification
  afterTimeout?: boolean;             // Command stages only. Fires when command timeout terminates the process; no marker
  prompt?: string;                    // Optional marker description. Include in generated bundles for clarity
}

interface PipelineStage {
  name: string;
  kind?: "command";                   // Required marker for command stages. Omit (or any other value is rejected) for agent stages.
  agent?: string;                     // Agent stage: prompt ref loaded from agents/<agent>.md. Mutually exclusive with inline `prompt`.
  prompt?: string;                    // Agent stage: inline prompt text. Not allowed on `kind: "command"` stages.
  successMarker?: string;             // Command stdout substring that immediately resolves STAGE_COMPLETE
  errorMarker?: string;               // Command stdout substring that immediately resolves STAGE_ERROR
  timeout?: number;                   // Command stages only, milliseconds
  chat?: boolean;
  image?: string;                     // Optional registry key / image name; omit for default image
  mounts: Record<string, "ro" | "rw" | null>;
  hostMounts?: { hostPath: string; containerPath?: string; readonly?: boolean }[];
  gpu?: boolean;
  runAsRoot?: boolean;
  privileged?: boolean;
  env?: Record<string, string>;       // Author env vars. Keys starting with ART_* are reserved by the runtime — rejected at load time.
  devices?: string[];
  exclusive?: string;
  mcpAccess?: string[];               // Agent stages only.
  resumeSession?: boolean;
  // Runtime-only — never author these. The validator rejects any
  // attempt to set `command` (synthesized from kind + scripts/<name>.sh)
  // or `join`.
  transitions: PipelineTransition[];
}

interface PipelineConfig {
  stages: PipelineStage[];
  entryStage?: string;
}

interface PipelineTemplate {      // templates/<name>.json
  entry?: string;                  // defaults to stages[0].name
  stages: PipelineStage[];
}
```

### Stage types

| | Agent stage | Command stage |
|---|---|---|
| Marker | omit `kind` | `kind: "command"` |
| Instructions | Prefer `agent: "<ref>"` + `agents/<ref>.md`; inline `prompt` is allowed but avoid for generated bundles | A shell script at `__art__/scripts/<stage_name>.sh` — `command` field is **not authored** |
| `image` | Optional (registry key or omit for default) | Optional (image name or omit for default; choose explicit image when tools are needed) |
| Execution | Claude/Codex agent with tools | `bash /workspace/scripts/<name>.sh` (runtime-synthesized; runs under `sh -c`) |
| Marker emission | Agent prints `[MARKER]` in response | Script prints marker to stdout, or relies on exit code |
| Transitions | N transitions with custom markers | `STAGE_COMPLETE` + `STAGE_ERROR`, plus optional `afterTimeout` |

#### Command stage authoring

Command stages are authored as:
- `kind: "command"` in the stage object (required)
- One shell script per stage at `__art__/scripts/<stage_name>.sh` (required; validator rejects load if missing)
- **No** `command` field — runtime synthesizes `command: "bash /workspace/scripts/<stage_name>.sh"`
- **No** `prompt` / `agent` field — command stages have no prompt
- **No** authored `mounts.scripts` — runtime auto-injects `scripts: "ro"` so the script directory is readable
- All other stage fields (`image`, `mounts`, `hostMounts`, `successMarker`, `errorMarker`, `timeout`, `env`, `transitions`, …) author as usual

The shell script is the entire stage logic. Templates can reference command stages too — `templates/<tpl>.json` with a `kind: "command"` stage shares the same `__art__/scripts/<stage_name>.sh` file (one script per local stage name; lanes spawned from one template all execute the same script with different `ART_*` env).

#### Runtime ART_* env vars (auto-injected)

Every stage (command and agent) gets a small set of read-only env vars so scripts and prompts can identify which lane they are without authoring `{{x}}` substitution into the `command` field:

| Var | Value |
|---|---|
| `ART_STAGE_NAME` | Authored local name (template's stage name, or base stage name) |
| `ART_INSERT_ID` | `dispatch.invocationId` (e.g. `d_400d365517`); `root` for non-stitched stages |
| `ART_LANE_INDEX` | `dispatch.copyIndex` as string (`0`, `1`, `2`, …); `0` for non-stitched and `count: 1` lanes |
| `ART_DISPATCH_NODE_ID` | Full dispatch tree id (`<invocationId>_<index>`); `root` at the top scope |

For payload-driven lanes (`substitutionsFrom: "payload"`), each top-level field of `payload[i]` becomes an additional `ART_<UPPER_KEY>` var. Reserved keys `insertId` / `index` are skipped (already mapped above).

```sh
#!/usr/bin/env bash
# __art__/scripts/probe.sh — author per-lane scratch dir
WORK="/workspace/lane-${ART_INSERT_ID}-${ART_LANE_INDEX}"
mkdir -p "$WORK"; cd "$WORK"
python /workspace/scripts-extra/run.py --variant "${ART_VARIANT}" --seed "${ART_SEED}"
echo '[STAGE_COMPLETE]'
```

`ART_*` is a **reserved env prefix**. The validator rejects any `env` key starting with `ART_`.

#### Command stage success detection

1. `successMarker` found in stdout → immediately `STAGE_COMPLETE`
2. `errorMarker` found in stdout → immediately `STAGE_ERROR` (process is killed)
3. Neither found, process exits → exit code 0 = `STAGE_COMPLETE`, non-zero = `STAGE_ERROR`

Command stages may set `timeout` in milliseconds. If the command times out, an `afterTimeout: true` transition is used when present; otherwise the runner falls back to `STAGE_ERROR`. `afterTimeout` transitions are command-only, cannot also declare `marker`, cannot use payload-driven fanout fields, and each command stage may declare at most one.

Command stages may stitch templates after `STAGE_COMPLETE`/`STAGE_ERROR` transitions just like agent stages. For payload-driven fanout (`countFrom: "payload"`), the script must print a fenced marker payload to stdout using the transition marker, for example `[STAGE_COMPLETE]` followed by `---PAYLOAD_START---...---PAYLOAD_END---`. Prefer exit-code success detection for this pattern; if `successMarker` fires before the complete fenced block is in stdout, stitch runs without a payload and fails.

#### Agent prompt sources

Prefer local agent refs for generated bundles:

```jsonc
{
  "name": "implementation",
  "agent": "implementation",
  "mounts": { "project": "rw" },
  "transitions": [
    { "marker": "STAGE_COMPLETE", "next": "review", "prompt": "Implementation is complete" }
  ]
}
```

This loads `agents/implementation.md` relative to the bundle directory. The `agent` name must be alphanumeric plus `_`/`-`, and a stage cannot specify both `agent` and inline `prompt`.

Alternative prompt source:
- `prompt`: inline prompt text, accepted by runtime and useful for imported/legacy configs

Unsupported legacy prompt fields:
- `prompts` and `prompt_append` are rejected by current validation. Do not generate them.

#### External MCP access (`mcpAccess`)

Agent stages can opt into external MCP servers by referencing keys from `~/.config/aer-art/mcp-registry.json`. Rules:
- `mcpAccess` is valid only for **agent stages**
- Values are **registry refs**, not raw tool names or URLs
- Prefer one ref per isolated capability/server

#### Heterogeneous fan-out — `next: [...]`

For "after A, run B and C in parallel, then continue at D" where B and C are different stages, set the source transition's `next` to an array. Each entry must reference an existing stage in the same scope; arrays must be non-empty, unique, and DAG-acyclic. The downstream join is implicit: any stage that appears as the `next` target of multiple stages becomes a fan-in point and waits for all of its declared predecessors to complete.

```jsonc
{
  "stages": [
    { "name": "build",  "agent": "build",  "mounts": {"project": "rw"},
      "transitions": [{ "marker": "STAGE_COMPLETE", "next": ["test", "lint"] }] },
    { "name": "test",   "command": "npm test",  "image": "node:22-slim", "mounts": {"project":"ro"},
      "transitions": [{ "marker": "STAGE_COMPLETE", "next": "report" }, { "marker": "STAGE_ERROR", "next": "report" }] },
    { "name": "lint",   "command": "npm run lint", "image": "node:22-slim", "mounts": {"project":"ro"},
      "transitions": [{ "marker": "STAGE_COMPLETE", "next": "report" }, { "marker": "STAGE_ERROR", "next": "report" }] },
    { "name": "report", "agent": "report", "mounts": {"results":"rw"},
      "transitions": [{ "marker": "STAGE_COMPLETE", "next": null }] }
  ]
}
```

`test` and `lint` launch in parallel after `build`; `report` only runs once both have completed (regardless of which marker each lane fired). Array `next` cannot be combined with `template:` on the same transition — those are different mechanisms (see below).

#### Templates & Stitch

Templates live at `templates/<name>.json` and hold reusable sub-graphs. A transition with `template: "<name>"` clones the template into the live graph at runtime (**stitch**). Use templates when the array-`next` fan-out isn't enough:
- **Homogeneous parallel** — `count: N` (or `countFrom: "payload"`) inserts N lane copies of the same sub-graph with per-lane substitutions, joined by a `joinPolicy`-controlled barrier
- **Loops without cycles** — `review` stitching a fresh `experiment` template downstream lets you iterate without a back-edge that would fail the DAG check
- **Recovery paths** — stitch a `cleanup` template on `STAGE_ERROR`

Rule of thumb: pick array `next` for heterogeneous siblings (B and C are different stages); pick `template:` when you need N parallel copies of the same shape, payload-driven lane counts, or a join policy other than implicit "wait for all predecessors".

```jsonc
// pipeline.json
{
  "stages": [
    {
      "name": "review",
      "agent": "review",
      "mounts": {"results": "rw"},
      "transitions": [
        { "marker": "STAGE_DONE", "next": null, "prompt": "Stop iterating" },
        { "marker": "STAGE_KEEP", "template": "experiment", "next": null, "prompt": "Run another experiment" },
        { "marker": "FANOUT", "template": "probe", "next": "summarize", "count": 4, "joinPolicy": "all_success", "prompt": "Probe 4 variants in parallel" }
      ]
    }
  ]
}
```

```jsonc
// templates/experiment.json — `test` is a command stage; its script lives at __art__/scripts/test.sh
{
  "entry": "build",
  "stages": [
    { "name": "build", "agent": "build", "mounts": {"project": "rw"}, "transitions": [{ "marker": "OK", "next": "test", "prompt": "Build changes are ready to test" }] },
    { "name": "test", "kind": "command", "image": "node:22-slim", "mounts": {"project": "ro"}, "transitions": [{ "marker": "STAGE_COMPLETE", "next": null, "prompt": "Tests passed" }, { "marker": "STAGE_ERROR", "next": null, "prompt": "Tests failed" }] }
  ]
}
```

Substitution at stitch-time: `{{insertId}}` and `{{index}}` are available in template stage fields that authors can still write — `prompt`, `mounts` keys, `hostMounts`, `env` values, `image`, `successMarker`, `errorMarker`, `transitions`. Use them for per-instance workdir scoping (e.g. `"mounts": { "lane-{{insertId}}": "rw" }`). For per-lane data inside a command stage's shell script, prefer the `ART_*` env vars (above) over substituting into authored fields — the `command` field is synthesized, not author-substituted.

Rules:
- `next` is **always required** per transition. Scope-local: reference a stage in the current scope, an array of such names for heterogeneous fan-out, or `null` to end
- `next` arrays must be non-empty, contain only existing-stage names, have no duplicates, and produce no cycles (DAG enforced at load)
- `next: [...]` cannot combine with `template:` on the same transition; template stitch and array fan-out are different mechanisms
- Stage `kind` must be `"command"` or omitted (agent stage). Legacy values are rejected
- Command stages (`kind: "command"`) must not author `command`, `prompt`, `agent`, or `mounts.scripts` (runtime synthesizes/injects all four)
- Command stages require `__art__/scripts/<stage_name>.sh` to exist at load time
- `env` keys starting with `ART_*` are reserved at the author level (runtime-injected)
- Stage `fan_in`, `prompts`, and `prompt_append` are legacy and invalid
- Transition `retry`, `next_dynamic`, and `kind: "dynamic-fanout"` are legacy and invalid
- `count` requires `template` and must be a positive integer. Stitch synthesizes a join stage; `next: null` edges inside the template return to that join
- `count` and `countFrom` are mutually exclusive
- `countFrom` only accepts `"payload"` and requires `template`
- `substitutionsFrom` only accepts `"payload"` and requires `countFrom: "payload"`
- `joinPolicy`: `all_success` (all must succeed), `any_success` (one enough), `all_settled` (all must finish)
- `joinPolicy` requires `template`
- Templates must be internally acyclic. Cross-scope `next` is rejected — use `template:` instead
- Inserted stage names: `{origin}__{template}{index}__{templateStage}`. Join: `{origin}__{template}__join`

#### Payload-driven fanout

Use `countFrom: "payload"` when lane count is decided at runtime. The preceding stage emits a JSON array after its marker:

```
[PLAN_READY]
---PAYLOAD_START---
[{"id":"alpha","kind":"stimulus"}, {"id":"beta","kind":"monitor"}]
---PAYLOAD_END---
```

With `substitutionsFrom: "payload"`, each element's fields become per-lane substitutions (`{{id}}`, `{{kind}}`). Reserved keys `index`/`insertId` cannot appear in payload elements. Unresolved `{{X}}` placeholders after substitution are a stitch-time error.

For command stages, emit the same block to stdout and let the command exit successfully:

```sh
printf '%s\n' '[STAGE_COMPLETE]' '---PAYLOAD_START---' \
  '[{"id":"alpha","kind":"stimulus"},{"id":"beta","kind":"monitor"}]' \
  '---PAYLOAD_END---'
```

---

## Mount Reference

| Key | Container path | Notes |
|-----|---------------|-------|
| `project` | `/workspace/project/` | User's project root |
| `project:<subdir>` | `/workspace/project/<subdir>/` | Sub-path override (directories only) |
| Any other key | `/workspace/<key>/` | Art-managed directory |
| `<key>:<subdir>` | `/workspace/<key>/<subdir>/` | Sub-path under art-managed key |

Permissions: `"ro"` (read-only), `"rw"` (read-write), `null` (hidden). Default for `project` when omitted: `"ro"`.

Reserved keys (cannot use): `ipc`, `global`, `extra`, `conversations`.

Host mounts via `hostMounts` — validated against `~/.config/aer-art/mount-allowlist.json`:

```json
"hostMounts": [
  { "hostPath": "~/datasets/imagenet", "containerPath": "data", "readonly": true }
]
```

**Least privilege**: each stage gets minimum permissions. Read-only by default, `rw` only where the stage must write.

Common patterns:
```jsonc
{ "project": "ro", "project:.git": "rw" }          // Git: read source, write .git
{ "project": "rw", "plan": "ro" }                   // Builder: modify project
{ "project": "ro", "results": "rw" }                // Tester/reviewer: read code, write results
```

---

## Common Patterns

### Linear
```
A → B → C → (end)
```

### Loop with exit condition
```
build → test → review → [KEEP → stitch(experiment) | DONE → end]
```
Review stage has multiple markers. At least one path must reach `null`. Loops are expressed via template self-stitch (DAG — no cycles).

### Error handling
- Terminate: `{ "marker": "STAGE_ERROR", "next": null }`
- Recover via stitch: `{ "marker": "STAGE_ERROR", "template": "recovery", "next": null }`

### Parallel work
Two flavors. Pick the one that matches the shape of the parallel work:

```jsonc
// Heterogeneous siblings: B and C are different stages that both feed D.
{ "marker": "STAGE_COMPLETE", "next": ["B", "C"], "prompt": "Run B and C in parallel; D will join them" }
```

```jsonc
// Homogeneous N copies of the same sub-graph (with optional per-lane substitutions / join policy).
{ "marker": "GO", "template": "probe", "next": "summarize", "count": 4, "joinPolicy": "all_settled", "prompt": "Probe 4 variants" }
```

### Command stages

PIPELINE.json — pure config, no command string:
```jsonc
{
  "name": "train",
  "kind": "command",
  "image": "nvidia/cuda:12.4.1-devel-ubuntu22.04",
  "gpu": true,
  "timeout": 3600000,
  "mounts": { "project": "ro", "results": "rw" },
  "transitions": [
    { "marker": "STAGE_COMPLETE", "next": "review", "prompt": "Training completed successfully" },
    { "marker": "STAGE_ERROR", "next": null, "prompt": "Training failed" },
    { "afterTimeout": true, "next": null }
  ]
}
```

`__art__/scripts/train.sh` — all the logic:
```sh
#!/usr/bin/env bash
set -euo pipefail
cd /workspace/project
python train.py > /workspace/results/run.log 2>&1
echo '[STAGE_COMPLETE]'
```

---

## Prompt Writing Guidelines

Agent prompts are written as **standalone markdown files** (`agents/<agent-ref>.md`). Each must be self-contained — the agent has no memory of previous stages.

1. **Reference concrete paths**: `/workspace/project/src/`, `/workspace/results/metrics.txt`
2. **Specify markers**: "When done, emit [STAGE_COMPLETE]." Multiple exits: "Emit [KEEP] if improved, [RESET] if not."
3. **State constraints**: what the agent must NOT do
4. **Describe the goal**: what success looks like
5. **Mention inputs**: what files/data to read first
6. **One responsibility per stage**
7. **Validation must be adversarial**: test against the spec, not the implementation
8. **MCP tools**: describe intent, not protocol. Name the tool if only one; disambiguate if multiple

---

## Workflow

When this skill is invoked:

1. **Read the input.** File path (plan.md) or conversation context.

2. **Identify stages.** For each:
   - Name (kebab-case, descriptive)
   - Agent ref (usually the same kebab-case name) for agent stages
   - Type (agent if judgment needed, command if deterministic)
   - What it reads and writes

3. **Design mounts.** Least privilege. Use `project:<sub>` overrides where needed.

4. **Wire transitions.** Ensure:
   - At least one path reaches `next: null`
   - Every transition has `next`; every marker transition has `marker` and `prompt`
   - Command timeout behavior uses at most one `afterTimeout: true` transition
   - Loops expressed via template self-stitch
   - `joinPolicy` set deliberately for parallel work

5. **Choose images** for command stages (`alpine/git`, `node:22-slim`, `python:3.12-slim`, `nvidia/cuda:12.4.1-devel-ubuntu22.04`).

6. **Handle custom Dockerfiles.** If a stage references a custom image with a Dockerfile (not a public registry image), copy the Dockerfile into `<name>/dockerfiles/<image-name>.Dockerfile`. The convention is `dockerfiles/<name>.Dockerfile` — rename if the source file doesn't match. Update the stage's `image` field to reference the dockerfile name.

7. **Write agent prompts** as markdown files following the guidelines above.

8. **Write command scripts** to `<name>/scripts/<stage_name>.sh` — one file per command stage. Use ART_* env vars for per-lane data.

9. **Run the checklist** (below).

10. **Write the bundle:**
    - `mkdir -p <name>/agents <name>/templates <name>/scripts <name>/dockerfiles`
    - Write `<name>/pipeline.json` (2-space indent, **no inline prompts** for generated agent stages)
    - Put `agent: "<agent-ref>"` on each generated agent stage; put `kind: "command"` (and no `command` / `prompt`) on each command stage
    - Write each agent prompt to `<name>/agents/<agent-ref>.md`
    - Write each command script to `<name>/scripts/<stage_name>.sh`
    - Write templates to `<name>/templates/<name>.json` (agent instructions stripped into `agents/`; command logic stripped into `scripts/`)
    - Write template agent prompts to `<name>/agents/<agent-ref>.md` as well
    - Create mount directories under the bundle dir for art-managed keys

---

## Pre-Output Checklist

- [ ] Every stage has a unique `name`
- [ ] Every transition has an explicit `next` (`string`, `string[]`, or `null`)
- [ ] Every non-`afterTimeout` transition has a non-empty `marker` and a `prompt`
- [ ] Every transition's `next` references an existing stage in the same scope (string form), every entry of an array references an existing stage in the same scope, or `next` is `null`
- [ ] Array `next` is non-empty, contains no duplicates, and does not appear on a transition that also sets `template`
- [ ] Every stage has at least one transition
- [ ] Command stages have `kind: "command"`, no `command` / `prompt` / `agent` / `mounts.scripts` authored, and a `scripts/<stage_name>.sh` file exists
- [ ] Command stages use marker transitions only for `STAGE_COMPLETE`/`STAGE_ERROR`, and choose an explicit `image` when the default image lacks required tools
- [ ] Command scripts read per-lane data via `ART_*` env vars (`ART_STAGE_NAME`, `ART_INSERT_ID`, `ART_LANE_INDEX`, `ART_DISPATCH_NODE_ID`, plus `ART_<UPPER>` for payload-driven lanes), not substitution
- [ ] No `env` key starts with `ART_` (reserved by the runtime)
- [ ] Command `timeout` appears only on command stages; `afterTimeout` is command-only, markerless, and declared at most once per stage
- [ ] Agent stages have no `kind`, no `command`, and define exactly one of `agent` or inline `prompt`
- [ ] Generated agent stages use `agent` refs instead of inline `prompt`
- [ ] Every `agent` ref has a corresponding `agents/<agent-ref>.md` file with non-empty content
- [ ] Template JSON files also have agent instructions stripped; their agent refs point into `agents/` too
- [ ] `mcpAccess` appears only on agent stages, values are registry refs
- [ ] At least one path through the graph reaches `next: null`
- [ ] Mount keys do not use reserved names (`ipc`, `global`, `extra`, `conversations`)
- [ ] `project:*` overrides are not relied on when `project` is `null` or hidden
- [ ] Sub-path mounts use only relative directory paths (no `..`, no leading `/`)
- [ ] `entryStage` (if set) references an existing stage name
- [ ] Marker names in JSON match what prompts tell agents to emit (bare in JSON, bracketed in prompts)
- [ ] The pipeline graph is acyclic (DAG). Cycles are rejected at load — use template self-stitch to express iteration without a back-edge
- [ ] No legacy stage fields: `kind`, `fan_in`, `prompts`, or `prompt_append`
- [ ] No legacy transition fields: `retry`, `next_dynamic`, or `kind: "dynamic-fanout"`
- [ ] `count` is a positive integer and only used with `template`
- [ ] `count` and `countFrom` are not used together
- [ ] `countFrom` only uses `"payload"` and only with `template`; `substitutionsFrom` only with `countFrom`
- [ ] `joinPolicy` only used with `template`
- [ ] `outcome`, if present, is only `"success"` or `"error"`
- [ ] No stage authors runtime-only `join` metadata
- [ ] Templates at `templates/<name>.json` with `{ entry?, stages }` shape; internally acyclic
- [ ] Custom Dockerfiles are in `dockerfiles/<name>.Dockerfile`; stage `image` fields reference the dockerfile name
- [ ] No `.art-bundle.json` generated (created by `art pull`/`art push`, not this skill)
- [ ] The JSON is valid and parseable
