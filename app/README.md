# AerArt Debug UI

Localhost web app for debugging `art` pipelines.

## Run

```
./run.sh
```

That's it. The script installs deps on first run, builds the frontend if needed, starts the backend on `http://localhost:4000`, and opens your browser. `Ctrl-C` stops it.

Override the port with `AER_ART_APP_PORT=5000 ./run.sh`.

## What it does

- **Load Pipeline** — pick a project directory whose `__art__/PIPELINE.json` you want to debug.
- **Right panel** — live DAG of the pipeline. Nodes recolor (gray → blue → green / red) from `__art__/.state/` as `art run` progresses.
- **Click a node** — see its config, runtime state, logs, and transitions.
- **Run / Stop** — invoke `art run <projectDir>` or kill it.
- **Left panel** — chat with Claude Code in a hard `bubblewrap` sandbox. It can read the loaded project, inspect `__art__/.state/PIPELINE_STATE.json` and `.state/logs/`, run `art run "$AER_ART_PROJECT_DIR"`, and write only to that project's `__art__/`.

The debugger chat defaults to Opus 4.6 / max effort.
Each turn has recovery watchdogs for SDK initialization, send/enqueue, and
stream inactivity; stale sessions are closed loudly and recreated on the next
message rather than leaving the UI stuck on `Thinking...`.

## Requirements

- Node 22+
- `art` and `claude` on `PATH`
- `bubblewrap` (`bwrap`) on `PATH` for the isolated debugger
- A container runtime (`docker`, `podman`, or `udocker`) for `art run`
