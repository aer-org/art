---
name: generate-pipeline
description: Generate a valid __art__/PIPELINE.json from a plan, description, or stage list. Use when the user wants to create or rebuild a pipeline configuration, describes workflow stages, or asks to set up an agent pipeline.
---

# Generate Pipeline

Convert a user's plan (free-form text, plan.md, or verbal description) into a valid `__art__/PIPELINE.json` that the AerArt pipeline runner can execute.

---

## Schema Reference

> **Breaking schema (stitch):** `kind: "dynamic-fanout"`, transition `retry`, transition `next_dynamic`, and `fan_in: "dynamic"` are **gone**. Pipelines must be **DAGs** (no cycles). Dynamic expansion happens via **stitch**: a transition's `next` may reference a **pipeline template** (file at `__art__/templates/<name>.json`), which is inserted into the live graph at runtime. See [Templates & Stitch](#templates--stitch).

```typescript
interface PipelineTransition {
  marker: string;        // Bare name, e.g. "STAGE_COMPLETE" (agents emit as [STAGE_COMPLETE])
  next?: string | null;  // Target stage name OR template name. null = end pipeline.
  count?: number;        // Only valid when next is a template name. Parallel stitch N lanes + synthesized barrier.
  prompt?: string;       // **Required in practice** — describes when the agent should emit this marker
}

interface AdditionalMount {
  hostPath: string;
  containerPath?: string;
  readonly?: boolean;
}

interface PipelineStage {
  name: string;
  kind?: "agent" | "command";
  prompt: string;
  command?: string;
  successMarker?: string;
  errorMarker?: string;
  chat?: boolean;
  image?: string;
  mounts: Record<string, "ro" | "rw" | null>;
  hostMounts?: AdditionalMount[];
  gpu?: boolean;
  runAsRoot?: boolean;
  privileged?: boolean;
  env?: Record<string, string>;
  devices?: string[];
  exclusive?: string;
  mcpAccess?: string[];
  resumeSession?: boolean;
  fan_in?: "all";       // Only "all" is supported.
  transitions: PipelineTransition[];
}

interface PipelineConfig {
  stages: PipelineStage[];
  entryStage?: string;
}

interface PipelineTemplate {      // __art__/templates/<name>.json
  entry?: string;                  // defaults to stages[0].name
  stages: PipelineStage[];
}
```

### Stage types

| | Agent stage | Command stage |
|---|---|---|
| `prompt` | Non-empty instructions | Must be `""` |
| `command` | Absent or undefined | Shell string (`sh -c`) |
| `image` | Optional (registry key or omit for default) | **Required** (Docker image name) |
| Execution | Claude agent with tools | `sh -c <command>`, no agent |
| Marker emission | Agent prints `[MARKER]` in response | Automatic: `STAGE_COMPLETE` / `STAGE_ERROR` based on `successMarker` or exit code |
| Transitions | N transitions with custom markers | Fixed: `STAGE_COMPLETE` + `STAGE_ERROR` only |
| Retry | No user-authored retry; emit an error marker and let the next stage handle it, or stitch a recovery template | Same — exit non-zero triggers container respawn (capped), user-authored retry is gone |

#### Command stage success detection

Markers are detected by **streaming** stdout line-by-line. The first marker found wins — no need to wait for process exit.

1. `successMarker` found in stdout → immediately `STAGE_COMPLETE`
2. `errorMarker` found in stdout → immediately `STAGE_ERROR` (process is killed)
3. Neither found, process exits → exit code 0 = `STAGE_COMPLETE`, non-zero = `STAGE_ERROR`

Both fields are optional:
- Neither set → exit code only
- `successMarker` only → match = success, no match = exit code fallback
- `errorMarker` only → match = immediate failure, no match = exit code fallback
- Both set → first match wins

#### External MCP access (`mcpAccess`)

Agent stages can opt into external MCP servers by referencing keys from the host-side registry at `~/.config/aer-art/mcp-registry.json`.

```json
{
  "pipeline.sqlite.reader": {
    "name": "pipeline_sqlite_reader",
    "transport": "http",
    "url": "http://${ART_HOST_GATEWAY}:4318/mcp-reader",
    "tools": ["get_batch"]
  }
}
```

