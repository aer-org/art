---
name: generate-pipeline
description: Generate a valid __art__/PIPELINE.json from a plan, description, or stage list. Use when the user wants to create or rebuild a pipeline configuration, describes workflow stages, or asks to set up an agent pipeline.
---

# Generate Pipeline

Convert a user's plan (free-form text, plan.md, or verbal description) into a valid `__art__/PIPELINE.json` that the AerArt pipeline runner can execute.

---

## Schema Reference

```typescript
interface PipelineTransition {
  marker: string;        // Bare name, e.g. "STAGE_COMPLETE" (agents emit as [STAGE_COMPLETE])
  next?: string | string[] | null;  // Target stage(s), array for fan-out, null to end pipeline
  retry?: boolean;       // true = retry current stage on this marker
  prompt?: string;       // **Required in practice** — describes when the agent should emit this marker
}

interface AdditionalMount {
  hostPath: string;      // Absolute path or ~ for home
  containerPath?: string; // Mounted at /workspace/extra/{value}, default: basename(hostPath)
  readonly?: boolean;    // Default: true
}

interface PipelineStage {
  name: string;          // Unique stage identifier
  prompt: string;        // Agent instructions (must be "" for command stages)
  command?: string;      // Shell command — presence makes this a command stage
  image?: string;        // Docker image (required for command stages, optional for agent)
  mounts: Record<string, "ro" | "rw" | null>;
  hostMounts?: AdditionalMount[]; // Host path mounts (validated against allowlist)
  gpu?: boolean;         // Pass --gpus all
  runAsRoot?: boolean;   // Run container as root
  privileged?: boolean;  // Run with --privileged (full device access)
  env?: Record<string, string>; // Environment variables passed to container
  devices?: string[];    // Device passthrough
  exclusive?: string;    // Mutex key — only one stage with same key runs at a time
  resumeSession?: boolean; // false = fresh session every time. default true = resume previous session
  transitions: PipelineTransition[];
}

interface PipelineConfig {
  stages: PipelineStage[];
  entryStage?: string;   // Defaults to first stage in array
}
```

### Stage types

| | Agent stage | Command stage |
|---|---|---|
| `prompt` | Non-empty instructions | Must be `""` |
| `command` | Absent or undefined | Shell string (`sh -c`) |
| `image` | Optional (registry key or omit for default) | **Required** (Docker image name) |
| Execution | Claude agent with tools | `sh -c <command>`, no agent |
| Marker emission | Agent prints `[MARKER]` in response | Command must `echo '[MARKER]'` |

---

## Mount Reference

### Mount keys

| Key | Container path | Notes |
|-----|---------------|-------|
| `project` | `/workspace/project/` | User's project root (parent of `__art__/`) |
| `project:<subdir>` | `/workspace/project/<subdir>/` | Sub-path override (directories only, no files) |
| Any other key | `/workspace/<key>/` | Art-managed directory under `__art__/<key>/` |

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
- Reserved keys (cannot use as mount names): `ipc`, `global`, `extra`, `conversations`.
- `__art__/` is always shadowed (agents cannot see pipeline config).
- **Least privilege**: give each stage only what it needs.

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

### Error retry
Add to any stage:
```json
{ "marker": "STAGE_ERROR", "retry": true, "prompt": "Recoverable error — retry" }
```

### GPU command stage
```json
{
  "name": "train",
  "prompt": "",
  "command": "cd /workspace/project && python train.py > /workspace/results/log.txt 2>&1; echo '[STAGE_COMPLETE]'",
  "image": "nvidia/cuda:12.4.1-devel-ubuntu22.04",
  "gpu": true,
  "runAsRoot": true,
  "mounts": { "project": "ro", "results": "rw", "cache": "rw" },
  "transitions": [{ "marker": "STAGE_COMPLETE", "next": "review" }]
}
```

