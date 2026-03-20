# Automated Research Team (ART)

```bash
npm install -g @aer-org/art
```

```bash
cd my-project
art compose .                 # Initialize (if needed) and open pipeline editor
art run .                     # Execute pipeline in Docker-isolated containers
```

Requires **Node.js ≥ 20**, **Docker** (or Podman/udocker), and **Git**.

---

## What is ART?

A TypeScript CLI **pipeline engine** that runs multi-stage agent workflows on existing project directories. ART reads a `PIPELINE.json` defining stages, transitions, mounts, and execution order, then orchestrates those stages in container-isolated environments.

The **default pipeline template** ships a 4-stage loop (build → test → review → history), but ART has no hardcoded knowledge of specific stages — it knows stages, transitions, mounts, and markers. Any pipeline can be designed via `art compose`.

> **Agent philosophy**:
> Agents are not tools but delegated operators with identity, memory, and doctrine. Each stage has a SOUL-based system prompt defining its personality and principles.
> "상태 보고는 가치가 없다" — status reports are worthless, only artifacts count.
> "실행 증거 없는 약속은 0점" — promises without execution evidence score zero.

---

## Default Pipeline — 4-Stage Loop

```
    ┌──────────┐
    │  BUILD   │ ← reads PLAN.md, writes code to src/
    └────┬─────┘
         │ [STAGE_COMPLETE]
         ▼
    ┌──────────┐
    │   TEST   │ ← runs adversarial tests against src/
    └────┬─────┘
         │ [STAGE_COMPLETE]
         ▼
    ┌──────────┐
    │  REVIEW  │ ← examines outputs, writes REPORT.md
    └────┬─────┘
         │ [STAGE_COMPLETE]
         ▼
    ┌──────────┐
    │ HISTORY  │ ← distills insights into MEMORY.md
    └──────────┘
```

On error, stages can retry (with debug agent coaching) or transition to error-handling stages. The pipeline FSM handles all routing based on output markers.

### Permission Enforcement via Mounts

Permissions are enforced by **container mounts** — hidden directories are not mounted, so agents physically cannot access them. Each stage template declares its own rw/ro/hidden policy.

---

## Installation

### npm (recommended)

```bash
npm install -g @aer-org/art
```

### One-Line Install

```bash
curl -fsSL https://raw.githubusercontent.com/aer-org/art/main/install.sh | bash
```

Clones to `~/.art`, creates `art` CLI symlink, checks for Node.js ≥ 20 and Git.

### Manual Install

```bash
git clone https://github.com/aer-org/art.git ~/.art
cd ~/.art && npm install && npm run build
ln -s ~/.art/dist/cli/index.js ~/.local/bin/art
```

---

## CLI Reference

```bash
art compose <path>           # Initialize (if needed) and open visual pipeline editor
art run <path>               # Execute pipeline — sequential stage containers
art update                   # Rebuild all images in the registry
```

---

## Pipeline System

### How Stages Work

Each stage runs in its own isolated container. Stages communicate via **output markers** embedded in agent output:

| Marker | Effect |
|--------|--------|
| `[STAGE_COMPLETE]` | Transition to next stage |
| `[STAGE_ERROR: msg]` | Trigger error transition or retry |

Transitions are defined per-stage in `PIPELINE.json`. Retry transitions stay in the same stage; non-retry transitions advance.

### Stage Modes

- **Agent mode** (default): Claude agent receives a prompt and executes autonomously
- **Command mode**: Runs shell commands via `sh -c`, parses markers from stdout

### Error Recovery

When the same error repeats `maxConsecutive` times, a **debug agent** is spawned in a separate container to analyze the failure. Its advice is injected into the original agent for retry.

### Resume on Interrupt

Completed stages are checkpointed. On restart, execution resumes from the next incomplete stage with previous context injected.

### Run Tracking

Each execution records a manifest JSON with per-stage status, duration, and log file path. The dashboard shows run history and allows starting/stopping runs.

---

## Container Runtime

ART auto-detects the available container runtime:

| Runtime | Characteristics |
|---------|----------------|
| **Docker** | Full capabilities, default choice |
| **Podman** | Docker-compatible, SELinux support |
| **udocker** | No daemon required, no image building (downloads pre-built tars) |

Runtime-specific behavior is abstracted via a capabilities system — code branches on `rt.capabilities.X`, not runtime names.

### Security

- **Project root mounted read-only** — agents cannot modify host code
- **`.env` shadowed with `/dev/null`** — secrets never exposed
- **Credential proxy** — containers never see real API keys; a host-side proxy injects credentials
- **Per-group IPC isolation** — groups cannot access each other's communication channels
- **Mount allowlist** — additional mounts validated against external allowlist

See `docs/SECURITY.md` for the full security model.

---

## Visual Pipeline Editor

`art compose` launches a browser-based React SPA (ReactFlow) for visual pipeline design:

- Drag-and-drop stage nodes with transition edges
- Configure per-stage: prompt, mounts (rw/ro/hidden), image, error policy
- Image registry management with preset base images
- Run history panel with log viewer
- Agent chat interface for plan discussion (init mode)
- Hunk-based diff review with AI edit suggestions

---

## Image Registry

Custom container images are managed via `~/.config/aer-art/images.json`:

```json
{
  "default": { "image": "aer-art-agent:latest", "hasAgent": true },
  "vivado": { "image": "vivado-agent:latest", "hasAgent": true, "baseImage": "xilinx/vivado:2024.1" }
}
```

Stages reference images by key. Presets available: Ubuntu, NVIDIA CUDA, Python, Node, ROS, and custom.

---

## Project Directory Layout

```
my-project/                         # Your existing project (read-only to agents)
├── src/, data/, ...
│
├── __art__/                        # All ART artifacts
│   ├── PIPELINE.json               # Active pipeline definition
│   ├── CLAUDE.md                   # Project context for agents
│   ├── plan/                       # PLAN.md, VISION.md
│   ├── src/                        # Agent-written code
│   ├── tests/                      # Test files
│   ├── outputs/                    # Run outputs
│   ├── logs/                       # Pipeline logs
│   ├── metrics/                    # Metrics data
│   ├── insights/                   # Accumulated insights
│   ├── memory/                     # Structured memory
│   └── runs/                       # Run manifests (_current.json, run-*.json)
└── .git/
```

---

## Documentation

| Document | Content |
|----------|---------|
| `docs/ARCHITECTURE.md` | Full system architecture — pipeline FSM, container runtime, IPC, channels |
| `docs/REQUIREMENTS.md` | Design philosophy and decisions |
| `docs/SECURITY.md` | Security model — trust boundaries, mount isolation, credential proxy |
| `docs/skills-as-branches.md` | How skills are distributed and installed via git branches |
| `docs/docker-sandboxes.md` | Running ART inside Docker Sandboxes (nested isolation) |
| `docs/APPLE-CONTAINER-NETWORKING.md` | Apple Container networking setup (macOS 26) |
| `docs/SDK_DEEP_DIVE.md` | Claude Agent SDK internals |

---

## Development

```bash
git clone https://github.com/aer-org/art.git
cd art
npm install
npm run build        # Compile TypeScript
npm run dev          # Watch mode
./container/build.sh # Rebuild agent container
```

---

## License

**AGPL-3.0** — Commercial license available.