```json
{
  "name": "fetch-batch",
  "prompt": "Use the pipeline DB reader MCP to load the next batch.",
  "mounts": { "project": "ro", "results": "rw" },
  "mcpAccess": ["pipeline.sqlite.reader"],
  "transitions": [
    { "marker": "STAGE_COMPLETE", "next": null, "prompt": "Batch fetched successfully" }
  ]
}
```

Rules:
- `mcpAccess` is valid only for **agent stages**
- `mcpAccess` values are **registry refs**, not raw tool names
- Prefer one ref per isolated capability/server when stage-level access must also hold for Codex
- If the same backend needs different tool subsets for different stages, prefer separate MCP endpoints such as `/mcp-reader`, `/mcp-examiner`, `/mcp-reviewer`

#### Templates & Stitch

Templates live at `__art__/templates/<name>.json` and hold reusable sub-graphs. When a transition's `next` names a template, the template is cloned into the live graph at runtime (**stitch**). Use this for:
- Recovery paths (emit marker, insert cleanup/revert template, terminate).
- "Looping" iteration without cycles — e.g., review emits `STAGE_KEEP`, which stitches a fresh experiment template downstream of itself. Each stitched copy has uniquely-prefixed stage names so the graph stays acyclic.
- Parallel work — `count: N` inserts N lane copies + a synthesized barrier (`<origin>__<template>__barrier`).

```jsonc
// __art__/PIPELINE.json
{
  "stages": [
    {
      "name": "review",
      "prompt": "...",
      "mounts": {"results": "rw"},
      "transitions": [
        { "marker": "STAGE_DONE", "next": null,          "prompt": "Stop iterating" },
        { "marker": "STAGE_KEEP", "next": "experiment",  "prompt": "Run another experiment (stitch template)" },
        { "marker": "STAGE_RESET","next": "revert-tpl",  "prompt": "Revert and try again (stitch revert template)" },
        { "marker": "FANOUT",     "next": "probe",       "count": 4, "prompt": "Probe 4 variants in parallel" }
      ]
    }
  ],
  "entryStage": "review"
}
```

```jsonc
// __art__/templates/experiment.json
{
  "entry": "build",
  "stages": [
    { "name": "build",  "prompt": "...", "mounts": {...}, "transitions": [{ "marker": "OK", "next": "test" }] },
    { "name": "test",   "command": "...", "transitions": [{ "marker": "OK", "next": "review" }] },
    { "name": "review", "prompt": "...", "mounts": {...}, "transitions": [
      { "marker": "STAGE_DONE", "next": null },
      { "marker": "STAGE_KEEP", "next": "experiment" }   // self-reference — stitched again
    ] }
  ]
}
```

Substitution at stitch-time: `{{insertId}}` and `{{index}}` are available in template fields (`prompt`, `prompts`, `prompt_append`, `mounts`, `hostMounts`, `env`, `image`, `command`, `successMarker`, `errorMarker`). Use them for per-instance workdir scoping (e.g. `"mounts": { "lane-{{insertId}}": "rw" }`).

Rules:
- A transition's `next` may reference an existing **stage name** OR a **template name**. Unknown names are treated as templates.
- `count` is valid only when `next` is a template name.
- `count > 1` inserts N lanes and a barrier with `next: null` (parallel block is terminal — template owns downstream flow).
- Templates must have internally acyclic transitions; external references (to base stages or other templates) are resolved at stitch-time and the full graph is re-validated as a DAG.
- Inserted stage names follow `{origin}__{template}{index}__{templateStage}` — visible in logs, `PIPELINE_STATE.insertedStages`, and container names.
- Templates **cannot** declare `retry`, `next_dynamic`, `kind: "dynamic-fanout"`, `fan_in: "dynamic"`, or authored array `next` — those are all gone.

---

## Mount Reference

### Mount keys

| Key | Container path | Notes |
|-----|---------------|-------|
| `project` | `/workspace/project/` | User's project root (parent of `__art__/`) |
| `project:<subdir>` | `/workspace/project/<subdir>/` | Sub-path override relative to the project root (directories only) |
| Any other key | `/workspace/<key>/` | Art-managed directory under `__art__/<key>/` |
| `<key>:<subdir>` | `/workspace/<key>/<subdir>/` | Sub-path under an art-managed key — override mode when `<key>` is also mounted, direct mode when only the sub-path is listed |

### Permission values

- `"ro"` — read-only
- `"rw"` — read-write
- `null` — no access (hidden)

### Host mounts

