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
  next_dynamic?: boolean; // Agent picks targets at runtime via payload; next becomes allowlist
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
  kind?: "agent" | "command" | "dynamic-fanout"; // Explicit stage kind. Inferred if omitted (except for dynamic-fanout which must be explicit)
  prompt: string;        // Agent instructions (must be "" for command stages)
  command?: string;      // Shell command — presence makes this a command stage
  successMarker?: string; // Command mode only: stdout substring that means success → STAGE_COMPLETE
  errorMarker?: string;   // Command mode only: stdout substring that means failure → STAGE_ERROR (resolves immediately, kills process)
  chat?: boolean;        // Interactive chatting stage (agent converses with user via stdin)
  image?: string;        // Docker image (required for command stages, optional for agent)
  mounts: Record<string, "ro" | "rw" | null>;
  hostMounts?: AdditionalMount[]; // Host path mounts (validated against allowlist)
  gpu?: boolean;         // Pass --gpus all
  runAsRoot?: boolean;   // Run container as root
  privileged?: boolean;  // Run with --privileged (full device access)
  env?: Record<string, string>; // Environment variables passed to container
  devices?: string[];    // Device passthrough
  exclusive?: string;    // Mutex key — only one stage with same key runs at a time
  mcpAccess?: string[];  // External MCP registry refs available to this agent stage
  resumeSession?: boolean; // false = fresh session every time. default true = resume previous session
  fan_in?: "all" | "dynamic"; // Default "all". "dynamic" = wait only for activated predecessors
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
| Marker emission | Agent prints `[MARKER]` in response | Automatic: `STAGE_COMPLETE` / `STAGE_ERROR` based on `successMarker` or exit code |
| Transitions | N transitions with custom markers | Fixed: `STAGE_COMPLETE` + `STAGE_ERROR` only |
| Retry | Supported (`retry: true`) | Not supported — fails immediately |

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

#### Dynamic fan-out (`kind: "dynamic-fanout"`)

A `dynamic-fanout` stage spawns `N` parallel **child pipelines** at runtime, one per element of a JSON array emitted by the preceding stage. No container runs for the fanout stage itself — it is pure host-side orchestration.

```json
{
  "name": "producer",
  "prompt": "List all modules to build. Emit [STAGE_COMPLETE] with a JSON array payload of {\"name\":...} objects.",
  "mounts": { "project": "ro" },
  "transitions": [{ "marker": "STAGE_COMPLETE", "next": "per-module-build", "prompt": "Module list produced" }]
},
{
  "name": "per-module-build",
  "kind": "dynamic-fanout",
  "template": "templates/build-one.pipeline.json",
  "inputFrom": "payload",
  "substitutions": { "fields": ["prompt", "mounts"] },
  "concurrency": 4,
  "failurePolicy": "all-success",
  "mounts": {},
  "transitions": [
    { "marker": "STAGE_COMPLETE", "next": "aggregate", "prompt": "All child pipelines succeeded" },
    { "marker": "STAGE_ERROR", "next": null, "prompt": "Any child pipeline failed" }
  ]
}
```

The preceding stage emits a fenced payload:

```
[STAGE_COMPLETE]
---PAYLOAD_START---
[{"name":"module-a","port":8080},{"name":"module-b","port":8081}]
---PAYLOAD_END---
```

The child template can reference placeholders from those payload elements:

```json
// templates/build-one.pipeline.json
{
  "stages": [
    {
      "name": "child_build",
      "prompt": "Build {{name}} on port {{port}}",
      "mounts": { "project": "ro", "src": "rw" },
      "transitions": [{ "marker": "BUILD_DONE", "next": null, "prompt": "Built {{name}}" }]
    }
  ]
}
```

Rules:
- `kind: "dynamic-fanout"` must be **explicit** (never inferred)
- Preceding stage payload must be a **JSON array of flat objects** (string/number/boolean values only)
- `template` path is relative to `__art__/` and must stay within it
- `substitutions.fields` whitelist defaults to none — if substitutions are needed, list them explicitly
- Allowed substitution fields: `prompt`, `prompts`, `prompt_append`, `mounts`, `hostMounts`, `env`, `image`, `command`
- `failurePolicy` currently supports only `"all-success"` (any child failure fails the parent, all children still complete)
- `concurrency` caps parallelism. Omit for unbounded
- Agent/command fields (`prompt`, `command`, `image`, `mcpAccess`, `chat`, …) are **forbidden** on fanout stages
- `next_dynamic` transitions are forbidden on fanout stages
- Maximum nesting depth is **2** (parent → fanout → grandchild-fanout → grandgrandchild-fanout would fail)

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

### Error retry (agent stages only)
Add to any **agent** stage (not command stages — they fail immediately):
```json
{ "marker": "STAGE_ERROR", "retry": true, "prompt": "Recoverable error — retry" }
```

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
    { "marker": "STAGE_ERROR", "retry": true }
  ]
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

### Dynamic Transition (selective fan-out)
`next_dynamic: true`를 쓰면 agent가 런타임에 fan-out target을 선택할 수 있다. `next`는 허용 목록(allowlist)으로 작동하며, agent는 marker payload로 subset을 지정한다.

