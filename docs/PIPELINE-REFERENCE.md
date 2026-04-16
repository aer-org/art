# PIPELINE.json Reference

This document describes every configurable field in `__art__/PIPELINE.json`.

## Top-Level

```json
{
  "stages": [...],
  "entryStage": "build"
}
```

| Field        | Type              | Required | Description                                                                        |
| ------------ | ----------------- | -------- | ---------------------------------------------------------------------------------- |
| `stages`     | `PipelineStage[]` | Yes      | List of pipeline stages                                                            |
| `entryStage` | `string`          | No       | Name of the first stage to execute. If omitted, the first item in `stages` is used |

## Stage

```json
{
  "name": "build",
  "prompt": "Read PLAN.md and implement the described changes.",
  "image": "default",
  "command": null,
  "mounts": { "plan": "ro", "src": "rw", "project": "ro" },
  "mcpAccess": ["sqlite.read"],
  "devices": [],
  "runAsRoot": false,
  "exclusive": "vivado",
  "transitions": [...]
}
```

| Field         | Type                                   | Required | Default     | Description                                                                                                                                        |
| ------------- | -------------------------------------- | -------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | `string`                               | Yes      | —           | Unique stage identifier                                                                                                                            |
| `kind`        | `"agent" \| "command" \| "dynamic-fanout"` | No   | inferred    | Explicit stage kind. If omitted, inferred: `command` when `command` is set, else `agent`. `dynamic-fanout` must be explicit. See [Dynamic Fan-out](#dynamic-fan-out) |
| `prompt`      | `string`                               | Yes      | —           | System prompt sent to the agent. Describes what this stage should do                                                                               |
| `image`       | `string`                               | No       | `"default"` | Image registry key (agent mode) or full image name (command mode). See [Image Registry](#image-registry)                                           |
| `command`     | `string`                               | No       | `null`      | If set, runs this shell command via `sh -c` instead of spawning an agent. Output markers are parsed from stdout. See [Command Mode](#command-mode) |
| `mounts`      | `Record<string, "ro" \| "rw" \| null>` | Yes      | —           | Mount permissions for `__art__/` subdirectories and the project root. See [Mounts](#mounts)                                                        |
| `devices`     | `string[]`                             | No       | `[]`        | Host devices to pass through (e.g., `"/dev/bus/usb"`)                                                                                              |
| `runAsRoot`   | `boolean`                              | No       | `false`     | Run this stage's container as root (`--user 0:0`)                                                                                                  |
| `exclusive`   | `string`                               | No       | —           | Mutex key. Stages sharing the same key never run concurrently (e.g., `"vivado"` for stages that need exclusive access to a hardware resource)      |
| `hostMounts`  | `AdditionalMount[]`                    | No       | `[]`        | Host path mounts for this stage. Validated against the mount allowlist. See [Host Mounts](#host-mounts)                                            |
| `mcpAccess`   | `string[]`                             | No       | `[]`        | External MCP registry refs available to this stage. See [External MCP Access](#external-mcp-access)                                                |
| `transitions` | `PipelineTransition[]`                 | Yes      | —           | How to move to the next stage based on agent output. See [Transitions](#transitions)                                                               |

## Mounts

Mounts control what each stage can access. Keys are directory names inside `__art__/`, plus the special `project` key for the host project root.

```json
"mounts": {
  "plan": "ro",
  "src": "rw",
  "tests": "rw",
  "outputs": "rw",
  "memory": "ro",
  "project": "ro"
}
```

| Value  | Meaning                                                      |
| ------ | ------------------------------------------------------------ |
| `"ro"` | Read-only — stage can read but not modify                    |
| `"rw"` | Read-write — stage can read and write                        |
| `null` | Hidden — not mounted at all, stage cannot see this directory |

Omitting a key is equivalent to `null` (hidden).

### Sub-path mounts

Any mount key supports `<key>:<subpath>` overrides that bind a nested directory with a different permission than the parent. Two modes:

**Override mode** — the parent key is also mounted; the sub-mount rebinds a subtree with a different policy:

```json
"mounts": {
  "project": "ro",
  "project:src/generated": "rw",
  "project:secrets": null,
  "results": "ro",
  "results:draft": "rw"
}
```

`project` mounts the project root as read-only but grants write to `src/generated/` and hides `secrets/`. `results` mounts `<groupDir>/results/` as read-only but makes `draft/` writable.

**Direct mode** — the parent key is NOT in `mounts`; the sub-mount acts as a standalone nested destination. Useful when sibling runners need isolated subdirectories of a shared parent:

```json
"mounts": {
  "cov_per_section:S-01": "rw"
}
```

This mounts only `<groupDir>/cov_per_section/S-01/` at `/workspace/cov_per_section/S-01/` — the parent `cov_per_section/` is not itself bound.

**Rules:**

- Sub-path values may be `"ro"`, `"rw"`, or `null`
- `null` shadows with an empty dir (only meaningful when parent is mounted)
- Sub-paths are directories only (file bind mounts are rejected — Docker inode semantics break on git operations)
- Sub-paths must be relative, non-empty, and contain no `..` or `.` segments
- Reserved parent keys (`ipc`, `global`, `extra`, `conversations`) are rejected
- If the sub-path policy equals the parent policy, no override is added (already covered)
- For `project:<path>`, the sub-path is relative to the **project root**. For any other `<key>:<path>`, it is relative to `<groupDir>/<key>/`
- `project:<artDirName>` and deeper are always rejected (the `__art__/` dir is always shadowed)

### How mounts map to containers

| Mount key           | Container path                                              |
| ------------------- | ----------------------------------------------------------- |
| `plan`              | `/workspace/plan`                                           |
| `src`               | `/workspace/src`                                            |
| `outputs`           | `/workspace/outputs`                                        |
| `project`           | `/workspace/project`                                        |
| `project:src/foo`   | `/workspace/project/src/foo` (overlay on project mount)     |
| `results:draft`     | `/workspace/results/draft` (override nested under `results`) |
| `cov_per_section:S-01` | `/workspace/cov_per_section/S-01` (direct, parent not mounted) |

The agent's working directory is `/workspace`.

## Host Mounts

Host mounts allow a stage to access directories from the host filesystem outside the project. Each mount is validated against the mount allowlist at `~/.config/aer-art/mount-allowlist.json`.

```json
"hostMounts": [
  { "hostPath": "~/datasets", "readonly": true },
  { "hostPath": "/opt/tools", "containerPath": "tools", "readonly": true },
  { "hostPath": "~/shared-cache", "containerPath": "cache", "readonly": false }
]
```

| Field           | Type      | Required | Default                | Description                             |
| --------------- | --------- | -------- | ---------------------- | --------------------------------------- |
| `hostPath`      | `string`  | Yes      | —                      | Absolute path or `~` prefix on the host |
| `containerPath` | `string`  | No       | basename of `hostPath` | Mounted at `/workspace/extra/{value}`   |
| `readonly`      | `boolean` | No       | `true`                 | Whether the mount is read-only          |

### Security

- The host path must be under an allowed root in `~/.config/aer-art/mount-allowlist.json`
- Paths matching blocked patterns (`.ssh`, `.env`, `.aws`, etc.) are automatically rejected
- Non-main groups may be forced to read-only via the `nonMainReadOnly` allowlist setting
- If a stage `hostMounts` entry has the same container path as a parent group's `additionalMounts`, the stage-level mount takes precedence

### Example

```json
{
  "name": "train",
  "prompt": "Train the model using the dataset in /workspace/extra/data.",
  "mounts": { "src": "ro", "outputs": "rw" },
  "hostMounts": [
    {
      "hostPath": "~/ml-datasets/imagenet",
      "containerPath": "data",
      "readonly": true
    },
    { "hostPath": "~/model-cache", "containerPath": "cache", "readonly": false }
  ],
  "gpu": true,
  "transitions": [
    { "marker": "STAGE_COMPLETE", "next": "evaluate" },
    { "marker": "STAGE_ERROR", "retry": true }
  ]
}
```

## External MCP Access

Stages can opt into external MCP servers by referencing entries from the host-side registry at `~/.config/aer-art/mcp-registry.json`.

```json
{
  "sqlite.read": {
    "name": "sqlite_read",
    "transport": "http",
    "url": "http://${ART_HOST_GATEWAY}:4318/mcp",
    "tools": ["query", "get_schema"]
  },
  "sqlite.write": {
    "name": "sqlite_write",
    "transport": "stdio",
    "command": "node",
    "args": ["tools/sqlite-write-mcp.js"],
    "env": {
      "SQLITE_DB": "/workspace/project/db.sqlite"
    },
    "tools": ["upsert_state"]
  }
}
```

In `PIPELINE.json`, reference the registry keys:

```json
{
  "name": "build",
  "prompt": "Read PLAN.md and update the DB state after each completed step.",
  "mounts": { "plan": "ro", "src": "rw", "project": "ro" },
  "mcpAccess": ["sqlite.read", "sqlite.write"],
  "transitions": [{ "marker": "STAGE_COMPLETE", "next": null }]
}
```

### Registry Fields

| Field               | Type                     | Required        | Description                                                                                                                 |
| ------------------- | ------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `name`              | `string`                 | No              | Exposed MCP server name inside the agent. Defaults to a sanitized form of the registry key                                  |
| `transport`         | `"stdio" \| "http"`      | No              | MCP transport. Defaults to `"stdio"`                                                                                        |
| `command`           | `string`                 | Yes for `stdio` | Command used to launch a stdio MCP server inside the container                                                              |
| `args`              | `string[]`               | No              | Arguments for a stdio MCP server                                                                                            |
| `env`               | `Record<string, string>` | No              | Environment variables passed to a stdio MCP server                                                                          |
| `url`               | `string`                 | Yes for `http`  | Streamable HTTP MCP endpoint URL                                                                                            |
| `bearerTokenEnvVar` | `string`                 | No              | Container env var name used for HTTP bearer auth                                                                            |
| `tools`             | `string[]`               | No              | Tool names expected to be used from this server. Claude uses this as an allowlist; Codex still connects at the server level |
| `startupTimeoutSec` | `number`                 | No              | Codex MCP startup timeout override in seconds                                                                               |

### Notes

- `mcpAccess` is only valid for agent stages. Command stages (`"command": "..."`) cannot declare it.
- `${ART_HOST_GATEWAY}` in registry values is replaced with the active container runtime's host gateway (`host.docker.internal`, `host.containers.internal`, etc.).
- For strong stage-level isolation in both Claude and Codex, prefer one registry ref per isolated server endpoint. If you need different tool subsets for different stages, expose separate MCP servers or filtered proxies with distinct `name` values.

## Dynamic Fan-out

A `dynamic-fanout` stage spawns `N` parallel **child pipelines** at runtime, one per element in a JSON payload emitted by the preceding stage. Each child runs in-process as its own isolated `PipelineRunner` — no container-in-container, no subprocess `art run`. The parent stage blocks until every child has settled.

```json
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
    { "marker": "STAGE_ERROR", "next": null, "prompt": "One or more child pipelines failed" }
  ]
}
```

### Fields

| Field             | Type                    | Required | Description                                                                                                        |
| ----------------- | ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `kind`            | `"dynamic-fanout"`      | Yes      | Must be exactly this value (cannot be inferred)                                                                    |
| `template`        | `string`                | Yes      | Path to a child pipeline JSON, relative to `__art__/`. Must stay within `__art__/`                                 |
| `inputFrom`       | `"payload"`             | Yes      | Only `"payload"` is supported. Inputs come from the preceding stage's marker payload                               |
| `substitutions`   | `{ fields: string[] }`  | No       | Allowlist of child-stage fields where `{{key}}` placeholders are substituted per child. See [Substitutions](#fan-out-substitutions) |
| `concurrency`     | `number` (int ≥ 1)      | No       | Max concurrent child pipelines. Default: unbounded                                                                 |
| `failurePolicy`   | `"all-success"`         | No       | Only `"all-success"` is supported. Any child failure makes the parent stage fail; all children still run to completion |

Agent/command fields (`prompt`, `command`, `image`, `chat`, `mcpAccess`, `hostMounts`, `devices`, `gpu`, `runAsRoot`, `privileged`, `env`, `exclusive`, `resumeSession`, `successMarker`, `errorMarker`) are **forbidden** on fanout stages. `next_dynamic` transitions are also forbidden.

### Payload from the preceding stage

The stage immediately before a fanout stage must emit a fenced-payload `STAGE_COMPLETE` whose body is a **JSON array of flat objects** (string / number / boolean values only — no nesting):

```
[STAGE_COMPLETE]
---PAYLOAD_START---
[
  { "name": "module-a", "port": 8080 },
  { "name": "module-b", "port": 8081 }
]
---PAYLOAD_END---
```

Each array element becomes the substitution context for one child pipeline.

### Fan-out substitutions

Placeholders like `{{name}}`, `{{port}}` are replaced with the matching input value. Substitution applies only to the allowed child-stage fields listed in `substitutions.fields`. Keys inside `mounts` are also substituted when `mounts` is allowed.

Allowed `substitutions.fields`: `prompt`, `prompts`, `prompt_append`, `mounts`, `hostMounts`, `env`, `image`, `command`.

Missing placeholders are left intact and a warning is logged — the child agent will see the literal `{{key}}`.

### Isolation

Each child is launched with a deterministic short `scopeId` (e.g., `fa3b7c1`). The parent and every child write to **non-overlapping** paths:

- `__art__/PIPELINE_STATE.<scopeId>.json` — child's own state file
- `__art__/logs/<scopeId>/` — child's logs
- `<DATA_DIR>/sessions/<folder>__<scopeId>__pipeline_<stageName>/` — child's session / IPC / conversations

On resume, stale child state files are deleted — children always restart from scratch. (TODO: scope-aware child resume.)

### Recursion

Nested fanout is allowed up to depth `2` (tracked via the `ART_FANOUT_DEPTH` env var set on each child process). A fanout stage at depth 3 is rejected with an error. This is a guard against runaway spawns.

### Limitations

- `failurePolicy` is currently always `"all-success"`. No partial-success collection yet.
- Parent fanout stages cannot themselves declare agent-mode fields; they are purely host-side orchestration.
- Child logs interleave into the parent's console. (Scoped log files still separate under `logs/<scopeId>/`.)

## Transitions

Transitions define how stages connect. The agent signals stage completion by emitting markers in its output.

```json
"transitions": [
  { "marker": "STAGE_COMPLETE", "next": "test", "prompt": "Work completed successfully" },
  { "marker": "STAGE_ERROR", "retry": true, "prompt": "Recoverable error occurred" },
  { "marker": "STAGE_ERROR_CODE", "next": null, "prompt": "Code-level error requiring human intervention" }
]
```

| Field    | Type             | Required | Default | Description                                                                                                |
| -------- | ---------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `marker` | `string`         | Yes      | —       | Marker name the agent emits (e.g., `"STAGE_COMPLETE"`). The agent wraps it in brackets: `[STAGE_COMPLETE]` |
| `next`   | `string \| null` | No       | `null`  | Target stage name. `null` = pipeline ends                                                                  |
| `retry`  | `boolean`        | No       | `false` | If `true`, stay in the current stage and re-send the prompt with the error description                     |
| `prompt` | `string`         | No       | —       | Description shown to the agent explaining when to use this marker                                          |

**How matching works:** The pipeline FSM scans agent output for `[MARKER_NAME]` or `[MARKER_NAME: payload]`. The first match triggers the corresponding transition.

### Built-in fallback transitions

If the container exits without emitting any marker:

- Exit code ≠ 0 → treated as a retry transition with `_CONTAINER_EXIT` marker
- Command timeout → treated as a retry transition with `_CONTAINER_TIMEOUT` marker

## Command Mode

Set the `command` field to run a shell command instead of a Claude agent:

```json
{
  "name": "lint",
  "command": "cd /workspace/project && npm run lint",
  "prompt": "",
  "mounts": { "project": "ro" },
  "transitions": [
    { "marker": "STAGE_COMPLETE", "next": "build" },
    { "marker": "STAGE_ERROR", "retry": true }
  ]
}
```

The command runs via `sh -c` inside the container. Markers are parsed from stdout — the command should `echo "[STAGE_COMPLETE]"` or `echo "[STAGE_ERROR: message]"` to signal transitions.

If the command exits with code 0 and no marker was emitted, `STAGE_COMPLETE` is inferred. Non-zero exit without a marker triggers `_COMMAND_FAILED` (retry).

## Image Registry

Stages reference images by key. The registry lives at `~/.config/aer-art/images.json`:

```json
{
  "default": { "image": "art-agent:latest", "hasAgent": true },
  "vivado": {
    "image": "vivado-agent:latest",
    "hasAgent": true,
    "baseImage": "xilinx/vivado:2024.1"
  }
}
```

In `PIPELINE.json`, set `"image": "vivado"` on a stage to use the Vivado image.

If `image` is omitted, the `"default"` registry entry is used.

## Full Example

```json
{
  "entryStage": "build",
  "stages": [
    {
      "name": "build",
      "prompt": "Read PLAN.md and implement the described changes in src/.",
      "mounts": {
        "plan": "ro",
        "src": "rw",
        "outputs": "rw",
        "project": "ro",
        "project:src/generated": "rw"
      },
      "transitions": [
        { "marker": "STAGE_COMPLETE", "next": "test" },
        { "marker": "STAGE_ERROR", "retry": true }
      ]
    },
    {
      "name": "test",
      "prompt": "Run tests against src/ and write results to outputs/.",
      "mounts": {
        "src": "ro",
        "tests": "rw",
        "outputs": "rw",
        "project": "ro"
      },
      "transitions": [
        { "marker": "STAGE_COMPLETE", "next": "review" },
        { "marker": "STAGE_ERROR", "next": "build" }
      ]
    },
    {
      "name": "review",
      "prompt": "Review the test results and write REPORT.md.",
      "mounts": {
        "src": "ro",
        "outputs": "ro",
        "memory": "rw"
      },
      "transitions": [{ "marker": "STAGE_COMPLETE", "next": null }]
    }
  ]
}
```
