# AerArt Architecture Guide

A comprehensive guide to AerArt's core mechanisms for newcomers.
See `REQUIREMENTS.md` for design philosophy and `skills-as-branches.md` for skill distribution.

---

## Overview

```
art init    → creates __art__/ scaffold + PIPELINE.json + builds agent image
art compose → browser-based pipeline editor (configuration only, no execution)
art run     → executes pipeline: per-stage containers → IPC → transitions → done
```

A single Node.js process handles message routing, container spawning, IPC processing, and scheduling.

---

## 1. CLI Commands

### `art init [dir]`
- Creates `__art__/` directory structure (plan, src, logs, metrics, insights, memory, outputs, tests)
- Generates default `PIPELINE.json`: build → test → review → history (4 stages)
- Creates `CLAUDE.md` and `.gitignore`
- Prompts to build the default agent container image if missing
- Launches visual editor in init mode for onboarding

### `art compose [dir]`
- Browser-based visual pipeline editor (HTTP server + React SPA)
- Drag-and-drop stages, edit transitions/error policies, configure mounts
- Real-time agent chat for plan discussion
- Saves to `PIPELINE.json` immediately. **Does not execute the pipeline**

### `art run [dir]`
- Validates `__art__/` and `PIPELINE.json` exist
- Detects existing running pipeline → prompts to stop/restart
- Generates unique run ID, executes stages sequentially in containers
- Logs all output to `__art__/logs/`
- Cleans up manifests and containers on SIGINT/SIGTERM

### `art update`
- Rebuilds all images in the image registry via `container/build.sh`

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
  → next stage / retry / terminate
