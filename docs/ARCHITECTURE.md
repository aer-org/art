# AerArt Architecture Guide

A comprehensive guide to AerArt's core mechanisms for newcomers.
See `REQUIREMENTS.md` for design philosophy and `PIPELINE-REFERENCE.md` for pipeline JSON schema.

---

## Overview

```
art init → creates __art__/ scaffold + PIPELINE.json
art run  → executes pipeline: per-stage containers → markers → transitions → done
```

A single Node.js process handles container spawning, output streaming, marker parsing, and stage transitions.

---

## 1. CLI Commands

### `art init [dir]`

- Creates `__art__/` directory structure (plan, src, logs, metrics, insights, memory, outputs, tests)
- Generates default `PIPELINE.json`: build → test → review → history (4 stages)
- Creates `.gitignore`
- Does not start agents or open a browser

### `art run [dir]`

- Validates `__art__/` and `PIPELINE.json` exist
- Detects existing running pipeline → prompts to stop/restart
- Generates unique run ID, executes stages sequentially in containers
- Logs all output to `__art__/logs/`
- Cleans up manifests and containers on SIGINT/SIGTERM

### Authentication (`src/cli/auth.ts`)

- Token resolution order: env vars → `.env` file → saved token → Claude CLI credentials
- Validates token with a live Anthropic API call (`/v1/messages`, max_tokens=1) before starting

---

## 2. Pipeline System (`src/pipeline-runner.ts`)

A host-side FSM (Finite State Machine) that orchestrates multi-stage container execution.

### Execution Flow

```
Load PIPELINE.json → determine entry stage
  → spawn stage container → deliver prompt via IPC
  → stream agent output → parse markers → decide transition
  → next stage / terminate
```

### Stage Markers and Transitions

Agents embed markers in their output to trigger stage transitions:

| Marker                       | Meaning                              |
| ---------------------------- | ------------------------------------ |
| `[STAGE_COMPLETE]`           | Current stage completed successfully |
| `[STAGE_ERROR: description]` | Error occurred                       |
| `[STAGE_ERROR_CODE: code]`   | Failed with error code               |

Each stage's `transitions` array defines marker → target stage mappings.
Transitions advance to another stage or end the current scope. If no marker matches, the runner sends feedback and keeps the current container session active.

### Agent Mode vs Command Mode

- **Agent mode**: Claude agent receives a prompt and executes (default)
- **Command mode**: Runs shell commands via `sh -c`, parses markers from stdout

### Resume on Interrupt

When a pipeline is interrupted, the list of completed stages is persisted.
On restart, execution resumes from the next incomplete stage with previous stage context injected.

### Exclusive Lock

Stages declaring an `exclusive` key get serialized access to that resource
(e.g., FPGA board, Vivado memory — physical resource constraints).

### Run Manifest

Each execution records a manifest JSON in the `runs/` directory:

- `_current.json`: PID, runId, and start time of the currently running pipeline
- `run-{id}.json`: full record per run (per-stage status, duration, log file path)

Stale PIDs are detected and orphan cleanup runs automatically.

---

## 3. Default Scaffold Stages (`src/cli/default-stage-presets.ts`)

`art init` seeds a default 4-stage scaffold: **build**, **test**, **review**, **history**

Each preset provides:

- SOUL-based system prompt (role, behavior rules, output format)
- Mount policy (which directories are rw/ro/null)
- Default transition markers

Overridable per-project via `PIPELINE.json`.

Default 4-stage pipeline:

1. **build** — reads PLAN.md, writes code to src/
2. **test** — runs adversarial tests against src/
3. **review** — examines outputs, writes REPORT.md
4. **history** — distills insights into MEMORY.md

---

## 4. Container Runtime (`src/container-runtime.ts`)

Runtime abstraction layer that auto-detects and normalizes Docker, Podman, and udocker.

### Runtime Selection

Priority: `CONTAINER_RUNTIME` env var → saved choice (`~/.config/aer-art/runtime.json`) → auto-detect + confirm

| Runtime | Characteristics                                               |
| ------- | ------------------------------------------------------------- |
| Docker  | Full capabilities, default choice                             |
| Podman  | Docker-compatible, auto-detects SELinux `:z` suffix           |
| udocker | No daemon required, Fakechroot (F1) mode, cannot build images |

### Runtime Capabilities

Each runtime declares supported features via a capabilities struct:

- `supportsAutoRemove` (`--rm`)
- `supportsNaming` (`--name`)
- `supportsDevicePassthrough` (`--device`)
- `supportsUserMapping` (`--user`)
- `supportsPsFilter` (`ps --filter`)
- etc.

Code branches on `rt.capabilities.X` — no per-runtime hardcoding.

### Image Management

- Docker/Podman: local builds via `container/build.sh`
- udocker: downloads tar from GitHub Releases, loads it, runs in F1 mode

### Host Gateway

| Runtime | Host access address        |
| ------- | -------------------------- |
| Docker  | `host.docker.internal`     |
| Podman  | `host.containers.internal` |
| udocker | `localhost`                |

---

## 5. Container Runner (`src/container-runner.ts`)

Spawns containers and configures mounts, security, and IPC.

### Mount Architecture

| Mount                     | Permission | Purpose                                                    |
| ------------------------- | ---------- | ---------------------------------------------------------- |
| Project root              | ro         | Prevent code modification (sandbox bypass protection)      |
| `__art__/` subdirectories | per-stage  | rw/ro/null per scaffold preset or authored `PIPELINE.json` |
| `.env` → `/dev/null`      | shadow     | Prevent secret exposure                                    |
| `.claude/`                | rw         | Isolated Claude Code session                               |
| Skill files               | sync       | `container/skills/` → `.claude/skills/`                    |
| Pipeline internal mounts  | direct     | Bypasses security validation (pipeline is trusted)         |
| Additional mounts         | validated  | Checked against allowlist                                  |

### Credential Proxy (`src/credential-proxy.ts`)

Containers never see real API keys. All API calls go through a host-side proxy.

**API Key mode**: Proxy injects the real key on every request.
**OAuth mode**: Proxy exchanges OAuth token for a temporary API key; subsequent requests use the temp key.

### Output Streaming

Parsed in real-time via `OUTPUT_START_MARKER` / `OUTPUT_END_MARKER` pairs.
Each marker triggers a callback; the pipeline FSM detects stage transition markers from the stream.

### Idle Timeout

Timeout resets on streaming output. Applies the longer of hard deadline or `IDLE_TIMEOUT`.
On timeout: `--stop` (15s grace period → SIGKILL).

### Run ID Labeling

Each container gets an `art-run-id={runId}` label.
On abnormal termination, orphan containers are bulk-cleaned by label (`cleanupRunContainers`).

---

## 6. Image Registry (`src/image-registry.ts`)

Stores image key → spec mappings in `~/.config/aer-art/images.json`.

```json
{
  "default": { "image": "aer-art-agent:latest", "hasAgent": true },
  "vivado": {
    "image": "vivado-agent:latest",
    "hasAgent": true,
    "baseImage": "xilinx/vivado:2024.1"
  }
}
```

- Stage specifies `image: "vivado"` → resolved from registry
- No image specified → falls back to `default` → `CONTAINER_IMAGE`
- Registry entries can be edited directly in the config file; presets are documented for common base images (Ubuntu, NVIDIA CUDA, Python, Node, ROS, etc.)

---

## File Map

| File                               | Role                                             |
| ---------------------------------- | ------------------------------------------------ |
| `src/run-engine.ts`                | Minimal pipeline execution engine for `art run`  |
| `src/pipeline-runner.ts`           | Pipeline FSM, run manifest, stage execution      |
| `src/container-runner.ts`          | Container spawning, mount/security configuration |
| `src/container-runtime.ts`         | Runtime abstraction (Docker/Podman/udocker)      |
| `src/credential-proxy.ts`          | API credential proxy                             |
| `src/image-registry.ts`            | Image registry CRUD                              |
| `src/cli/default-stage-presets.ts` | Default `art init` scaffold stage presets        |
| `src/mount-security.ts`            | Mount allowlist and blocked-pattern enforcement  |
| `src/group-folder.ts`              | Workspace path resolution and traversal defense  |
| `src/config.ts`                    | Paths, intervals, image registry path            |
| `src/env.ts`                       | Environment variable handling                    |
| `src/logger.ts`                    | Logging utilities                                |
| `src/types.ts`                     | Shared TypeScript types                          |
| `src/cli/index.ts`                 | CLI entry point and command registration         |
| `src/cli/init.ts`                  | `art init` command                               |
| `src/cli/run.ts`                   | `art run` pipeline execution                     |
| `src/cli/auth.ts`                  | Auth token management                            |
| `container/build.sh`               | Agent container image build                      |
| `install.sh`                       | One-line CLI installation script                 |
