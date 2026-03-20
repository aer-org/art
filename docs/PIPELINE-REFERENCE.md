# PIPELINE.json Reference

This document describes every configurable field in `__art__/PIPELINE.json`.

## Top-Level

```json
{
  "stages": [...],
  "entryStage": "build"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `stages` | `PipelineStage[]` | Yes | List of pipeline stages |
| `entryStage` | `string` | No | Name of the first stage to execute. If omitted, the first item in `stages` is used |

## Stage

```json
{
  "name": "build",
  "prompt": "Read PLAN.md and implement the described changes.",
  "image": "default",
  "command": null,
  "mounts": { "plan": "ro", "src": "rw", "project": "ro" },
  "devices": [],
  "runAsRoot": false,
  "exclusive": "vivado",
  "transitions": [...]
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | `string` | Yes | — | Unique stage identifier |
| `prompt` | `string` | Yes | — | System prompt sent to the agent. Describes what this stage should do |
| `image` | `string` | No | `"default"` | Image registry key (agent mode) or full image name (command mode). See [Image Registry](#image-registry) |
| `command` | `string` | No | `null` | If set, runs this shell command via `sh -c` instead of spawning an agent. Output markers are parsed from stdout. See [Command Mode](#command-mode) |
| `mounts` | `Record<string, "ro" \| "rw" \| null>` | Yes | — | Mount permissions for `__art__/` subdirectories and the project root. See [Mounts](#mounts) |
| `devices` | `string[]` | No | `[]` | Host devices to pass through (e.g., `"/dev/bus/usb"`) |
| `runAsRoot` | `boolean` | No | `false` | Run this stage's container as root (`--user 0:0`) |
| `exclusive` | `string` | No | — | Mutex key. Stages sharing the same key never run concurrently (e.g., `"vivado"` for stages that need exclusive access to a hardware resource) |
| `transitions` | `PipelineTransition[]` | Yes | — | How to move to the next stage based on agent output. See [Transitions](#transitions) |

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

| Value | Meaning |
|-------|---------|
| `"ro"` | Read-only — stage can read but not modify |
| `"rw"` | Read-write — stage can read and write |
| `null` | Hidden — not mounted at all, stage cannot see this directory |

Omitting a key is equivalent to `null` (hidden).

### Project sub-mounts

The `project` key sets the default permission for the entire host project root. You can override specific subdirectories with `project:<path>`:

```json
"mounts": {
  "project": "ro",
  "project:src/generated": "rw",
  "project:build": "rw",
  "project:secrets": null
}
```

This mounts the project root as read-only, but grants write access to `src/generated/` and `build/`, and completely hides `secrets/`.

**Rules:**
- Sub-mount paths are relative to the project root
- If `project` is `null` (hidden), sub-mounts cannot be enabled
- If a parent directory is `null`, child sub-mounts cannot be enabled

### How mounts map to containers

| Mount key | Container path |
|-----------|---------------|
| `plan` | `/workspace/group/plan` |
| `src` | `/workspace/group/src` |
| `outputs` | `/workspace/group/outputs` |
| `project` | `/workspace/project` |
| `project:src/foo` | `/workspace/project/src/foo` (overlay on project mount) |

The agent's working directory is `/workspace/group`.

## Transitions

Transitions define how stages connect. The agent signals stage completion by emitting markers in its output.

```json
"transitions": [
  { "marker": "STAGE_COMPLETE", "next": "test", "prompt": "Work completed successfully" },
  { "marker": "STAGE_ERROR", "retry": true, "prompt": "Recoverable error occurred" },
  { "marker": "STAGE_ERROR_CODE", "next": null, "prompt": "Code-level error requiring human intervention" }
]
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `marker` | `string` | Yes | — | Marker name the agent emits (e.g., `"STAGE_COMPLETE"`). The agent wraps it in brackets: `[STAGE_COMPLETE]` |
| `next` | `string \| null` | No | `null` | Target stage name. `null` = pipeline ends |
| `retry` | `boolean` | No | `false` | If `true`, stay in the current stage and re-send the prompt with the error description |
| `prompt` | `string` | No | — | Description shown to the agent explaining when to use this marker |

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
  "vivado": { "image": "vivado-agent:latest", "hasAgent": true, "baseImage": "xilinx/vivado:2024.1" }
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
      "transitions": [
        { "marker": "STAGE_COMPLETE", "next": null }
      ]
    }
  ]
}
```