Stages can mount host directories outside the project via `hostMounts`. Each mount is validated against `~/.config/aer-art/mount-allowlist.json`.

```json
"hostMounts": [
  { "hostPath": "~/datasets/imagenet", "containerPath": "data", "readonly": true },
  { "hostPath": "/opt/tools", "containerPath": "tools", "readonly": true }
]
```

- Mounted at `/workspace/extra/{containerPath}` (defaults to basename of `hostPath`)
- `readonly` defaults to `true` — only set `false` when the stage needs to write
- Host path must be under an allowed root in the allowlist
- Blocked patterns (`.ssh`, `.env`, `.aws`, etc.) are automatically rejected
- If a `hostMounts` entry has the same container path as a parent group's `additionalMounts`, the stage-level mount takes precedence

### Rules

- If `project` is `null`, all `project:*` overrides must also be `null` or omitted.
- If `project` is omitted, it defaults to `"ro"`.
- Reserved keys (cannot use as mount names, including as sub-path parents): `ipc`, `global`, `extra`, `conversations`.
- `__art__/` is always shadowed (agents cannot see pipeline config).
- **Sub-path rules**: relative paths only, no `..` or `.` segments, no leading `/`, directories only.
- **Direct-mode sub-paths** (`<key>:<sub>` without the parent `<key>` being mounted) are useful for fan-out: each child mounts its own isolated sub-path while the parent remains visible only to stages that mount the top-level key.

### Least privilege principle

Each stage must have the **minimum permissions required** to do its job. A build stage that only modifies `src/` should not have `rw` on the entire project. A reviewer that only reads results should not have write access to code. Think about what each stage reads and writes, then set permissions accordingly. When in doubt, default to `ro` and only upgrade to `rw` for directories the stage must modify.

### Common mount patterns

```jsonc
// Git agent: read source, write only .git
{ "project": "ro", "project:.git": "rw" }

// Builder: modify project code
{ "project": "rw", "plan": "ro", "src": "rw" }

// Tester: read code, write results
{ "project": "ro", "results": "rw", "cache": "rw" }

// Reviewer: read everything, write metrics
{ "project": "ro", "results": "rw" }

// ML training: read external dataset, write model cache
"mounts": { "project": "ro", "results": "rw" },
"hostMounts": [
  { "hostPath": "~/datasets/imagenet", "containerPath": "data", "readonly": true },
  { "hostPath": "~/model-cache", "containerPath": "cache", "readonly": false }
]
```

---

## Built-in Template Reference

These are common patterns. Customize mounts and transitions for each use case.

| Template | Type | Purpose | Typical Mounts |
|----------|------|---------|----------------|
| `plan` | agent | Read context, write PLAN.md | plan:rw, metrics:ro, insights:ro |
| `build` | agent | Implement code changes | project:rw, plan:ro, src:rw |
| `test` | agent | Adversarial validation | project:ro, src:ro, tests:rw, outputs:rw |
| `review` | agent | Examine results, write report | project:ro, metrics:rw, outputs:ro |
| `history` | agent | Distill insights from reports | metrics:ro, insights:rw, memory:rw |
| `deploy` | agent | Build and deploy | project:ro, src:ro, build:rw |
| `git` | agent | Git operations (commit, branch, push) | project:ro, project:.git:rw |
| `git-init` | command | Initialize git repo | project:rw, image: alpine/git |
| `git-branch` | command | Create branch | project:rw, image: alpine/git |
| `git-commit` | command | Stage & commit | project:rw, msg:ro, image: alpine/git |
| `git-reset` | command | Hard reset HEAD~1 | project:rw, image: alpine/git |
| `git-keep` | command | No-op passthrough | {}, image: alpine/git |
| `git-push` | command | Push to remote | project:rw, image: alpine/git |
| `git-pr` | command | Create GitHub PR | project:ro, image: alpine/git |
| `run` | command | Generic shell command | project:ro |

---

## Common Pipeline Patterns

### Linear
```
A → B → C → (end)
```
Each stage's transition: `{ "marker": "STAGE_COMPLETE", "next": "B" }`, last has `"next": null`.

### Loop with exit condition
```
build → test → review → [KEEP → build | FAIL → end]
```
The review stage has multiple markers routing to different next stages. At least one path must reach `null`.

### Git sandwich
```
git-start → (work stages) → git-save → (more stages)
```
Wrap iteration loops with git agent stages. Use `project:ro` + `project:.git:rw`.

