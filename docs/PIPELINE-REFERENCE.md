# PIPELINE.json Reference

This document describes every configurable field in `__art__/PIPELINE.json`.

> **Breaking schema change (stitch):** `kind: "dynamic-fanout"`, transition `retry`, transition `next_dynamic`, and `fan_in: "dynamic"` are removed. Transitions are now `{ marker?, next, template?, count?, joinPolicy?, afterTimeout? }`. `next` is always required and names the downstream node in the current scope (or `null` to end the current scope). `marker` is required unless `afterTimeout: true`. If `template` is present, the template is spawned first and then returns to `next`. Pipelines must be acyclic DAGs. Legacy `PIPELINE_STATE.*.json` files are not supported — delete to reset.

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
  "timeout": null,
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
| `kind`        | `"agent" \| "command"`                 | No       | inferred    | Explicit stage kind. If omitted, inferred: `command` when `command` is set, else `agent`.                                                          |
| `prompt`      | `string`                               | Yes      | —           | System prompt sent to the agent. Describes what this stage should do                                                                               |
| `image`       | `string`                               | No       | `"default"` | Image registry key (agent mode) or full image name (command mode). See [Image Registry](#image-registry)                                           |
| `command`     | `string`                               | No       | `null`      | If set, runs this shell command via `sh -c` instead of spawning an agent. Output markers are parsed from stdout. See [Command Mode](#command-mode) |
| `timeout`     | `number`                               | No       | inherited   | Command mode only. Maximum runtime in milliseconds before the command is terminated. Overrides the group/container timeout for this stage.         |
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

| Mount key              | Container path                                                 |
| ---------------------- | -------------------------------------------------------------- |
| `plan`                 | `/workspace/plan`                                              |
| `src`                  | `/workspace/src`                                               |
| `outputs`              | `/workspace/outputs`                                           |
| `project`              | `/workspace/project`                                           |
| `project:src/foo`      | `/workspace/project/src/foo` (overlay on project mount)        |
| `results:draft`        | `/workspace/results/draft` (override nested under `results`)   |
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
    { "marker": "STAGE_ERROR", "next": null }
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

## Templates & Stitch

A **template** is a reusable sub-graph stored at `__art__/templates/<name>.json`. When a transition carries `template: "<name>"`, the template is **stitched** into the running pipeline at runtime: its stages are cloned with unique names and inserted downstream of the host stage. The host's transition is rewritten to point at the renamed entry stage of the template.

### Template file

```jsonc
// __art__/templates/experiment.json
{
  "entry": "build",               // optional; defaults to stages[0].name
  "stages": [
    { "name": "build",   "prompt": "...", "mounts": {...}, "transitions": [{ "marker": "OK", "next": "test" }] },
    { "name": "test",    "command": "...", "transitions": [{ "marker": "OK", "next": "review" }] },
    { "name": "review",  "prompt": "...", "mounts": {...}, "transitions": [
      { "marker": "STAGE_DONE", "next": null },
      { "marker": "STAGE_KEEP", "template": "experiment", "next": null }   // re-stitch self at runtime, then end this scope
    ] }
  ]
}
```

Inside a template, `next` is scope-local — it must name a stage defined in the same template file (cycles are rejected), or be `null` to end the current template invocation. To hand control off to another template or re-stitch the current one, add `template: "<name>"`; the spawned template returns to this transition's `next`. Cross-template node references via `next` are rejected at load time — `template` is the only way to cross a template boundary.

### Transition forms

```jsonc
{ "marker": "OK",  "next": "finalize" }                        // → stage in this scope
{ "marker": "OK",  "next": null }                              // → end this scope
{ "marker": "OK",  "template": "experiment", "next": null }    // → stitch template once, then end this scope
{ "marker": "OK",  "template": "lane", "next": "finalize", "count": 4 } // → stitch 4× in parallel, join, then continue
{ "marker": "PLAN_READY", "template": "per_id",
  "next": null, "countFrom": "payload", "substitutionsFrom": "payload" } // → payload-driven fanout
```

`next` is always required. `count` requires `template`. Stitch always synthesizes a **join** stage (stage name `<origin>__<template>__join`). Every spawned template copy returns to that join when it reaches `next: null`; the join then evaluates `joinPolicy` and either continues to `next` or ends the pipeline with an error. Omitting `count` (or setting `count: 1`) performs a single stitch.

### Payload-driven fanout

When lane count isn't known at authoring time, use `countFrom: "payload"`. The preceding agent emits a fenced JSON array; the runtime uses its length as the lane count, and (if `substitutionsFrom: "payload"` is also set) feeds each element's fields as per-lane substitutions.

```
[PLAN_READY]
---PAYLOAD_START---
[
  { "id": "alpha", "kind": "stimulus" },
  { "id": "beta",  "kind": "monitor"  },
  { "id": "gamma", "kind": "probe"    }
]
---PAYLOAD_END---
```

With the transition above plus this payload, the runtime clones `per_id` three times and substitutes `{{id}}` / `{{kind}}` per lane inside every substitution-eligible field (`prompt`, `mounts`, `env`, `transitions`, etc.). Length-1 payloads collapse to a single stitch with a 1-copy join.

Rules:

- `countFrom` accepts only `"payload"`. Mutually exclusive with `count`.
- `substitutionsFrom` accepts only `"payload"`, and requires `countFrom: "payload"`.
- Payload must be a JSON array of flat objects whose values are strings, numbers, or booleans.
- Elements may not use reserved keys `index` or `insertId` — those are injected by stitch and would collide with the per-lane metadata (`{{index}}` / `{{insertId}}` remain available alongside payload fields).
- Missing / unparseable / empty-array / invalid-element payload → stitch fails and the transition resolves as `STAGE_ERROR`.

### Unresolved placeholder check

After substitution applies, stitch scans every substitution-eligible field of every cloned stage for leftover `{{X}}` patterns. Any match is a contract violation — the template referenced a key the substitution map did not provide — and stitch fails immediately with a descriptive error.

Common triggers:

- Template typo: `{{tpye}}` instead of `{{kind}}`.
- Payload missing a key the template expects.
- Key mismatch: template uses `{{id}}` but payload emits `{{identifier}}`.

This catches configuration drift at stitch time, before any stitched agent receives a broken prompt. `{{index}}` and `{{insertId}}` are always injected by stitch core, so they never trigger the check.

### Stitched stage naming

Inserted stages get deterministic user-visible names:

- Single stitch: `{origin}__{template}0__{templateStage}`
- Parallel stitch lane `i`: `{origin}__{template}{i}__{templateStage}`
- Join stage: `{origin}__{template}__join`

Names appear in logs, the `insertedStages` section of `PIPELINE_STATE.json`, and container names (`pipeline-<name>`).

### Substitutions

Template fields get `{{insertId}}` and `{{index}}` substitution at stitch-time, applied to `prompt`, `prompts`, `prompt_append`, `mounts`, `hostMounts`, `env`, `image`, `command`, `successMarker`, `errorMarker`.

- `{{insertId}}` — unique per inserted copy (e.g., `review__revert-tpl0`)
- `{{index}}` — lane index in parallel stitch (0..N-1). `0` for single stitch.

Missing placeholders pass through unchanged.

### DAG invariant

Every stitch re-validates the full pipeline graph for acyclicity. Because inserted stages are uniquely renamed and only point at each other (or at forward references), stitch can grow the DAG indefinitely without introducing cycles — which is the intended pattern for "loops":

```
review → STAGE_KEEP → stitch experiment template again → new review → …
```

### Resume

Stitched stages are persisted in `PIPELINE_STATE.<...>.json` under `insertedStages`. On resume, they are merged back into the base config before execution continues.

## Transitions

Transitions define how stages connect. The agent signals stage completion by emitting markers in its output.

```json
"transitions": [
  { "marker": "STAGE_COMPLETE", "next": "test", "prompt": "Work completed successfully" },
  { "marker": "STAGE_PANIC",    "next": null,   "prompt": "Unrecoverable error — end pipeline" },
  { "marker": "STAGE_CLEANUP",  "template": "cleanup-template", "next": null, "prompt": "Stitch cleanup template" },
  { "afterTimeout": true, "next": "cleanup", "prompt": "Run only if a command stage times out" }
]
```

`next` must always be present. `template` is optional; when present, the transition means "spawn this template, then continue to `next`".

| Field               | Type                                              | Required | Default         | Description                                                                                                                                   |
| ------------------- | ------------------------------------------------- | -------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `marker`            | `string`                                          | Usually  | —               | Marker name the agent emits (e.g., `"STAGE_COMPLETE"`). Required unless `afterTimeout: true`. Agent wraps it in brackets: `[STAGE_COMPLETE]`. |
| `next`              | `string \| null`                                  | Yes      | —               | Scope-local stage name, or `null` to end the current scope. Inside a template, must name a stage in the same template.                        |
| `template`          | `string`                                          | No       | —               | Template name to stitch at runtime. When present, the spawned template returns to `next`.                                                     |
| `count`             | `number` (≥1)                                     | No       | `1`             | Valid only with `template`. Inserts `N` lane copies + join (parallel stitch). Mutually exclusive with `countFrom`.                            |
| `countFrom`         | `"payload"`                                       | No       | —               | Derive lane count from the marker payload's JSON array length. Requires `template`.                                                           |
| `substitutionsFrom` | `"payload"`                                       | No       | —               | Per-lane substitution map comes from `payload[i]` fields. Requires `countFrom: "payload"`.                                                    |
| `joinPolicy`        | `"all_success" \| "any_success" \| "all_settled"` | No       | `"all_success"` | Valid only with `template`. Controls whether the synthesized join continues to `next`.                                                        |
| `outcome`           | `"success" \| "error"`                            | No       | inferred        | Optional explicit outcome classification for the transition. If omitted, markers containing `ERROR` are treated as errors.                    |
| `afterTimeout`      | `boolean`                                         | No       | `false`         | Command mode only. When `true`, this transition fires only after the command is killed because its timeout elapsed.                           |
| `prompt`            | `string`                                          | No       | —               | Description shown to the agent explaining when to use this marker.                                                                            |

**How matching works:** The FSM scans agent output for `[MARKER_NAME]` or `[MARKER_NAME: payload]`. The first transition whose marker matches fires. If no transition matches, the runner sends a retry hint and keeps the container running. Parse-miss retry is unlimited (agents get to try again with feedback). `afterTimeout: true` transitions are not marker-matched; they are only considered when a command stage times out.

### Built-in container-crash markers

If the container dies without emitting a user marker:

- Exit code ≠ 0 → synthetic `_CONTAINER_EXIT` marker triggers container respawn (up to `MAX_CONTAINER_RESPAWNS = 3`)
- Uncaught error → synthetic `_CONTAINER_ERROR` marker triggers respawn

These are the only respawn paths. There is no user-authored retry — use templates to express recovery flows.

## Command Mode

Set the `command` field to run a shell command instead of a Claude agent:

```json
{
  "name": "lint",
  "command": "cd /workspace/project && npm run lint",
  "timeout": 600000,
  "prompt": "",
  "mounts": { "project": "ro" },
  "transitions": [
    { "marker": "STAGE_COMPLETE", "next": "build" },
    { "marker": "STAGE_ERROR", "next": null },
    { "afterTimeout": true, "next": "cleanup" }
  ]
}
```

The command runs via `sh -c` inside the container. Markers are parsed from stdout — the command should `echo "[STAGE_COMPLETE]"` or `echo "[STAGE_ERROR: message]"` to signal transitions.

If the command exits with code 0 and no marker was emitted, `STAGE_COMPLETE` is inferred. Non-zero exit without a marker resolves the `STAGE_ERROR` transition (or falls back to a synthetic terminal `STAGE_ERROR` transition if none is authored).

If `timeout` elapses, ART sends `SIGTERM`, then `SIGKILL` 15 seconds later if needed. When an authored `afterTimeout: true` transition exists, that transition fires instead of the normal `STAGE_ERROR` path. Only one `afterTimeout` transition is allowed per stage, and it cannot declare a `marker`.

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
        { "marker": "STAGE_ERROR", "next": null }
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