Agent emission format:
- `[MARKER:stage1]` → single target
- `[MARKER:stage1,stage2]` → multiple targets (selective fan-out)
- `[MARKER]` → payload 없으면 `next` 전체 사용 (fallback)

```json
{
  "name": "review-router",
  "prompt": "Analyze test failure log at /workspace/results/router-test.log.\nDetermine which modules caused the failure.\nEmit [FIX:edit-arbiter] or [FIX:edit-arbiter,edit-crossbar] depending on the cause.",
  "mounts": { "project": "ro", "results": "ro" },
  "transitions": [
    {
      "marker": "FIX",
      "next_dynamic": true,
      "next": ["edit-arbiter", "edit-crossbar", "edit-router"],
      "prompt": "Agent identified failing modules — re-edit only those"
    },
    { "marker": "PASS", "next": "test-system", "prompt": "All modules pass" },
    { "marker": "STAGE_ERROR", "retry": true, "prompt": "Environment error" }
  ]
}
```

Rules:
- `next_dynamic` and `retry` cannot be used together
- `next_dynamic` requires `next` to be a non-null array (allowlist)
- Agent payload targets must be in the allowlist, otherwise runtime error

### Conditional Fan-in (`fan_in: "dynamic"`)
기본 fan-in은 모든 predecessor가 완료되어야 실행된다. `fan_in: "dynamic"`이면 **활성화된 predecessor만** 기다린다. Dynamic transition으로 일부 경로만 재실행할 때, 재실행하지 않은 경로를 기다리지 않게 한다.

```json
{
  "name": "test-router",
  "fan_in": "dynamic",
  "prompt": "",
  "command": "cd /workspace/project && make test-router 2>&1",
  "image": "sim-runner:latest",
  "mounts": { "project": "ro", "results": "rw" },
  "transitions": [
    { "marker": "STAGE_COMPLETE", "next": "test-system" },
    { "marker": "STAGE_ERROR", "next": "review-router" }
  ]
}
```

Use `fan_in: "dynamic"` on any stage that:
- Is the convergence point after a `next_dynamic` transition
- Might not have all predecessors re-run in every execution cycle

### Hierarchical test promotion (dynamic fan-out + conditional fan-in)
Bottom-up test promotion pattern. On failure, review agent selectively re-runs only the causal modules.
```
plan → [edit-arbiter, edit-crossbar] → [test-arbiter, test-crossbar]
                                        ↓ fan-in (dynamic)
                                    edit-router → test-router
                                        ↓ FAIL
                                    review-router → [FIX:edit-arbiter] (dynamic)
                                        ↓ re-run arbiter only
                                    edit-arbiter → test-arbiter → edit-router (fan-in: dynamic)
                                        ↓
                                    test-router → PASS → done
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
- [ ] Command stages have `prompt: ""`, an `image` field, and only `STAGE_COMPLETE`/`STAGE_ERROR` transitions (no retry)
- [ ] Command stages use `successMarker` if success depends on stdout content (otherwise exit code is used)
- [ ] Agent stages have a non-empty `prompt` and no `command` field
- [ ] `mcpAccess` appears only on agent stages
- [ ] Every `mcpAccess` entry is a registry ref, not a raw tool name or URL
- [ ] Stage-level MCP capabilities follow least privilege (only the stages that need them get them)
- [ ] If Codex compatibility matters, stage-level MCP isolation is enforced by separate refs/endpoints rather than relying on tool subsets within one shared server
- [ ] At least one path through the graph reaches `next: null`
- [ ] Mount keys do not use reserved names (`ipc`, `global`, `extra`, `conversations`)
- [ ] `project:*` overrides are absent when `project` is `null`
- [ ] `entryStage` (if set) references an existing stage name
- [ ] Marker names in JSON match what prompts tell agents to emit (bare in JSON, bracketed in prompts)
- [ ] `hostMounts` entries use absolute paths or `~` prefix and reference valid `containerPath` values
- [ ] `next_dynamic` transitions have `next` as a non-null array (allowlist)
- [ ] `next_dynamic` and `retry` are not used on the same transition
- [ ] `dynamic-fanout` stages set `kind: "dynamic-fanout"` explicitly and declare `template` + `inputFrom: "payload"`
- [ ] `dynamic-fanout` stages do not declare any agent/command fields (`prompt`, `command`, `image`, `mcpAccess`, `chat`, `env`, `hostMounts`, `devices`, `gpu`, `runAsRoot`, `privileged`, `exclusive`, `resumeSession`, `successMarker`, `errorMarker`)
- [ ] Stage immediately before a `dynamic-fanout` emits a fenced payload with a JSON array of flat objects (string/number/boolean values)
- [ ] Fanout `substitutions.fields` only includes allowed fields (`prompt`, `prompts`, `prompt_append`, `mounts`, `hostMounts`, `env`, `image`, `command`)
- [ ] Fanout `template` path is relative to `__art__/` and stays inside it
- [ ] Nesting depth of fanout stages is ≤ 2 (one pipeline may contain at most two nested `dynamic-fanout` levels)
- [ ] `fan_in: "dynamic"` stages have multiple predecessors (otherwise meaningless)
- [ ] Dynamic fan-out → fan-in paths use `fan_in: "dynamic"` at convergence points
- [ ] The JSON is valid and parseable
