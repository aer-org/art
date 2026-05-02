# ART Requirements

Design decisions and philosophy behind ART (Agent Runtime).

---

## Why This Exists

ART exists because agent workflows need structure. Running a single long agent session produces unpredictable results — the agent drifts, context rots, and there's no way to inspect or retry individual steps. ART breaks agent work into controlled stages with explicit boundaries, permissions, and checkpoints.

---

## Philosophy

### Small Enough to Understand

The entire codebase should be something you can read and understand. One Node.js process. A handful of source files. No microservices, no message queues, no abstraction layers.

### Security Through True Isolation

Instead of application-level permission systems trying to prevent agents from accessing things, agents run in actual Linux containers. The isolation is at the OS level. Agents can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

### Plan First, Then Execute

`art init` creates a minimal scaffold, and `art run` executes the authored pipeline. Each stage gets only the permissions it needs.

### Customization = Code Changes

No configuration sprawl. If you want different behavior, modify the code. The codebase is small enough that this is safe and practical. Pipeline structure is configured via `PIPELINE.json`; everything else — just change the code to do what you want.

### AI-Native Development

The codebase assumes you have an AI collaborator. It doesn't need to be excessively self-documenting or self-debugging because Claude is always there.

---

## Core Components

### Pipeline Orchestration

A host-side FSM orchestrates multi-stage container execution. Each stage runs in its own isolated container with independent mounts and permissions. Stages communicate via output markers (`[STAGE_COMPLETE]`, `[STAGE_ERROR]`), and transitions are defined per-stage in `PIPELINE.json`. See `ARCHITECTURE.md` for the full pipeline mechanism and `PIPELINE-REFERENCE.md` for the complete field reference.

### Claude Agent SDK

The core agent runtime. Agents run inside containers via the Claude Agent SDK, communicating through IPC. The SDK spawns CLI subprocesses for tool execution, API calls, and subagent coordination.

### Container Isolation

All agents execute in containers (Docker or Podman). The runtime is auto-detected and abstracted — code branches on capability flags, not runtime names. See `SECURITY.md` for the full security model.

### File-Level Mount Permissions

Each stage declares mount policies for `__art__/` subdirectories and the host project root. The `project` key controls the project root default, and `project:<path>` overrides specific subdirectories — giving file-level control over what agents can access.

### Image Registry

`~/.config/aer-art/images.json` maps keys to container image specs. Stages reference images by key. Presets available for common base images (Ubuntu, NVIDIA CUDA, Python, Node, ROS). The visual editor provides CRUD UI.

### Credential Proxy

Containers never see real API keys. A host-side HTTP proxy intercepts all Anthropic API calls and injects real credentials. Supports both API key and OAuth token modes. See `SECURITY.md` for details.

---

## Architecture Decisions

### Two CLI Commands

- `art init <path>` — Create `__art__/` if needed and write an empty `PIPELINE.json`.
- `art run <path>` — Executes the pipeline. Each stage runs sequentially in its own container. Completed stages are checkpointed for resume on interrupt.

### Stage Modes

- **Agent mode** (default): Claude agent receives a prompt and works autonomously
- **Command mode**: Runs shell commands via `sh -c`, parses markers from stdout. Useful for deterministic steps like linting, building, or running test suites.

### Resume on Interrupt

Completed stages are checkpointed in a run manifest. On restart, execution resumes from the next incomplete stage with previous context injected. Run history is stored as JSON manifests in `__art__/runs/`.

### Session Persistence

Each group maintains isolated Claude sessions in `data/sessions/{group}/.claude/`. Sessions persist between container restarts, enabling multi-turn conversations within a stage.

### Exclusive Stage Locks

Stages can declare an `exclusive` key. Stages sharing the same key never run concurrently — a mutex ensures sequential access. Useful for hardware resources like FPGA programming tools.

---

## CLI Commands

| Command | Purpose |
|---------|---------|
| `art init [dir]` | Create scaffold and empty pipeline file |
| `art run [dir]` | Execute pipeline — sequential stage containers |

### Authentication

- Token resolution: env vars → `.env` → saved token → Claude CLI credentials
- Validated with live API call before starting

---

## Setup

### npm (recommended)

```bash
npm install -g @aer-org/art
```

### One-Line Install

```bash
curl -fsSL https://raw.githubusercontent.com/aer-org/art/main/install.sh | bash
```

Installs to `~/.art`, creates `art` symlink, requires Node.js ≥ 20.

### Skills

- `/setup` — Install dependencies, configure container runtime, Claude authentication
- `/debug` — Container issues, logs, troubleshooting
- `/update-aer-art` — Pull upstream changes, merge with customizations

---

## Project Name

**ART** — Agent Runtime.
