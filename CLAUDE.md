# AerArt

Pipeline tool for running multi-stage agent workflows in containers. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

CLI tool (`art compose` + `art run`) that orchestrates multi-stage pipelines. Each stage runs a Claude agent in an isolated container with configurable mounts and images. The host-side FSM manages stage transitions via IPC markers.

## Key Files

| File | Purpose |
|------|---------|
| `src/run-engine.ts` | Minimal pipeline execution engine for `art run` |
| `src/config.ts` | Paths, intervals, image registry path |
| `src/container-runner.ts` | Spawns agent containers with mounts and per-stage image support |
| `src/pipeline-runner.ts` | Host-side pipeline FSM with per-stage image and command mode |
| `src/image-registry.ts` | Image registry CRUD (`~/.config/aer-art/images.json`) |
| `container/skills/agent-browser/SKILL.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/debug` | Container issues, logs, troubleshooting |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
