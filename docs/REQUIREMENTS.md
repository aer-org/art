# AerArt Requirements

Original requirements and design decisions from the project creator, updated to reflect current state.

---

## Why This Exists

This is a lightweight, secure alternative to OpenClaw (formerly ClawBot). That project became a monstrosity — 4-5 different processes running different gateways, endless configuration files, endless integrations. It's a security nightmare where agents don't run in isolated processes; there's all kinds of leaky workarounds trying to prevent them from accessing parts of the system they shouldn't. It's impossible for anyone to realistically understand the whole codebase. When you run it you're kind of just yoloing it.

AerArt gives you the core functionality without that mess.

---

## Philosophy

### Small Enough to Understand

The entire codebase should be something you can read and understand. One Node.js process. A handful of source files. No microservices, no message queues, no abstraction layers.

### Security Through True Isolation

Instead of application-level permission systems trying to prevent agents from accessing things, agents run in actual Linux containers. The isolation is at the OS level. Agents can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

### Built for One User

This isn't a framework or a platform. It's working software for personal use. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are added as skills — you install only what you actually use.

### Customization = Code Changes

No configuration sprawl. If you want different behavior, modify the code. The codebase is small enough that this is safe and practical. Very minimal things like the trigger word are in config. Everything else — just change the code to do what you want.

### AI-Native Development

I don't need an installation wizard — Claude Code guides the setup. I don't need a monitoring dashboard — I ask Claude Code what's happening. I don't need elaborate logging UIs — I ask Claude to read the logs. I don't need debugging tools — I describe the problem and Claude fixes it.

The codebase assumes you have an AI collaborator. It doesn't need to be excessively self-documenting or self-debugging because Claude is always there.

### Skills Over Features

When people contribute, they shouldn't add "Telegram support alongside WhatsApp." They should contribute a skill like `/add-telegram` that transforms the codebase. Users fork the repo, run skills to customize, and end up with clean code that does exactly what they need — not a bloated system trying to support everyone's use case simultaneously.

Skills are distributed as git branches on the upstream repo. Applying a skill is `git merge`. See `skills-as-branches.md` for details.

---

## Core Components

### Claude Agent SDK

The core agent runtime. Agents run inside containers via the Claude Agent SDK, communicating through IPC. The SDK spawns CLI subprocesses for tool execution, API calls, and subagent coordination.

### Container Isolation

All agents execute in containers (Docker, Podman, or udocker). The runtime is auto-detected and abstracted — code branches on capability flags, not runtime names. See `SECURITY.md` for the full security model.

### Channel System

Channels (WhatsApp, Telegram, Slack, Discord, Gmail) use a self-registration pattern. Each channel file calls `registerChannel()` at module load. Missing credentials cause graceful skip, not errors. Channels are installed as skill branches — the core repo ships no channel code.

### Pipeline Orchestration

A host-side FSM orchestrates multi-stage container execution. Each stage runs in its own isolated container with independent mounts and permissions. Stages communicate via output markers (`[STAGE_COMPLETE]`, `[STAGE_ERROR]`), and transitions are defined per-stage in `PIPELINE.json`. See `ARCHITECTURE.md` for the full pipeline mechanism.

### Image Registry

`~/.config/aer-art/images.json` maps keys to container image specs. Stages reference images by key. Presets available for common base images (Ubuntu, NVIDIA CUDA, Python, Node, ROS). Dashboard provides CRUD UI.

### Credential Proxy

Containers never see real API keys. A host-side HTTP proxy intercepts all Anthropic API calls and injects real credentials. Supports both API key and OAuth token modes. See `SECURITY.md` for details.

---

## Architecture Decisions

### Message Routing
- A router listens to registered channels and routes messages based on configuration
- Only messages from registered groups are processed
- Trigger: `@Andy` prefix (case insensitive), configurable via `ASSISTANT_NAME` env var
- Unregistered groups are ignored completely

