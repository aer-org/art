---
name: generate-pipeline
description: Generate a pipeline bundle (pipeline.json + agents/*.md + templates/) from a plan, description, or stage list. Use when the user wants to create or rebuild a pipeline configuration, describes workflow stages, or asks to set up an agent pipeline.
---

# Generate Pipeline

Convert a user's plan (free-form text, plan.md, or verbal description) into a **pipeline bundle** — a directory of files that `art push` can publish to a registry and `art run` can execute locally.

## Bundle Directory Structure

```
<pipeline-name>/
  pipeline.json              # Orchestration (stages, transitions, mounts) — NO inline prompts
  agents/
    scope-analysis.md        # Agent prompt for the "scope-analysis" stage
    implementation.md        # Agent prompt for the "implementation" stage
    review.md                # ...
  templates/
    experiment.json          # Reusable sub-graph (prompts also stripped)
  dockerfiles/
    custom-build.Dockerfile  # Custom Dockerfile definitions (optional)
```

**Key rule**: keep authored agent instructions out of `pipeline.json` and template JSON. Prefer `agent: "<agent-ref>"` on agent stages, with prompts in `agents/<agent-ref>.md`. Inline `prompt` is still accepted for compatibility/import flows, but generated bundles should keep orchestration (JSON) and instructions (markdown) cleanly decoupled.

### How it works with the registry

- **`art push`**: Reads `pipeline.json` + `agents/*.md`, uploads changed pipeline/templates/agents/dockerfiles. Agent changes can trigger pipeline/template re-publication so registry content stays coherent.
- **`art pull`**: Downloads from registry, extracts inline prompts to `agents/*.md`, writes stripped `pipeline.json`, and records hashes in `.art-bundle.json`.
- **`art diff`**: Shows what changed locally since last pull/push.
- **`art fork` / `art promote`**: Copy shared agents into user scope, or promote user agents to shared scope.
- **`art run`**: Runs a local project pipeline. With `art run <project> --pipeline <bundle>/pipeline.json`, bundle-relative `agent` refs resolve from `<bundle>/agents/`.

---

## Schema Reference

```typescript
interface PipelineTransition {
  marker?: string;                    // Required unless afterTimeout is true. Bare name, e.g. "STAGE_COMPLETE"
  next: string | null;                // Required in authored config. Scope-local stage name, or null to end
  template?: string;                  // Template name (templates/<name>.json) to stitch before continuing to `next`
  count?: number;                     // Positive integer. Parallel stitch N lanes + synthesized join. Requires `template`
  countFrom?: "payload";              // Derive lane count from marker payload array length. Requires `template`; exclusive with count
  substitutionsFrom?: "payload";      // Per-lane subs from payload[i] fields. Requires `countFrom: "payload"`
  joinPolicy?: "all_success" | "any_success" | "all_settled"; // Requires `template`. Defaults to all_success
  outcome?: "success" | "error";      // Optional explicit transition outcome classification
  afterTimeout?: boolean;             // Command stages only. Fires when command timeout terminates the process; no marker
  prompt?: string;                    // Required in generated bundles for marker transitions; describes when to emit marker
}

interface PipelineStage {
  name: string;
  kind?: "agent" | "command";
  agent?: string;                     // Agent prompt ref loaded from agents/<agent>.md; cannot combine with inline prompt
  prompt?: string;                    // Inline prompt. Avoid in generated bundles except command prompt: "" or compatibility imports
  prompts?: string[];                 // Prompt DB ids from ~/.config/aer-art/prompt-db.json
  prompt_append?: string;             // Extra prompt text appended after prompt/prompts
  command?: string;
  successMarker?: string;
  errorMarker?: string;
  timeout?: number;                   // Command stages only, milliseconds
  chat?: boolean;
  image?: string;
  mounts: Record<string, "ro" | "rw" | null>;
  hostMounts?: { hostPath: string; containerPath?: string; readonly?: boolean }[];
  gpu?: boolean;
  runAsRoot?: boolean;
  privileged?: boolean;
  env?: Record<string, string>;
  devices?: string[];
  exclusive?: string;
  mcpAccess?: string[];
  resumeSession?: boolean;
  fan_in?: "all";
  join?: never;                       // Runtime-generated only; never author this
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
| Instructions | Prefer `agent: "<ref>"` + `agents/<ref>.md`; `prompts`/`prompt_append` also supported | `prompt: ""` |
| `command` | Absent or undefined | Shell string (`sh -c`) |
| `image` | Optional (registry key or omit for default) | **Required** (Docker image name) |
| Execution | Claude agent with tools | `sh -c <command>`, no agent |
| Marker emission | Agent prints `[MARKER]` in response | Automatic based on `successMarker`/exit code |
| Transitions | N transitions with custom markers | `STAGE_COMPLETE` + `STAGE_ERROR`, plus optional `afterTimeout` |

#### Command stage success detection

1. `successMarker` found in stdout → immediately `STAGE_COMPLETE`
2. `errorMarker` found in stdout → immediately `STAGE_ERROR` (process is killed)
3. Neither found, process exits → exit code 0 = `STAGE_COMPLETE`, non-zero = `STAGE_ERROR`

Command stages may set `timeout` in milliseconds. If the command times out, an `afterTimeout: true` transition is used when present; otherwise the runner falls back to `STAGE_ERROR`. `afterTimeout` transitions are command-only, cannot also declare `marker`, cannot use payload-driven fanout fields, and each command stage may declare at most one.

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

Alternative prompt sources:
- `prompt`: inline prompt text, accepted by runtime and useful for imported/legacy configs
- `prompts`: prompt DB ids from `~/.config/aer-art/prompt-db.json`
- `prompt_append`: extra text appended after `prompt` or resolved `prompts`

#### External MCP access (`mcpAccess`)

Agent stages can opt into external MCP servers by referencing keys from `~/.config/aer-art/mcp-registry.json`. Rules:
- `mcpAccess` is valid only for **agent stages**
- Values are **registry refs**, not raw tool names or URLs
- Prefer one ref per isolated capability/server

#### Templates & Stitch

Templates live at `templates/<name>.json` and hold reusable sub-graphs. A transition with `template: "<name>"` clones the template into the live graph at runtime (**stitch**). Use for:
- Recovery paths — stitch a cleanup template on error
- Iteration without cycles — review stitches a fresh experiment template downstream
- Parallel work — `count: N` inserts N lane copies + a synthesized join

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
// templates/experiment.json
{
  "entry": "build",
  "stages": [
    { "name": "build", "agent": "build", "mounts": {"project": "rw"}, "transitions": [{ "marker": "OK", "next": "test", "prompt": "Build changes are ready to test" }] },
    { "name": "test", "prompt": "", "command": "npm test", "image": "node:22-slim", "mounts": {"project": "ro"}, "transitions": [{ "marker": "STAGE_COMPLETE", "next": null, "prompt": "Tests passed" }, { "marker": "STAGE_ERROR", "next": null, "prompt": "Tests failed" }] }
  ]
}
```

Substitution at stitch-time: `{{insertId}}` and `{{index}}` are available in template fields (`prompt`, `prompts`, `prompt_append`, `mounts`, `hostMounts`, `env`, `image`, `command`, `successMarker`, `errorMarker`, `transitions`). Use them for per-instance workdir scoping (e.g. `"mounts": { "lane-{{insertId}}": "rw" }`).

Rules:
- `next` is **always required** per transition. Scope-local: reference a stage in the current scope, or `null` to end
- Authored `next` must be a string or `null`; arrays are runtime-only outputs from parallel stitch
- `retry`, `next_dynamic`, `kind: "dynamic-fanout"`, and `fan_in: "dynamic"` are legacy and invalid
- `count` requires `template` and must be a positive integer. Stitch synthesizes a join stage; `next: null` edges inside the template return to that join
- `count` and `countFrom` are mutually exclusive
- `joinPolicy`: `all_success` (all must succeed), `any_success` (one enough), `all_settled` (all must finish)
- Templates must be internally acyclic. Cross-scope `next` is rejected — use `template:` instead
- Inserted stage names: `{origin}__{template}{index}__{templateStage}`. Join: `{origin}__{template}__join`

#### Payload-driven fanout

Use `countFrom: "payload"` when lane count is decided at runtime. The preceding agent emits a JSON array after its marker:

```
[PLAN_READY]
---PAYLOAD_START---
[{"id":"alpha","kind":"stimulus"}, {"id":"beta","kind":"monitor"}]
---PAYLOAD_END---
```

With `substitutionsFrom: "payload"`, each element's fields become per-lane substitutions (`{{id}}`, `{{kind}}`). Reserved keys `index`/`insertId` cannot appear in payload elements. Unresolved `{{X}}` placeholders after substitution are a stitch-time error.

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
Stitch a template `N` times with `count`:
```jsonc
{ "marker": "GO", "template": "probe", "next": "summarize", "count": 4, "joinPolicy": "all_settled", "prompt": "Probe 4 variants" }
```

### Command stages
```json
{ "name": "train", "prompt": "", "command": "python train.py", "image": "nvidia/cuda:12.4.1-devel-ubuntu22.04", "gpu": true, "timeout": 3600000, "mounts": { "project": "ro", "results": "rw" }, "transitions": [{ "marker": "STAGE_COMPLETE", "next": "review", "prompt": "Training completed successfully" }, { "marker": "STAGE_ERROR", "next": null, "prompt": "Training failed" }, { "afterTimeout": true, "next": null }] }
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

8. **Run the checklist** (below).

9. **Write the bundle:**
   - `mkdir -p <name>/agents <name>/templates <name>/dockerfiles`
   - Write `<name>/pipeline.json` (2-space indent, **no inline prompts** for generated agent stages)
   - Put `agent: "<agent-ref>"` on each generated agent stage
   - Write each agent prompt to `<name>/agents/<agent-ref>.md`
   - Write templates to `<name>/templates/<name>.json` (agent instructions stripped into `agents/`)
   - Write template agent prompts to `<name>/agents/<agent-ref>.md` as well
   - Create mount directories under the bundle dir for art-managed keys

---

## Pre-Output Checklist

- [ ] Every stage has a unique `name`
- [ ] Every transition has an explicit `next` (`string` or `null`)
- [ ] Every non-`afterTimeout` transition has a non-empty `marker` and a `prompt`
- [ ] Every transition's `next` references an existing stage in the same scope, or is `null`
- [ ] Every stage has at least one transition
- [ ] Command stages have `prompt: ""`, an `image`, and marker transitions only for `STAGE_COMPLETE`/`STAGE_ERROR`
- [ ] Command `timeout` appears only on command stages; `afterTimeout` is command-only, markerless, and declared at most once per stage
- [ ] Agent stages have no `command` field and define `agent`, `prompt`, `prompts`, or `prompt_append`
- [ ] Generated agent stages use `agent` refs instead of inline `prompt`
- [ ] Every `agent` ref has a corresponding `agents/<agent-ref>.md` file with non-empty content
- [ ] Template JSON files also have agent instructions stripped; their agent refs point into `agents/` too
- [ ] `mcpAccess` appears only on agent stages, values are registry refs
- [ ] At least one path through the graph reaches `next: null`
- [ ] Mount keys do not use reserved names (`ipc`, `global`, `extra`, `conversations`)
- [ ] `project:*` overrides are absent when `project` is `null`
- [ ] Sub-path mounts use only relative directory paths (no `..`, no leading `/`)
- [ ] `entryStage` (if set) references an existing stage name
- [ ] Marker names in JSON match what prompts tell agents to emit (bare in JSON, bracketed in prompts)
- [ ] The pipeline graph is acyclic (DAG). Loops via template self-stitch only
- [ ] No authored transition uses array `next`; arrays are runtime-only
- [ ] No legacy `retry`, `next_dynamic`, `kind: "dynamic-fanout"`, or `fan_in: "dynamic"`
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