### Privileged command stage (e.g. FPGA tools, USB devices)
```json
{
  "name": "fpga-synth",
  "prompt": "",
  "command": "source /tools/Xilinx/Vivado/2023.2/settings64.sh && cd /workspace/project && make fpga 2>&1; echo '[STAGE_COMPLETE]'",
  "image": "cva6-vivado",
  "privileged": true,
  "mounts": { "project": "ro", "build": "rw" },
  "transitions": [{ "marker": "STAGE_COMPLETE", "next": "review" }]
}
```

### Fan-out / Fan-in (parallel stages)
`next` can be an array to fan-out into parallel stages. Fan-in is automatic: a stage with multiple predecessors waits for all to complete.
```json
{
  "stages": [
    {
      "name": "build",
      "prompt": "Build the project...",
      "mounts": { "src": "ro", "build": "rw" },
      "transitions": [{ "marker": "BUILD_OK", "next": ["test-unit", "test-e2e"] }]
    },
    {
      "name": "test-unit",
      "prompt": "Run unit tests...",
      "mounts": { "build": "ro", "results": "rw" },
      "transitions": [{ "marker": "DONE", "next": "deploy" }]
    },
    {
      "name": "test-e2e",
      "prompt": "Run e2e tests...",
      "mounts": { "build": "ro", "results": "rw" },
      "transitions": [{ "marker": "DONE", "next": "deploy" }]
    },
    {
      "name": "deploy",
      "prompt": "Deploy after all tests pass...",
      "mounts": { "build": "ro" },
      "transitions": [{ "marker": "DEPLOYED", "next": null }]
    }
  ]
}
```

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

---

## Workflow

When this skill is invoked:

1. **Read the input.** If the user provides a file path (e.g., plan.md), read it. Otherwise use the conversation context.

2. **Identify stages.** List each discrete step. For each, determine:
   - Name (kebab-case, descriptive)
   - Type (agent if judgment needed, command if deterministic)
   - What it reads and writes

3. **Design mounts.** Apply least privilege. Use `project:` sub-path overrides where needed (e.g., `project:.git: rw` for git operations).

4. **Wire transitions.** Map the flow between stages. Ensure:
   - At least one path reaches `next: null` (pipeline termination)
   - Loops have clear exit conditions
   - Error handling where appropriate
   - **Every transition has a `prompt`** describing the condition under which the agent should emit that marker (e.g., "All tests pass and code is ready for review", "Recoverable error — retry with different approach"). Write these as conditions: "when X", "if Y", or declarative descriptions of the trigger scenario.

5. **Choose images** for command stages. Common choices:
   - `alpine/git` — git operations
   - `node:22-slim` — Node.js tasks
   - `python:3.12-slim` — Python tasks
   - `nvidia/cuda:12.4.1-devel-ubuntu22.04` — GPU workloads

6. **Write prompts** for agent stages following the guidelines above.

7. **Run the checklist** (below).

8. **Write** `__art__/PIPELINE.json` with 2-space indentation. If the file already exists, ask before overwriting.

9. **Create mount directories** under `__art__/` for any art-managed keys referenced in mounts (e.g., `mkdir -p __art__/results`).

---

## Pre-Output Checklist

Before writing the JSON, verify ALL of the following:

- [ ] Every stage has a unique `name`
- [ ] Every transition `next` references an existing stage name or is `null`
- [ ] Every stage has at least one transition
- [ ] Command stages have `prompt: ""` and an `image` field
- [ ] Agent stages have a non-empty `prompt` and no `command` field
- [ ] At least one path through the graph reaches `next: null`
- [ ] Mount keys do not use reserved names (`ipc`, `global`, `extra`, `conversations`)
- [ ] `project:*` overrides are absent when `project` is `null`
- [ ] `entryStage` (if set) references an existing stage name
- [ ] Marker names in JSON match what prompts tell agents to emit (bare in JSON, bracketed in prompts)
- [ ] `hostMounts` entries use absolute paths or `~` prefix and reference valid `containerPath` values
- [ ] The JSON is valid and parseable
