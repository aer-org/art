# Plan — `app/` localhost debug UI for AerArt pipelines

## Context

AerArt today has no graphical surface for debugging a running pipeline: when `art run .` is executing, the only way to see which stage is active or which one failed is to read raw logs and `__art__/PIPELINE_STATE.json` by hand. We want a localhost web app under `art/app/` that:

1. Loads a project directory (its `__art__/PIPELINE.json`) on demand.
2. Shows the pipeline as a DAG, recoloring nodes live as the pipeline progresses (gray → blue → green / red).
3. Lets the user click a node to see *all* of its information (config + runtime state + logs + transitions).
4. Has a left-hand chat panel running Claude Code, steered to refine `__art__/PIPELINE.json`.
5. Has a `Run` button that invokes `art run <projectDir>` from the chosen working directory.

Hard constraint: **do not modify the `art` CLI itself**. Only files under `app/`, `src/pipeline-runner.ts`, and `src/container-runner.ts` are writable in this checkout. We will not need to touch the latter two — the app stays entirely under `app/`.

User-confirmed design choices:
- Chat: shell out to `claude` CLI (not the heavyweight container scaffold), Claude-only at launch.
- Editing PIPELINE.json: steer via system prompt only; no hard-lock.
- **Launcher: a single shell script under `app/`** (e.g. `./run.sh`). No `npm run dev` workflow — the GUI must be usable from one command. We'll add CLI polish (multi-mode flags, etc.) later, *after* the GUI is verified working.
- **Assume `art` is already installed and authenticated on PATH.** Don't engineer around fallback binary discovery or first-run image pulls in v1; surface clear errors if they're missing.

---

## Repo layout

`app/` is a self-contained sub-project with its own `package.json` and `node_modules`. It does **not** import from the parent `src/`; it only invokes the published `art` binary as a subprocess and reads `__art__/` files. Keeping it standalone avoids dragging React/Vite/reactflow into the core package.

```
app/
├── run.sh                       # SINGLE LAUNCHER: install deps if needed, build, start, open browser
├── package.json                 # name "@aer-org/art-debug-app", private:true
├── tsconfig.json                # ESM, target node20
├── README.md                    # how to run (just: ./run.sh)
├── server/                      # Backend (Node + TypeScript)
│   ├── index.ts                 # Fastify + SSE entry, port 4000
│   ├── config.ts                # ART_BIN discovery, port, dirs
│   ├── routes/
│   │   ├── browse.ts            # GET /api/browse?path=...
│   │   ├── load.ts              # POST /api/load { path }
│   │   ├── state.ts             # GET /api/state, GET /api/events (SSE)
│   │   ├── run.ts               # POST /api/run, POST /api/stop
│   │   ├── stage.ts             # GET /api/stage/:name (full info)
│   │   ├── pipeline.ts          # POST /api/pipeline (validated edit)
│   │   └── chat.ts              # POST /api/chat, GET /api/chat/events
│   ├── pipeline-watcher.ts      # chokidar on __art__/, debounced, JSON-parse-tolerant
│   ├── run-controller.ts        # spawn art, capture stdio, mutex
│   ├── chat-controller.ts       # per-turn claude spawn, session-id management
│   ├── preflight.ts             # detect docker/podman, claude CLI, claude auth
│   └── pipeline-graph.ts        # merge PIPELINE.json + insertedStages → DAG
└── web/                         # Frontend (Vite + React + TypeScript)
    ├── package.json             # nested; depends on react, reactflow, dagre
    ├── vite.config.ts           # proxies /api → http://localhost:4000
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx              # Two-column layout (chat | graph)
        ├── components/
        │   ├── ChatPanel.tsx
        │   ├── PipelineGraph.tsx     # reactflow + dagre
        │   ├── StageNode.tsx         # custom node with status color
        │   ├── NodeModal.tsx         # click → all info
        │   ├── DirectoryPicker.tsx   # in-app tree, "Choose this directory"
        │   └── RunBar.tsx            # Run / Stop, status dot, project path
        ├── hooks/
        │   ├── usePipelineState.ts   # SSE → state, debounced graph rebuild
        │   └── useChat.ts            # SSE → token stream
        └── lib/api.ts                # fetch + SSE wrappers
```