### Memory System
- **Per-group memory**: Each group has a folder with its own `CLAUDE.md`
- **Global memory**: Root `CLAUDE.md` is read by all groups, but only writable from "main" (self-chat)
- **Files**: Groups can create/read files in their folder and reference them
- Agent runs in the group's folder, automatically inherits both CLAUDE.md files

### Session Management
- Each group maintains a conversation session (via Claude Agent SDK)
- Sessions auto-compact when context gets too long, preserving critical information

### Scheduled Tasks
- Users can ask Claude to schedule recurring or one-time tasks from any group
- Tasks run as full agents in the context of the group that created them
- Tasks have access to all tools including Bash (safe in container)
- Tasks can optionally send messages to their group via `send_message` tool, or complete silently
- Task runs are logged to the database with duration and result
- Schedule types: cron expressions, intervals (ms), or one-time (ISO timestamp)
- From main: can schedule tasks for any group, view/manage all tasks
- From other groups: can only manage that group's tasks

### Group Management
- New groups are added explicitly via the main channel
- Groups are registered in SQLite (via the main channel or IPC `register_group` command)
- Each group gets a dedicated folder under `groups/`
- Groups can have additional directories mounted via `containerConfig`

### Main Channel Privileges
- Main channel is the admin/control group (typically self-chat)
- Can write to global memory (`groups/CLAUDE.md`)
- Can schedule tasks for any group
- Can view and manage tasks from all groups
- Can configure additional directory mounts for any group

---

## CLI Commands

| Command | Purpose |
|---------|---------|
| `art init [dir]` | Scaffold `__art__/` with pipeline, agent files, and onboarding editor |
| `art compose [dir]` | Visual pipeline editor (browser-based, configuration only) |
| `art run [dir]` | Execute pipeline — sequential stage containers with IPC |
| `art update` | Rebuild all images in the registry |

### Authentication
- Token resolution: env vars → `.env` → saved token → Claude CLI credentials
- Validated with live API call before starting

---

## Integration Points

### Channels
- Installed as skill branches (e.g., `git merge upstream/skill/whatsapp`)
- Self-register at startup via `registerChannel(name, factory)`
- Currently available: WhatsApp (baileys), Telegram, Slack, Discord, Gmail

### IPC (Inter-Process Communication)
- Filesystem-based: containers write JSON files, host polls and processes (500ms interval)
- Per-group namespaced directories prevent cross-group access
- Authorization enforced: main group has full access, non-main groups are restricted to own scope

### Scheduler
- Built-in scheduler runs on the host, spawns containers for task execution
- Custom `aer-art` MCP server (inside container) provides scheduling tools
- Tools: `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`, `send_message`
- Tasks stored in SQLite with run history
- Scheduler loop checks for due tasks every minute

### Web Access
- Built-in WebSearch and WebFetch tools
- Standard Claude Agent SDK capabilities

### Browser Automation
- agent-browser CLI with Chromium in container
- Snapshot-based interaction with element references (@e1, @e2, etc.)
- Screenshots, PDFs, video recording
- Authentication state persistence

### Remote Control
- Container agents can spawn a host-level Claude Code session via IPC
- Returns a URL for the user; single active session at a time

---

## Setup & Customization

### One-Line Install
```bash
curl -fsSL https://raw.githubusercontent.com/aer-org/art/main/install.sh | bash
```
Installs to `~/.art`, creates `art` symlink, requires Node.js ≥ 20.

### Skills
- `/setup` — Install dependencies, authenticate channels, configure services
- `/customize` — Add channels, integrations, change behavior
- `/debug` — Container issues, logs, troubleshooting
- `/update-aer-art` — Pull upstream changes, merge with customizations

### Deployment
- Runs on macOS (launchd) or Linux (systemd)
- Single Node.js process handles everything

---

## Personal Configuration (Reference)

These are the creator's settings, stored here for reference:

- **Trigger**: `@Andy` (case insensitive)
- **Response prefix**: `Andy:`
- **Persona**: Default Claude (no custom personality)
- **Main channel**: Self-chat (messaging yourself in WhatsApp)

---

## Project Name

**AerArt** — A reference to Clawdbot (now OpenClaw).
