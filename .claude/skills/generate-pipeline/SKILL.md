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

**Key rule**: `pipeline.json` and template JSON files contain **no inline prompts** for agent stages. Prompts live exclusively in `agents/<stage-name>.md`. This separation keeps orchestration (JSON) and instructions (markdown) cleanly decoupled.

### How it works with the registry

- **`art push`**: Reads `pipeline.json` + `agents/*.md`, assembles prompts back into stage objects, uploads to registry. Only changed files are pushed; agent changes trigger automatic re-assembly of pipeline and templates.
- **`art pull`**: Downloads from registry, extracts inline prompts to `agents/*.md`, writes stripped `pipeline.json`.
- **`art diff`**: Shows what changed locally since last pull/push.
- **`art run`**: Runs a pipeline locally (assembles prompts at runtime from `agents/` directory).

---

## Schema Reference

```typescript
interface PipelineTransition {
  marker: string;                     // Bare name, e.g. "STAGE_COMPLETE" (agents emit as [STAGE_COMPLETE])
  next: string | null;                // Scope-local stage name, or null to end the current scope
  template?: string;                  // Template name (templates/<name>.json) to stitch before continuing to `next`
  count?: number;                     // Parallel stitch N lanes + synthesized join. Requires `template`
  countFrom?: "payload";              // Derive lane count from marker payload array length. Requires `template`
  substitutionsFrom?: "payload";      // Per-lane subs from payload[i] fields. Requires `countFrom: "payload"`
  joinPolicy?: "all_success" | "any_success" | "all_settled"; // Requires `template`. Defaults to all_success
  outcome?: "success" | "error";      // Optional explicit transition outcome classification
  prompt?: string;                    // **Required in practice** — describes when the agent should emit this marker
}

interface PipelineStage {
  name: string;
  kind?: "agent" | "command";
  prompt?: string;                    // In bundle JSON: omitted for agents (lives in agents/*.md). Required "" for commands.
  command?: string;
  successMarker?: string;
  errorMarker?: string;
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
| `prompt` | Omitted in JSON (lives in `agents/<name>.md`) | Must be `""` |
| `command` | Absent or undefined | Shell string (`sh -c`) |
| `image` | Optional (registry key or omit for default) | **Required** (Docker image name) |
| Execution | Claude agent with tools | `sh -c <command>`, no agent |
| Marker emission | Agent prints `[MARKER]` in response | Automatic based on `successMarker`/exit code |
| Transitions | N transitions with custom markers | Fixed: `STAGE_COMPLETE` + `STAGE_ERROR` only |

#### Command stage success detection

1. `successMarker` found in stdout → immediately `STAGE_COMPLETE`
2. `errorMarker` found in stdout → immediately `STAGE_ERROR` (process is killed)
3. Neither found, process exits → exit code 0 = `STAGE_COMPLETE`, non-zero = `STAGE_ERROR`

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
    { "name": "build", "mounts": {"project": "rw"}, "transitions": [{ "marker": "OK", "next": "test" }] },
    { "name": "test", "prompt": "", "command": "npm test", "image": "node:22-slim", "mounts": {"project": "ro"}, "transitions": [{ "marker": "STAGE_COMPLETE", "next": null }] }
  ]
}
```

Substitution at stitch-time: `{{insertId}}` and `{{index}}` are available in template fields (`prompt`, `mounts`, `hostMounts`, `env`, `image`, `command`, `successMarker`, `errorMarker`). Use them for per-instance workdir scoping (e.g. `"mounts": { "lane-{{insertId}}": "rw" }`).

Rules:
- `next` is **always required** per transition. Scope-local: reference a stage in the current scope, or `null` to end
- `count` requires `template`. Stitch synthesizes a join stage; `next: null` edges inside the template return to that join
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
{ "name": "train", "prompt": "", "command": "python train.py", "image": "nvidia/cuda:12.4.1-devel-ubuntu22.04", "gpu": true, "mounts": { "project": "ro", "results": "rw" }, "transitions": [{ "marker": "STAGE_COMPLETE", "next": "review" }, { "marker": "STAGE_ERROR", "next": null }] }
```

---

## Prompt Writing Guidelines

Agent prompts are written as **standalone markdown files** (`agents/<stage-name>.md`). Each must be self-contained — the agent has no memory of previous stages.

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
   - Type (agent if judgment needed, command if deterministic)
   - What it reads and writes

3. **Design mounts.** Least privilege. Use `project:<sub>` overrides where needed.

4. **Wire transitions.** Ensure:
   - At least one path reaches `next: null`
   - Every transition has `next` and `prompt`
   - Loops expressed via template self-stitch
   - `joinPolicy` set deliberately for parallel work

5. **Choose images** for command stages (`alpine/git`, `node:22-slim`, `python:3.12-slim`, `nvidia/cuda:12.4.1-devel-ubuntu22.04`).

6. **Write agent prompts** as markdown files following the guidelines above.

7. **Run the checklist** (below).

8. **Write the bundle:**
   - `mkdir -p <name>/agents <name>/templates`
   - Write `<name>/pipeline.json` (2-space indent, **no inline prompts** for agent stages)
   - Write each agent prompt to `<name>/agents/<stage-name>.md`
   - Write templates to `<name>/templates/<name>.json` (prompts stripped)
   - Write template agent prompts to `<name>/agents/<stage-name>.md` as well
   - Create mount directories under the bundle dir for art-managed keys

---

## Pre-Output Checklist

- [ ] Every stage has a unique `name`
- [ ] Every transition has an explicit `next` (`string` or `null`) and a `prompt`
- [ ] Every transition's `next` references an existing stage in the same scope, or is `null`
- [ ] Every stage has at least one transition
- [ ] Command stages have `prompt: ""`, an `image`, and only `STAGE_COMPLETE`/`STAGE_ERROR` transitions
- [ ] Agent stages have no inline `prompt` in JSON and no `command` field
- [ ] Every agent stage has a corresponding `agents/<stage-name>.md` file with non-empty content
- [ ] Template JSON files also have agent prompts stripped; their agent prompts are in `agents/` too
- [ ] Agent `.md` filenames match stage `name` fields exactly
- [ ] `mcpAccess` appears only on agent stages, values are registry refs
- [ ] At least one path through the graph reaches `next: null`
- [ ] Mount keys do not use reserved names (`ipc`, `global`, `extra`, `conversations`)
- [ ] `project:*` overrides are absent when `project` is `null`
- [ ] Sub-path mounts use only relative directory paths (no `..`, no leading `/`)
- [ ] `entryStage` (if set) references an existing stage name
- [ ] Marker names in JSON match what prompts tell agents to emit (bare in JSON, bracketed in prompts)
- [ ] The pipeline graph is acyclic (DAG). Loops via template self-stitch only
- [ ] `count`/`countFrom` only used with `template`; `substitutionsFrom` only with `countFrom`
- [ ] `joinPolicy` only used with `template`
- [ ] Templates at `templates/<name>.json` with `{ entry?, stages }` shape; internally acyclic
- [ ] No `.art-bundle.json` generated (created by `art pull`/`art push`, not this skill)
- [ ] The JSON is valid and parseable