Launcher (`app/run.sh`):
```
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# 1. Install backend deps if missing or stale (cmp package.json mtime vs node_modules/.installed)
[ -d node_modules ] || npm install

# 2. Install + build frontend if dist is missing or older than any source file
[ -d web/node_modules ] || (cd web && npm install)
[ -d web/dist ] && [ "$(find web/src -newer web/dist -print -quit)" = "" ] || (cd web && npm run build)

# 3. Start backend on $AER_ART_APP_PORT (default 4000); it serves web/dist statically
PORT="${AER_ART_APP_PORT:-4000}"
echo "Starting AerArt debug UI on http://localhost:${PORT}"

# 4. Open browser in background (best-effort: xdg-open on Linux, open on macOS)
( sleep 1 && (command -v xdg-open >/dev/null && xdg-open "http://localhost:${PORT}" \
              || command -v open >/dev/null && open "http://localhost:${PORT}" \
              || true) ) &

# 5. Foreground the backend so Ctrl-C kills it cleanly
exec node --experimental-strip-types server/index.ts
```

(Use `--experimental-strip-types` on Node 22+; if the user's Node is older, fall back to `tsx server/index.ts` after a one-time `npm i -g tsx` or local `npx tsx`. Decided during implementation based on the `engines` field and `node --version` probe at the top of `run.sh`.)

Single-command UX: `cd app && ./run.sh` — everything else (install, build, browser open) happens inside.

---

## Architecture: how the agent and the visualizer talk

There is **no dedicated `art_run_visualize` tool** — no MCP server, no
`createSdkMcpServer`, no `--mcp-config` flag. The visualization is achieved
through two fully decoupled pieces glued by the filesystem:

- **Producer 1 (debugger agent)** — the left-panel agent calls the built-in
  `Bash` tool with `run_in_background: true`, per `debugger/AGENT.md`. It
  receives a background-task id, then either polls `__art__/PIPELINE_STATE.json`
  / log files via Bash + Read, or simply waits — when the run finishes, a
  V2 SDK `task_notification` arrives in the still-open session and the chat
  controller forwards it as a `background-task` event.

- **Producer 2 (user "Run" button)** — the right-panel RunBar posts to
  `/api/run` and `run-controller.ts` spawns `art run <projectDir>` as a child
  of the Fastify server. Used when the user wants to run the pipeline without
  going through the chat agent.

- **Consumer (the visualizer)** — `pipeline-watcher.ts` watches the project's
  `__art__/PIPELINE.json`, `PIPELINE_STATE*.json`, `runs/`, and `logs/`
  with chokidar (debounced 100 ms; 2 s mtime-poll fallback for NFS). Changes
  fan out as `snapshot` and `run-log` SSE events on `/api/events`. The right
  panel (`usePipelineState.ts` → `PipelineGraph.tsx`) re-renders the dagre
  DAG and recolors nodes per `pipeline-graph.ts:statusOf()`.

Both producers write to the same `__art__/` files; they don't coordinate.
The visualizer does not care **who** started a run — that's why it stays
correct under either path.

The agent **must not** call any HTTP API on `localhost` (enforced by
`debugger/AGENT.md`). It also must not edit anything outside
`__art__/PIPELINE.json` (enforced by the same AGENT.md, plus
`bypassPermissions` is intentional: the only safety net is the role
definition and the lack of `--add-dir` on anything else).

If we ever need richer agent → GUI signal channels (e.g. surface
`joinSettlements` mid-run as a special pill), the right evolution is an
SDK-MCP server registered via `createSdkMcpServer` that wraps `art run` and
emits structured progress events back through the chat controller via
callback. That is **not built** today; the file-watcher decoupling is what
makes the system robust to "who started the run."

---

## Data model

### Source of truth on disk (relative to chosen `<projectDir>`)
- `<projectDir>/__art__/PIPELINE.json` — authored stages, validated by `loadPipelineConfig` in `src/pipeline-runner.ts:2550`. Schema documented in `src/pipeline-runner.ts:56-134` (PipelineStage) and `:268-278` (PipelineState).
- `<projectDir>/__art__/PIPELINE_STATE.json` — live state (`currentStage`, `completedStages`, `status`, `insertedStages`). Atomically written via tmp+rename (`src/pipeline-runner.ts:467-471`, `:324-333`).
- `<projectDir>/__art__/runs/<runId>.json` — per-run manifest with stage history & durations (`src/run-manifest.ts:20-29`).
- `<projectDir>/__art__/logs/pipeline-*.log` — host-side stage transition log (prefixed lines like `[stage-name] ...`).
- `<projectDir>/__art__/logs/container-*.log` — per-container streaming output.
- `<projectDir>/__art__/templates/<name>.json` — template definitions referenced by `transitions[].template`.

### Effective DAG (what we render)
```
nodes = PIPELINE.json.stages ∪ (PIPELINE_STATE.json.insertedStages ?? [])
edges = ⋃ stage.transitions[].next → string | string[] | null
ghostNodes = transitions[].template that haven't materialized yet → dashed/placeholder
multiActive = currentStage as string[] is fan-out → all colored "running"
```
Stitched stage names follow `${origin}__${templateName}${i}__${stageName}` plus `${origin}__${templateName}__join`. When `currentStage` is in *neither* source list, render an "unknown stage" placeholder rather than crashing — this happens in the brief window between the engine writing state and our watcher catching up.

---

## Backend modules

**`server/config.ts`**
- `PORT = process.env.AER_ART_APP_PORT || 4000`
- `ART_BIN = 'art'` — assume it's on PATH (user has confirmed). If absent, fail loudly with a one-line "art not found on PATH" error in the UI; do not try fallbacks in v1.

**`server/preflight.ts`** — runs at startup, cached 60s, surfaced as a single banner if anything is wrong:
- `art --version` (binary present).
- `claude --version` (binary present).
- Container runtime: `docker info` || `podman info` || `udocker version` (mirrors `src/cli/run.ts:26-35`).
- (We *don't* probe Claude auth in v1 — chat requests will surface auth errors when they happen, and adding a probe slows startup. Revisit if false-start UX hurts.)

**`server/pipeline-watcher.ts`** — one watcher per loaded project, using `chokidar`:
- Paths: `<art>/PIPELINE.json`, `<art>/PIPELINE_STATE*.json`, `<art>/runs/`, `<art>/logs/`.
- Ignore `*.tmp`. `awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }` defends against the chat agent's `Edit`/`Write` (those don't atomic-rename).
- On change: try `JSON.parse`; on failure debounce 250 ms and retry once. Never push parse errors as graph state — keep last-good.
- 2 s polling fallback for NFS/SSHFS where inotify is flaky.

**`server/run-controller.ts`**
- In-memory mutex `Map<projectDir, RunHandle>`. `POST /api/run` returns 409 if entry exists OR if any `runs/run-*.json` shows `status: 'running'` with a live PID (`process.kill(pid, 0)`).
- Spawn: `spawn('art', ['run', projectDir], { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] })`. `art` is on PATH (user assumption). Non-TTY stdin makes `askConfirmation` auto-yes (`src/cli/run.ts:76-78`) so any image-pull prompt during a first run resolves itself; the pull is streamed to SSE so the UI shows progress.
- Stream stdout/stderr line-by-line into SSE.
- `POST /api/stop`: SIGTERM (lets `src/cli/run.ts:196-209` mark cancelled), wait 5 s, then enumerate `docker ps`/`podman ps` for `aer-art-*` containers and kill leftovers. Surface residual to user.

**`server/chat-controller.ts`** — per-chat **persistent V2 SDK session**, lazily
created on first `send()` and held open across turns. Wraps
`@anthropic-ai/claude-agent-sdk`'s `unstable_v2_createSession` /
`unstable_v2_resumeSession`:

```ts
unstable_v2_createSession({
  model, cwd: app/debugger,
  settingSources: ['project', 'user'],
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
  env: { ...process.env, AER_ART_PROJECT_DIR },
  executableArgs: [
    '--add-dir', projectDir, '--add-dir', `${projectDir}/__art__`,
    '--effort', effort,
    '--append-system-prompt', sessionContext,
    '--include-partial-messages',
  ],
})
```

A single long-lived consumer iterates `session.stream()` and forwards
`assistant` (with partial text deltas), tool-result echoes, `result`, and
**`task_notification`** to the SSE stream. Background `art run` processes
launched by the agent via `Bash(run_in_background: true)` survive across
turns because the underlying CLI subprocess never exits between sends — and
when those background runs eventually finish, the `task_notification` lands
in the same long-lived consumer and we surface it as a `background-task`
chat event the UI can pin inline.

Settings changes (model/effort) tear down the live session and re-create via
`unstable_v2_resumeSession(sessionId, …)` so transcript history is
preserved. `cancel()` calls `session.close()` — the only path that ends the
CLI and may kill child `art` processes. Normal end-of-turn does not.

The system prompt is the Claude Code preset with an `--append-system-prompt`
that reiterates the loaded project path and reminds the agent that
background tasks survive across turns. The full role definition lives in
`debugger/AGENT.md` and is auto-discovered via the debugger CWD plus
`settingSources: ['project', 'user']`.

**`server/pipeline-graph.ts`** — `buildGraph(pipelineJson, stateJson, templatesDir)`:
- Nodes: `id`, `name`, `kind`, `status` ('pending'|'running'|'success'|'error'|'unknown'), `isStitched`, `isTemplatePlaceholder`.
- Status:
  - `name` in `currentStage` (string or array) → `running`
  - `name` in `completedStages` → `success` (or `error` if it's the last completed entry and `state.status === 'error'`)
  - else → `pending`
- Layout: `dagre` left-to-right.
- Templates referenced via `transitions[].template`: dashed ghost node between source and `next` until materialized in `insertedStages`.

**`server/routes/pipeline.ts`** — `POST /api/pipeline { config }`:
- Validate (mirror invariants from `loadPipelineConfig` `src/pipeline-runner.ts:2550-2926`: stages non-empty, names unique, kind/prompt/image valid types, transitions reference existing stages, no cycles).
- On success, atomic write (tmp + rename) under `proper-lockfile`.
- 409 if a run is active.

---

## Frontend modules

**`App.tsx`** — two-column: left `<ChatPanel>` ~40%, right `<RunBar>` over `<PipelineGraph>` ~60%. Modal overlay for `<NodeModal>`.

**`DirectoryPicker.tsx`** — in-app tree (browser's native picker can't return absolute paths):
- Starts at `~`. Click folder → `GET /api/browse?path=<abs>` returns subdirs.
- "Choose this directory" → `POST /api/load { path }`. Backend verifies `<path>/__art__/PIPELINE.json` exists; returns parsed config.
- Missing `__art__/`: surface "Run `art init <path>` first." Don't auto-init (preserves the no-CLI-changes contract).

**`PipelineGraph.tsx`** — reactflow + dagre, custom `<StageNode>`:
- gray (pending), blue pulsing (running), green (success), red (error), dashed gray (template placeholder), striped (unknown).
- Click → opens `<NodeModal>` populated from `GET /api/stage/:name`.

**`NodeModal.tsx`** — tabs:
1. **Config** — pretty-printed PipelineStage entry (PIPELINE.json or insertedStages).
2. **Runtime** — status, start/end times from run-manifest, exit code, container name, retry count.
3. **Logs** — last 500 lines of `pipeline-*.log` filtered by `[<stage>] ` prefix + entries from this stage's `container-*.log`.
4. **Transitions** — outbound transitions list (marker → next, with payload mode noted).

**`ChatPanel.tsx`** — streaming message list + input. SSE on `/api/chat/events?chatId=…`. Tool calls shown as inline badges (`🔧 Edit __art__/PIPELINE.json`). Disabled until a project is loaded. If `claude` returns an auth error, the chat surfaces it inline ("Run `claude /login` and retry") rather than being blocked at startup.

**`RunBar.tsx`** — project path, status dot from `PIPELINE_STATE.json.status`, Run/Stop button, "show pipeline log" toggle.

---

## Verification

Pre-built example pipelines exist:
- `examples/autoresearch/` — single command stage, fans out via template.
- `examples/stitch-showcase/` — 3 agent stages, then 1 template stitch.
- `tests/e2e/fixtures/multi-stage/` — three command stages, linear.

E2E test plan:
1. `cd app && ./run.sh` → browser opens to `http://localhost:4000`. (First run installs deps + builds; subsequent runs start instantly.)
2. **Picker**: navigate to `examples/stitch-showcase`. Confirm graph shows `kickoff → prepare → launch` with a dashed `main` ghost off `launch`.
3. **Chat**: ask "show me the prepare stage's prompt". Then "change prepare's prompt to return [GO]". Verify file changes; chat shows Edit tool call; graph re-renders if visible.
4. **Run**: click Run → backend spawns `art run examples/stitch-showcase`. Watch graph: `kickoff` blue→green, `prepare` blue→green, `launch` blue, then `main` ghost materializes into 3 stitched nodes that color through to green. Status dot: green.
5. **Click each node** — verify all four tabs populate; Logs shows `[<stage>] …` lines from `pipeline-*.log`.
6. **Failure path**: edit `kickoff`'s prompt to deliberately not return `[OK]`. Run again. `kickoff` red, status dot red, Runtime tab shows failure marker.
7. **Stop mid-run**: SIGTERM → manifest cancelled → `aer-art-*` containers cleaned up within 5 s.
8. **Multi-run guard**: click Run while one is going → 409 + "A run is already in progress" inline; button disabled.
9. **Watcher tolerance**: hand-edit PIPELINE.json with a syntax error mid-save → graph keeps last-good state, recovers when valid.
10. **Missing-binary errors**: temporarily move `art` off PATH (or `claude`) and refresh → preflight surfaces a one-line banner identifying the missing binary.

---

## Critical files

To create (under `app/` only):
- `app/run.sh` (executable) — single launcher
- `app/package.json`, `app/tsconfig.json`, `app/README.md`
- `app/server/{index,config,preflight,pipeline-watcher,pipeline-graph,run-controller,chat-controller}.ts`
- `app/server/routes/{browse,load,state,run,stage,pipeline,chat}.ts`
- `app/web/{package.json,vite.config.ts,index.html,tsconfig.json}`
- `app/web/src/{main.tsx,App.tsx}`
- `app/web/src/components/{ChatPanel,PipelineGraph,StageNode,NodeModal,DirectoryPicker,RunBar}.tsx`
- `app/web/src/hooks/{usePipelineState,useChat}.ts`
- `app/web/src/lib/api.ts`

Read for behavior reference (do not edit):
- `src/pipeline-runner.ts` — schema `:56-134`, state `:268-278`, atomicWrite `:467-471`, `loadPipelineConfig` `:2550`, stitch insertion `:618`
- `src/cli/run.ts` — preflight `:13-74`, askConfirmation TTY check `:76-88`, `--skip-preflight` `:43-64`, signal handlers `:196-209`
- `src/run-engine.ts` — what `art run` does end-to-end
- `src/run-manifest.ts` — RunManifest interface `:20-29`, atomic write `:46-48`
- `src/group-folder.ts` — `__art__/` is registered as group folder via `setupEngine`
- `examples/{autoresearch,stitch-showcase,stitch-demo}/__art__/PIPELINE.json`

External CLI surface we depend on:
- `art run <projectDir>` exits 0/1; non-TTY skips confirmation prompts.
- `claude -p --input-format stream-json --output-format stream-json --include-partial-messages --session-id <uuid>` (first turn), `--resume <uuid>` (subsequent).
- `claude --version` for preflight (no auth probe — auth errors surface inline on first chat turn).

---

## Out of scope (explicitly)

- No changes to the `art` CLI or any file outside `app/`.
- No `art init` from the UI (writes outside `app/`).
- No CLI flags / multi-mode launcher in v1 — `./run.sh` is the only entry point. CLI polish comes after the GUI is verified working.
- No first-run setup wizard; assume `art` and `claude` are installed and authenticated.
- No Codex provider in v1.
- No hard-lock on chat agent edits.
- One loaded project at a time.
- Chat history not persisted across server restarts (Claude session is resumable via cached `--session-id`).
