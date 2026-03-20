# ART — Agent Runtime

Run agent workflows against real projects with **stage boundaries**, **isolated mounts**, and **resumable execution**.

Design a plan collaboratively with an AI agent via `art compose`, then execute it with `art run` — a pipeline runtime where **the plan is read-only by default** (unless you explicitly grant write access). Each stage runs in its own container with file-level mount permissions on your project.

> Adaptive planning (stages that can revise the plan mid-run) is coming soon.

```bash
npm install -g @aer-org/art
```

```bash
cd my-project
art compose .       # Open visual pipeline editor (creates __art__/ if needed)
art run .           # Execute pipeline in isolated containers
```

Requires **Node.js ≥ 20** and **Docker** (or Podman).

---

## When to use ART

- You want **repeatable agent workflows**, not one-off chat sessions
- You want **strict stage boundaries** — each stage sees only what it needs (rw/ro/hidden)
- You want agents to write into a **controlled artifact space**, not directly into your repo
- You want **resumable runs** and per-stage logs you can inspect after the fact

---

## 30-Second Walkthrough

```bash
cd my-project
art compose .
```

This creates `__art__/` in your project and opens a browser-based pipeline editor with an agent chat. Use the chat to collaboratively write your plan — once finalized, the plan becomes the contract that stages execute against.

The default template has 4 stages (plan → build → test → review), but you can design any pipeline. When the plan is ready:

```bash
art run .
```

Each stage runs a Claude agent in a Docker container with file-level mount permissions — your project is read-only by default, but specific files or directories can be granted write access per stage. Artifacts go into `__art__/src/`, `__art__/outputs/`, etc.

```
my-project/                         # Your project (mount permissions per stage)
├── src/, data/, ...
│
└── __art__/                        # All ART artifacts live here
    ├── PIPELINE.json               # Pipeline definition
    ├── PLAN.md                     # What you want built
    ├── src/                        # Agent-written code
    ├── outputs/                    # Run outputs
    ├── logs/                       # Per-stage logs
    └── runs/                       # Run history manifests
```

---

## How Pipelines Work

A pipeline is a list of stages connected by transitions. Each stage runs in its own container and communicates via **output markers**:

```
    ┌──────────┐
    │  BUILD   │ ← reads PLAN.md, writes code to src/
    └────┬─────┘
         │ [STAGE_COMPLETE]
         ▼
    ┌──────────┐
    │   TEST   │ ← runs tests against src/
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

This is just the default template. ART has no hardcoded stage knowledge — it understands stages, transitions, mounts, and markers. Design any pipeline via `art compose`.

### Stage modes

- **Agent mode** (default): Claude agent receives a prompt and works autonomously
- **Command mode**: Runs shell commands via `sh -c`, parses markers from stdout

### Transitions and retries

Stages emit markers like `[STAGE_COMPLETE]` or `[STAGE_ERROR: msg]` to trigger transitions. Retry transitions re-send the prompt with the error description. Non-retry transitions advance to the next stage.

### Resume on interrupt

Completed stages are checkpointed. On restart, execution resumes from the next incomplete stage with previous context.

---

## Customizing Pipelines

Edit `__art__/PIPELINE.json` directly, or use the visual editor (`art compose`):

```json
{
  "stages": [
    {
      "name": "build",
      "prompt": "Read PLAN.md and implement the described changes in src/.",
      "mounts": { "plan": "ro", "src": "rw", "project": "ro" },
      "transitions": [
        { "marker": "STAGE_COMPLETE", "next": "test" },
        { "marker": "STAGE_ERROR", "retry": true }
      ]
    }
  ]
}
```

**Mounts** control what each stage can see: `"rw"` (read-write), `"ro"` (read-only), or `null` (hidden — not mounted at all).

Mount permissions work at file and directory granularity. `"project"` sets the default for your project root, and `"project:path/to/dir"` overrides a specific subdirectory — so you can keep the project read-only while granting write access to exactly the paths a stage needs.

**Custom markers** — define any marker string in transitions. The FSM matches agent output against them.

**Custom images** — each stage can use a different container image (e.g., a stage that needs CUDA or Vivado).

---

## Security

Agents run in containers with minimal access:

- **File-level mount permissions** — project defaults to read-only; specific files/directories can be granted write access per stage
- **`.env` shadowed with `/dev/null`** — secrets never exposed inside containers
- **Credential proxy** — containers never see real API keys; a host-side proxy injects credentials per-request
- **Per-group IPC isolation** — groups cannot access each other's files
- **Mount allowlist** — additional mounts validated against external allowlist

ART is designed to reduce accidental access and constrain agent execution, but it is not a formal sandbox. See `docs/SECURITY.md` for the full trust model and known limitations.

---

## Visual Pipeline Editor

`art compose` opens a browser-based editor (React + ReactFlow):

- Drag-and-drop stage nodes with transition edges
- Configure per-stage: prompt, mount policies (rw/ro/hidden), container image
- Project mount tree — browse and override sub-directory permissions
- Image registry with preset base images (Ubuntu, CUDA, Python, Node, ROS)
- Run history with log viewer
- Agent chat for plan discussion
- Hunk-based diff review with AI edit suggestions

---

## Container Runtime

ART auto-detects the available container runtime:

| Runtime | Notes |
|---------|-------|
| **Docker** | Full capabilities, default choice |
| **Podman** | Docker-compatible, SELinux support |

Runtime-specific behavior is abstracted via a capabilities system — code branches on `rt.capabilities.X`, not runtime names.

**Planned:** udocker (daemonless), Apple Container (macOS native).

---

## Installation

### npm (recommended)

```bash
npm install -g @aer-org/art
```

### One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/aer-org/art/main/install.sh | bash
```

### Manual

```bash
git clone https://github.com/aer-org/art.git ~/.art
cd ~/.art && npm install && npm run build
ln -s ~/.art/dist/cli/index.js ~/.local/bin/art
```

---

## CLI Reference

```bash
art compose <path>    # Open visual pipeline editor
art run <path>        # Execute pipeline
art update            # Rebuild all images in the registry
```

---

## Status

ART is under active development. Core pipeline execution, the visual editor, and container isolation are functional. The API surface may change between minor versions.

**Supported:** Linux, macOS

**Not supported:** Windows (use WSL)

---

## Documentation

| Document | Content |
|----------|---------|
| `docs/ARCHITECTURE.md` | System architecture — pipeline FSM, container runtime, mount isolation |
| `docs/REQUIREMENTS.md` | Design philosophy and decisions |
| `docs/SECURITY.md` | Trust model, mount isolation, credential proxy, known limitations |
| `docs/docker-sandboxes.md` | Running ART inside Docker Sandboxes (nested isolation) |

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

Released under **AGPL-3.0**. Commercial licensing is available for teams that need different terms.