### Error handling
No user-authored retry. Options when something fails:
- Terminate: `{ "marker": "STAGE_ERROR", "next": null }` — pipeline ends.
- Recover via stitch: `{ "marker": "STAGE_ERROR", "next": "recovery-tpl" }` — template runs a corrective flow.
- Parse-miss loop: if the agent emits no recognizable marker, the runner automatically re-prompts with a hint. Unlimited — use markers carefully.

### GPU command stage
```json
{
  "name": "train",
  "prompt": "",
  "command": "cd /workspace/project && python train.py > /workspace/results/log.txt 2>&1",
  "image": "nvidia/cuda:12.4.1-devel-ubuntu22.04",
  "gpu": true,
  "runAsRoot": true,
  "mounts": { "project": "ro", "results": "rw", "cache": "rw" },
  "transitions": [
    { "marker": "STAGE_COMPLETE", "next": "review" },
    { "marker": "STAGE_ERROR", "next": null }
  ]
}
```

### Privileged command stage (e.g. FPGA tools, USB devices)
```json
{
  "name": "fpga-synth",
  "prompt": "",
  "command": "source /tools/Xilinx/Vivado/2023.2/settings64.sh && cd /workspace/project && make fpga 2>&1",
  "image": "cva6-vivado",
  "privileged": true,
  "mounts": { "project": "ro", "build": "rw" },
  "transitions": [
    { "marker": "STAGE_COMPLETE", "next": "review" },
    { "marker": "STAGE_ERROR", "next": null }
  ]
}
```

### Chatting stage (interactive user conversation)
```json
{
  "name": "interview",
  "prompt": "Discuss requirements with the user. Ask clarifying questions.",
  "chat": true,
  "mounts": { "project": "ro", "plan": "rw" },
  "transitions": [
    { "marker": "INTERVIEW_COMPLETE", "next": "implement", "prompt": "Requirements clarified" },
    { "marker": "STAGE_ERROR", "next": null, "prompt": "Interview could not proceed — abort" }
  ]
}
```

### Parallel work via stitch (`count: N`)
Parallel execution comes from stitching a template `N` times with a synthesized fan-in barrier. Author the parallel work as a template and reference it with `count`:

```jsonc
// PIPELINE.json
{
  "stages": [
    {
      "name": "plan",
      "prompt": "Decide how many variants to probe (emit [GO]).",
      "mounts": { "plan": "rw" },
      "transitions": [
        { "marker": "GO", "next": "probe-variant", "count": 4, "prompt": "Probe 4 variants in parallel" }
      ]
    }
  ],
  "entryStage": "plan"
}
```

```jsonc
// __art__/templates/probe-variant.json
{
  "entry": "probe",
  "stages": [
    {
      "name": "probe",
      "prompt": "Probe variant {{index}} (insertId={{insertId}}). Write result to /workspace/results/{{insertId}}.txt",
      "mounts": { "results": "rw" },
      "transitions": [{ "marker": "DONE", "next": null }]
    }
  ]
}
```

At runtime this expands to `plan → [plan__probe-variant0__probe, plan__probe-variant1__probe, plan__probe-variant2__probe, plan__probe-variant3__probe] → plan__probe-variant__barrier → (pipeline ends)`.

---

## Prompt Writing Guidelines

Agent stage prompts must be **self-contained** — the agent has no memory of previous stages.

1. **Reference concrete paths**: `/workspace/project/src/`, `/workspace/results/metrics.txt`
2. **Specify markers**: "When done, emit [STAGE_COMPLETE]." If multiple exits: "Emit [KEEP] if improved, [RESET] if not."
3. **State constraints**: what the agent must NOT do ("Do NOT run the code", "Only modify src/train.py")
4. **Describe the goal**: what success looks like for this stage
5. **Mention inputs**: what files/data the agent should read first
6. **Keep it focused**: one clear responsibility per stage
7. **Validation stages must be adversarial**: test/validation stages must try to break the implementation, not confirm it works. They should be independent of how the code was built — test against the specification, not the implementation. The tester should not see the plan or know the builder's approach.
8. **When using external MCP tools, describe intent not protocol**: mention which capability the stage should use and when (e.g. "Use get_batch to load the next batch from the pipeline DB"). Do not restate raw HTTP/MCP protocol details in the prompt.
9. **If a stage gets exactly one MCP tool, naming the tool is enough**. If multiple MCP tools or similar capabilities are present, mention both the server role and the tool intent to avoid ambiguity.