```

### Stage Markers and Transitions

Agents embed markers in their output to trigger stage transitions:

| Marker | Meaning |
|--------|---------|
| `[STAGE_COMPLETE]` | Current stage completed successfully |
| `[STAGE_ERROR: description]` | Error occurred |
| `[STAGE_ERROR_CODE: code]` | Failed with error code |

Each stage's `transitions` array defines marker → target stage mappings.
Transitions with `retry: true` stay in the same stage; others advance to the next.

### Error Debug Agent

When the same error repeats `maxConsecutive` times, a separate debug container is spawned.
The debug agent returns analysis, which is injected as coaching into the original agent for retry.

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

## 3. Stage Templates (`src/stage-templates.ts`)

Pre-defined stage types: **plan**, **build**, **test**, **review**, **history**, **deploy**

Each template provides:
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

| Runtime | Characteristics |
|---------|----------------|
| Docker | Full capabilities, default choice |
| Podman | Docker-compatible, auto-detects SELinux `:z` suffix |
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

| Runtime | Host access address |
|---------|-------------------|
| Docker | `host.docker.internal` |
| Podman | `host.containers.internal` |
| udocker | `localhost` |

---

## 5. Container Runner (`src/container-runner.ts`)

Spawns containers and configures mounts, security, and IPC.

### Mount Architecture

| Mount | Permission | Purpose |
|-------|-----------|---------|
| Project root | ro | Prevent code modification (sandbox bypass protection) |
| Group folder | rw | Agent workspace |
| `.env` → `/dev/null` | shadow | Prevent secret exposure |
| `ipc/` | rw | Per-group isolated IPC channel |
| `.claude/` | rw | Isolated Claude Code session |
| Skill files | sync | `container/skills/` → per-group `.claude/skills/` |
| Pipeline internal mounts | direct | Bypasses security validation (pipeline is trusted) |
| Additional mounts | validated | Checked against allowlist |

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

## 6. Channel System (`src/channels/`)

Uses a self-registration pattern to add channels as plugins.

### How It Works

1. Each channel file (e.g., `telegram.ts`) calls `registerChannel(name, factory)` at module load
2. `src/channels/index.ts` imports all channels → triggers registration
3. On startup, `getChannelFactory(name)` is called → returns `null` if credentials are missing (auto-skip)

Adding a new channel = write a channel file + add to barrel import. No core code changes needed.

---

## 7. IPC System (`src/ipc.ts`)

Filesystem-based host-container communication. Containers write JSON files; the host polls (500ms) and processes them.

### Namespace

`~/.aer-art/data/ipc/{group_folder}/{messages,tasks}/` — isolated per group

### Supported Commands

| Type | Function | Authorization |
|------|----------|---------------|
| `message` | Send message to a chat | main → any, others → own group only |
| `schedule_task` | Schedule a task | others → own group, main → any |
| `spawn_agent` | Spawn a sub-agent | all groups |
| `register_group` | Register a new group | main only |
| `report_issue` / `resolve_issue` | Pipeline issue tracking | per-group isolated |

Processed files are deleted. Errors are moved to `ipc/errors/`.

---

## 8. Image Registry (`src/image-registry.ts`)

Stores image key → spec mappings in `~/.config/aer-art/images.json`.

```json
{
  "default": { "image": "aer-art-agent:latest", "hasAgent": true },
  "vivado": { "image": "vivado-agent:latest", "hasAgent": true, "baseImage": "xilinx/vivado:2024.1" }
}
```

- Stage specifies `image: "vivado"` → resolved from registry
- No image specified → falls back to `default` → `CONTAINER_IMAGE`
- CRUD available via dashboard; presets provided (Ubuntu, NVIDIA CUDA, Python, Node, ROS, etc.)

---

## 9. Team Editor / Dashboard (`team-editor/`)

ReactFlow-based React SPA. Served by `art compose`.

### Features

- **Visual pipeline editing** — drag-and-drop stage nodes, connect transitions (success/error/retry)
- **Stage properties** — prompt, mounts (rw/ro/null), commands, image, error policy
- **Image management** — registry CRUD + preset selection
- **Run history** — view past runs, read logs, start/stop current run
- **Agent chat** (init mode) — real-time conversation with a project analysis agent
- **File management** — edit files under `__art__/`
- **Diff review** — hunk-based diff view with AI edit suggestions

### API Endpoints (compose.ts)

| Endpoint | Function |
|----------|----------|
| `GET/POST /api/pipeline` | Get/save pipeline JSON |
| `POST /api/chat/message` | Send message to agent |
| `GET /api/chat/stream` | SSE agent output stream |
| `GET/POST /api/runs/*` | Run list/start/stop/stream/log |
| `GET/POST/DELETE /api/images` | Image registry CRUD |
| `GET /api/dirs` | `__art__/` directory structure |
| `GET/POST /api/file` | Read/write files (path traversal protected) |

---

## 10. Remote Control (`src/remote-control.ts`)

Allows container agents to spawn a host-level Claude Code session.

1. Container sends `remote_control_start` via IPC
2. Host spawns a detached `claude remote-control` process
3. Extracts `https://claude.ai/code*` URL from stdout (30s timeout)
4. Saves URL to `~/.aer-art/data/remote-control.json`, returns to agent
5. Only one active session at a time. On host restart, PID is checked and restored

---

## File Map

| File | Role |
|------|------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/pipeline-runner.ts` | Pipeline FSM, run manifest, stage execution |
| `src/container-runner.ts` | Container spawning, mount/security configuration |
| `src/container-runtime.ts` | Runtime abstraction (Docker/Podman/udocker) |
| `src/credential-proxy.ts` | API credential proxy |
| `src/image-registry.ts` | Image registry CRUD |
| `src/stage-templates.ts` | Stage prompt templates |
| `src/channels/registry.ts` | Channel self-registration |
| `src/ipc.ts` | Filesystem-based IPC |
| `src/remote-control.ts` | Host-level Claude Code remote access |
| `src/cli/init.ts` | `art init` command |
| `src/cli/compose.ts` | `art compose` editor server |
| `src/cli/run.ts` | `art run` pipeline execution |
| `src/cli/auth.ts` | Auth token management |
| `team-editor/` | React-based pipeline editor SPA |
| `container/build.sh` | Agent container image build |
| `install.sh` | One-line CLI installation script |