---

## Workflow

When this skill is invoked:

1. **Read the input.** If the user provides a file path (e.g., plan.md), read it. Otherwise use the conversation context.

2. **Identify stages.** List each discrete step. For each, determine:
   - Name (kebab-case, descriptive)
   - Type (agent if judgment needed, command if deterministic)
   - What it reads and writes

3. **Design mounts.** Apply least privilege. Use `project:` sub-path overrides where needed (e.g., `project:.git: rw` for git operations).

4. **Decide external MCP access.** If the workflow needs host-side tools or databases:
   - Add `mcpAccess` only to the stages that need it
   - Use registry refs from `~/.config/aer-art/mcp-registry.json`
   - Prefer separate refs/endpoints per stage capability when strong isolation matters
   - Do not put raw MCP server URLs or transport details in `PIPELINE.json`

5. **Wire transitions.** Map the flow between stages. Ensure:
   - At least one path reaches `next: null` (pipeline termination)
   - Loops have clear exit conditions
   - Error handling where appropriate
   - **Every transition has a `prompt`** describing the condition under which the agent should emit that marker (e.g., "All tests pass and code is ready for review", "Recoverable error — retry with different approach"). Write these as conditions: "when X", "if Y", or declarative descriptions of the trigger scenario.

6. **Choose images** for command stages. Common choices:
   - `alpine/git` — git operations
   - `node:22-slim` — Node.js tasks
   - `python:3.12-slim` — Python tasks
   - `nvidia/cuda:12.4.1-devel-ubuntu22.04` — GPU workloads

7. **Write prompts** for agent stages following the guidelines above.

8. **Run the checklist** (below).

9. **Write** `__art__/PIPELINE.json` with 2-space indentation. If the file already exists, ask before overwriting.

10. **Create mount directories** under `__art__/` for any art-managed keys referenced in mounts (e.g., `mkdir -p __art__/results`).

---

## Pre-Output Checklist

Before writing the JSON, verify ALL of the following:

- [ ] Every stage has a unique `name`
- [ ] Every transition `next` references an existing stage name or is `null`
- [ ] Every stage has at least one transition
- [ ] Command stages have `prompt: ""`, an `image` field, and only `STAGE_COMPLETE`/`STAGE_ERROR` transitions
- [ ] Command stages use `successMarker` if success depends on stdout content (otherwise exit code is used)
- [ ] Agent stages have a non-empty `prompt` and no `command` field
- [ ] `mcpAccess` appears only on agent stages
- [ ] Every `mcpAccess` entry is a registry ref, not a raw tool name or URL
- [ ] Stage-level MCP capabilities follow least privilege (only the stages that need them get them)
- [ ] If Codex compatibility matters, stage-level MCP isolation is enforced by separate refs/endpoints rather than relying on tool subsets within one shared server
- [ ] At least one path through the graph reaches `next: null`
- [ ] Mount keys do not use reserved names (`ipc`, `global`, `extra`, `conversations`) — including as sub-path parents (`ipc:x` is invalid)
- [ ] `project:*` overrides are absent when `project` is `null`
- [ ] Sub-path mounts (`<key>:<sub>`) use only relative directory paths (no `..`, no leading `/`)
- [ ] `entryStage` (if set) references an existing stage name
- [ ] Marker names in JSON match what prompts tell agents to emit (bare in JSON, bracketed in prompts)
- [ ] `hostMounts` entries use absolute paths or `~` prefix and reference valid `containerPath` values
- [ ] No transition uses legacy `retry` or `next_dynamic` (both removed)
- [ ] No stage uses `kind: "dynamic-fanout"` or `fan_in: "dynamic"` (both removed)
- [ ] No transition has an authored array `next` — multi-target arrays are only produced by parallel stitch
- [ ] The base PIPELINE.json graph is acyclic (DAG). If you need a loop, express it as a template that stitches itself
- [ ] Each transition's `next` is either an existing stage name, a template name (file at `__art__/templates/<name>.json`), or `null`
- [ ] `count` is only used when `next` is a template name, and is a positive integer
- [ ] Templates live at `__art__/templates/<name>.json` with `{ entry?, stages }` shape; internal transitions are acyclic; names do not collide with base pipeline stages in a way that would prevent renaming
- [ ] The JSON is valid and parseable
