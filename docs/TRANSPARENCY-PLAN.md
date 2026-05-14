# Transparency Plan

Goal: make every ART run inspectable at multiple levels of detail without forcing the user to read raw stream logs. Visualization is out of scope here — this plan covers *what data is captured, where it lives on disk, and how the runtime is refactored to produce it*.

Status legend: `[ ]` = not started, `[~]` = in progress, `[x]` = done.

---

## 1. Signal hierarchy

```
L0  Run summary           who/what/when/outcome
L1  Stage I/O             prompts, commands, diffs, transitions  ← highest ROI
L2  Stage internals       agent stream, tool output, decision logs
L3  Provider/turn         LLM call metadata, OAuth, costs
L4  Container/runtime     image, mounts, exit codes, resources
```

Orthogonal signals (cut across layers): decision logs, state-snapshot diffs, provenance, error-context bundles, stitch tree timeline, mount-watchpoint logs.

### L1 in detail (opening I/O only)

An L1 stage record is self-contained enough to answer "what was this stage asked to do, and what did it produce". Two design choices:

- **Opening package only.** L1 captures the first system prompt + initial payload handoff. Subsequent retry/feedback prompts during the same stage execution belong in L2 decision logs.
- **Hash in record, full text on disk.** Long prompts go to `prompt.txt` / `initial.txt`; the L1 record carries only the sha256. Keeps records compact, preserves reproducibility, lets tools verify "two runs used the same prompt" cheaply.

L1 fields:

- `promptSource`: `agents/<ref>.md` path + sha256, or `inline`
- `resolvedSystemPrompt`: post-substitution (`{{insertId}}`, `{{index}}`, payload) — hash only in record, full text on disk
- `initialPrompt` / `ephemeralSystemPrompt`: payload handoff from the upstream stage
- `substitutions`: `{ insertId, index, ...payloadFields }` — lets a reader see why this lane differs from its siblings
- `resolvedCommand` (command mode only): post-substitution shell string + `shell`, `timeout`, env snapshot
- Artifact diff per writeable mount: path + add/modify/delete + line counts
- Matched marker + payload + selected transition index
- Container retry count, final exit code

---

## 2. Run state model

Three derived states, no mutable status field. The runtime stores two facts: the PID inside `run.json`, and the presence of a `sealed` marker file. Everything else is computed at query time.

| State | Condition |
| ----- | --------- |
| `sealed` | `exists(runs/<id>/sealed)` |
| `live` | `!sealed && isPidAlive(run.json.pid)` |
| `crashed` | `!sealed && !isPidAlive(run.json.pid)` |

Mutual exclusion is by precedence: `sealed` marker is the source of truth; if it's there the run is finished even if a PID happens to still be alive.

### Scan classification edge cases

| Situation | Classification |
| --------- | -------------- |
| Folder exists, `run.json` missing | crashed |
| `run.json` parse error | crashed |
| `pid` missing or 0 | crashed |
| `sealed` exists but `summary.json` missing | sealed (degraded — flag at display time) |
| `sealed` exists and PID alive | sealed (marker wins) |

Principle: ambiguous → crashed. Never silently classify a run as live without positive evidence.

### PID liveness limitations

- **PID reuse**: after the original process dies, the OS may reassign the PID. To detect this, record process start-time alongside PID in `run.json` and compare on liveness check. Skip in v1; add when the first false-positive shows up.
- **Cross-host**: PID is host-local. If `runs/` lives on a network share, scans from other hosts get meaningless results. Record `hostname` in `run.json` now (cost ~0); future multi-host work can use it.

### Concurrent runs

Two `art run` invocations on the same project: each gets its own `runs/<id>/`, no shared mutable state, so they don't fight by default. The "current" concept is replaced by **live runs (plural)** derived from a scan. Resource conflicts (e.g. two runs writing the same rw mount) are a separate problem and out of scope here.

---

## 3. Filesystem layout

Two organizing principles:

1. **A run directory is the single source of truth.** All signals for one run live under one folder, so `rm -rf`, `diff -r`, and `tar` work without surgery.
2. **The dispatch tree is recorded in state, not in folder nesting.** Every dispatch node — root, child, grandchild, great-grandchild — gets its own folder at the same depth under `nodes/`. Parent/child links live in `state/PIPELINE_STATE.json`'s `dispatchTree`. This keeps paths shallow, makes `ls nodes/*/stages/*` enumerate everything, and avoids PATH_MAX issues for deep stitch trees. Same spirit as git: the commit graph (parent→child DAG) is never reflected in folder nesting — every object lives at one shallow namespace and parent links exist only inside the object. We skip git's 2-char fan-out (`objects/ab/cdef…`) because that exists for very-large-N performance and a single ART run has at most hundreds of dispatch nodes, so 1-level flat is fine.

There are deliberately **no `runs/current` or `runs/latest` symlinks/pointers**. Listing the runs/ directory and classifying each entry is fast enough at the retention sizes we expect, and removing the pointer eliminates Windows-symlink portability issues and pointer/state consistency races.

```
__art__/
├── PIPELINE.json
├── agents/
├── templates/
└── runs/
    └── <runId>/
        ├── run.json          # L0 at start — pid, hostname, provider, image, args, startTime
        ├── summary.json      # L0 at end — outcome, totals, durations, tree depth
        ├── pipeline.snap.json # immutable copy of PIPELINE.json at run start
        ├── provenance.json   # sha256 of each agents/*.md and templates/*.json + env whitelist
        ├── events.jsonl      # append-only runtime event timeline (transitions, stitches, barriers, state-snapshots)
        ├── state/            # live state files
        │   ├── PIPELINE_STATE.json
        │   └── PIPELINE_STATE.<scopeId>.json
        ├── sessions/         # Codex/Claude session state
        ├── nodes/            # one folder per dispatch node, flat
        │   ├── root/
        │   ├── d_abc12_0/
        │   └── d_abc12_0__d_def34_1/   # grandchild at the same depth as its parent
        │       └── stages/<stageName>/
        │           ├── stage.json         # L1 record (hashes + metadata)
        │           ├── prompt.txt         # L1 full resolved system prompt
        │           ├── initial.txt        # L1 payload handoff (initial + ephemeral)
        │           ├── substitutions.json # L1 {insertId, index, payload fields}
        │           ├── command.sh         # L1 (command mode only)
        │           ├── diff/              # L1 per-mount artifact diff
        │           │   ├── src.diff
        │           │   └── outputs.diff
        │           ├── decisions.jsonl    # L2 marker / barrier / retry decisions
        │           ├── agent.stream.log   # L2 agent thinking + tool output
        │           ├── stdout.log         # L2 command mode stdout
        │           ├── stderr.log
        │           ├── ipc/               # L2 IPC traffic mirror
        │           ├── turns/             # L3 per-LLM-call metadata
        │           │   ├── 001.json
        │           │   └── 002.json
        │           ├── container.json     # L4 image, resolved mounts, exit code, mount violations
        │           └── error.json         # error-context bundle (only on failure)
        └── sealed            # empty marker file — run finished; safe for GC / compression
```

### File mutability classes

Drives GC, redaction, and compression policy.

- **Immutable (write-once)**: `pipeline.snap.json`, `provenance.json`, `prompt.txt`, `substitutions.json`, `command.sh`, `container.json`, `turns/NNN.json`, `error.json`, `summary.json`, `sealed`
- **Append-only**: `events.jsonl`, `decisions.jsonl`, `agent.stream.log`, `stdout.log`, `stderr.log`, `ipc/*`
- **Mutable**: `state/PIPELINE_STATE*.json`, `run.json` (a small set of fields only — pid/hostname/startTime do not change after first write)

`run.json` is *effectively* immutable for everything except a possible "endTime" annotation; the rest of "progress" lives in `events.jsonl`.

### Per-stage retries / re-entry

If a stage runs more than once: `stages/<stageName>/attempts/01/`, `02/`, ... with a `latest` symlink. Common single-attempt case omits `attempts/` and writes straight into the stage folder.

### Signal → location

| Signal                       | Location                                                                   |
| ---------------------------- | -------------------------------------------------------------------------- |
| L0 run summary               | `run.json` + `summary.json`                                                |
| L1 stage I/O                 | `nodes/<n>/stages/<s>/{stage.json, prompt.txt, initial.txt, substitutions.json, command.sh, diff/}` |
| L1 transition timeline       | `events.jsonl` (run-wide)                                                  |
| L2 stage internals           | `nodes/<n>/stages/<s>/{agent.stream.log, stdout.log, stderr.log, ipc/}`    |
| L2 decision logs             | `nodes/<n>/stages/<s>/decisions.jsonl` + `events.jsonl`                    |
| L3 provider/turn             | `nodes/<n>/stages/<s>/turns/NNN.json`                                      |
| L4 container                 | `nodes/<n>/stages/<s>/container.json`                                      |
| Provenance                   | `provenance.json` + `pipeline.snap.json`                                   |
| State-snapshot diffs         | emitted as events in `events.jsonl`                                        |
| Error-context bundle         | `nodes/<n>/stages/<s>/error.json`                                          |
| Stitch tree timeline         | derivable from `events.jsonl`                                              |
| Mount watchpoint violations  | `nodes/<n>/stages/<s>/container.json` (`violations` array)                 |

### Retention

Keep last N sealed runs (config; default 10). Optionally gzip heavy files (`agent.stream.log`, `ipc/*`) on sealed runs in a background sweep. Whole `runs/` tree is gitignored.

---

## 4. Implementation strategy

### 4.1 Two new modules

**`src/run-registry.ts`** — single entry point for all "which runs exist?" queries. Replaces ad-hoc folder scans currently scattered between the library and the server.

```
listRuns()      → [{ runId, state, runJson, startTime }]
liveRuns()      → state === 'live'
crashedRuns()   → state === 'crashed'
sealedRuns()    → state === 'sealed'
findRun(runId)
```

Callers:
- CLI `art run` (concurrent-run detection at startup, resume candidate listing)
- `app/server/run-controller.ts` (UI run list)
- Future retention sweeper
- Future `art inspect`

**`src/run-recorder.ts`** — run-scoped object that owns one `runs/<runId>/` and all writes into it. Replaces the current pattern of ad-hoc `writeRunManifest()` calls + global pino logger as the persistence path.

```
RunRecorder.create(stateDir) → allocates runId, creates run dir, writes run.json
recorder.event(type, payload)
recorder.startStage(nodeId, stage) → StageRecorder
  stageRecorder.writePrompt / writeCommand / writeSubstitutions
  stageRecorder.streamSink() → WriteStream for agent.stream.log
  stageRecorder.decision(kind, payload)
  stageRecorder.finishStage({outcome, exitCode, marker, ...})
recorder.finalize(outcome) → writes summary.json + sealed
```

Stitched child `PipelineRunner` instances **share the parent's recorder**; only their `nodeId` scope changes. They never create their own run dir.

Pino stays as the live, operator-facing logger. Recorder is the archival, structured sink. Both can be called from the same site.

### 4.2 What changes in existing code

| Today | After |
| ----- | ----- |
| `src/logger.ts` (pino) | **Deleted.** Almost all current `logger.*` sites are archive events, not human-facing. Pino + pino-pretty + TUI log dir branch all go away. |
| All internal `logger.info / logger.debug / logger.warn / logger.error` calls | Migrated to `recorder.event(...)`. For genuinely user-facing fatal cases, also `console.error(...)` directly — no helper. |
| `src/pipeline-state.ts` path resolver (`pipelineStateFileName`) | Path resolver is owned by `RunRecorder`. State-file functions take a recorder and ask it for paths. |
| `src/run-manifest.ts` (flat `runs/<id>.json`) | Replaced by `RunRecorder` + `run-registry`. The 4 `writeRunManifest()` calls in `pipeline-runner.ts` are deleted; the same information becomes events in `events.jsonl`, and a single `summary.json` is written at finalize. |
| `pipeline-runner.ts:355-365` per-run pipeline log file | Deleted. Each stage gets its own `agent.stream.log` / `stdout.log` / `stderr.log` directly. |
| `container-runner.ts:788-800, 834-888` per-container log file | Deleted. Output goes straight into the stage's log files. |
| `app/server/run-controller.ts:readRunManifests` (private folder scan) | Replaced by calls to `run-registry`. |
| `app/server/pipeline-watcher.ts` state-file path | Updated to read from `runs/<id>/state/`. |
| `ART_TUI_LOG_DIR` env var + TUI log branch | Removed along with pino. |
| Doc lie: `_current.json` mention in `run-manifest.ts:5` | Removed. |

### 4.2a The only remaining CLI output

Three categories survive as `console.error(...)` writes (no abstraction layer):

1. **Run start / end one-liners**:
   - `Started <runId>. Tail with: art logs <runId>` (or similar)
   - `Run completed in <duration>: <outcome>`
2. **Fatal errors before recorder exists**: malformed `PIPELINE.json`, missing docker, runId collision, etc. Nothing can be archived; stderr is the only sink.
3. **Interactive prompts**: e.g. the size gate. These are stdout/stdin, not log output.

Anything that doesn't fit one of these three categories is archive-only and goes through `recorder.event(...)`.

### 4.3 Where new data comes from

**L1**
- Resolved prompt / substitutions: already available at `pipeline-runner.ts:695` (`spawnStageContainer`). Hook there.
- Initial / ephemeral payload handoff: `node-scheduler.ts:278-284` (`buildPayloadHandoff` result). Hook at the same spawn site.
- Resolved command: `container-runner.ts:592` just before `spawn(rt.bin, ...)`.
- Matched marker + payload + chosen transition: `pipeline-transitions.ts:144-174` (`parseStageMarkers` return value).
- Artifact diff: **new instrumentation**. Strategy = ephemeral pre-state snapshot + `git diff --no-index`. At stage start, hardlink-copy each rw mount into a tmpdir (`runs/<id>/.tmp/<stage>/`) — hardlinks make this nearly free for files the stage doesn't touch, copy-on-write kicks in only when the stage actually writes. At stage end, `git diff --no-index <tmpdir> <rw-mount>` → save unified diff + numstat to `diff/<mount>.diff`. Delete tmpdir. Pre-state is *not* preserved beyond stage end. Git becomes a host runtime dependency — must be documented in `docs/REQUIREMENTS.md`.
- Stitch invocation event: `stitch.ts:buildStitchInvocation` return site.
- Container retry count / exit code: already in `container-runner.ts:770-909` close handler.

**L2**
- Agent stream: today funneled through `logStream` in `pipeline-runner.ts:700`. Redirect into per-stage `agent.stream.log`. Raw text preserved.
- IPC traffic: `stage-ipc.ts:48-59` (host→container) and `:69-108` (container→host, where files are deleted after read). Mirror before delete.
- Marker decisions: extend `parseStageMarkers` to also return considered candidates; recorder writes `decisions.jsonl`.
- Barrier evaluations: `template-dispatch.ts:209-222` (`evaluateBarrierOutcome`).
- Retry decisions: `container-runner.ts` retry loop.

**L3**
- Largest new instrumentation, lives inside the agent runner. `container/agent-runner/src/engines/{claude,codex}-engine.ts` is where the SDK is called. Both SDKs expose per-turn usage in message metadata (input/output tokens, cache hit/miss). Extend the IPC protocol with a `turn` message type so the host recorder can write `turns/NNN.json`.

**L4**
- Image / resolved mounts / devices / gpu / env: `container-runner.ts:541-580` collects all of this already; recorder writes `container.json` at spawn.
- Exit code / duration: `container-runner.ts:770-909` close handler; recorder updates the same file at exit.
- Resource sampling: optional v2 — child poller calling `docker stats --no-stream` once per second.
- Mount watchpoint violations: derived from L1 artifact diff (writes outside rw mounts).

**Provenance**
- `PipelineRunner` constructor or first `run()` call: read each `agents/*.md` and `templates/*.json`, sha256, write `provenance.json`. Copy `PIPELINE.json` verbatim to `pipeline.snap.json`. Snapshot env whitelist.
- Child PipelineRunners (stitched) skip this — the parent already wrote it.

---

## 5. Migration concerns (the four real issues)

These are the things that must land together in the first PR. Most other concerns from earlier brainstorming are dissolved by the design above (no symlinks → no Windows pain; sealed marker → folder atomicity covered; live runs derived → no `current` race).

1. **`app/server/run-controller.ts:readRunManifests` does its own folder scan with hardcoded `.state/runs` path + `.json` filter.** New layout breaks both the path and the filter (`<runId>` is now a directory). Must be migrated to `run-registry` calls in the same PR.

2. **PipelineRunner currently writes the manifest mid-run** (`pipeline-runner.ts:341, 364, 569, 982`). Since stitched child runners share the parent's runId, parent and child race on the same file. With recorder + events.jsonl: these four sites become `recorder.event(...)` appends, and the race goes away because `events.jsonl` is append-only.

3. **PID-based liveness check** in `app/server/run-controller.ts:findLiveRunningManifest` depends on a mutable `status` field which no longer exists. New rule: `live = !sealed && PID alive`, `crashed = !sealed && PID dead`. Server uses `run-registry.liveRuns()`. Same PR.

4. **`app/server/pipeline-watcher.ts` state-file path**. State files moved from `__art__/PIPELINE_STATE.json` to `runs/<id>/state/PIPELINE_STATE.json`. Watcher needs the new path. Same PR.

Tests for `run-manifest` (`tests/unit/run-manifest.test.ts`) are rewritten alongside.

---

## 6. Phase plan

Each phase is an independent PR. Phases 1 and 2 are behavior-preserving (same outputs, new internal structure). Phase 3 onward introduces new data on disk.

### Phase 1 — Foundation (`run-registry` + `RunRecorder` skeleton, layout migration, logger removal)

Status: **complete on `feat/transparency-foundation`**. Commits `68ae969` (plan doc) → `60d0e5e` (foundation) → `bf2e1c6` (self-review fixes) → `42196f8` (lockstep migration).

- [x] `src/run-registry.ts` with `listRuns / liveRuns / crashedRuns / sealedRuns / findRun`
- [x] `src/run-recorder.ts` with run-dir creation, `event`/`finalize`, sealed marker. `startStage` deferred to Phase 3 (no consumer until L1).
- [x] `runs/<id>/run.json` includes `pid`, `hostname`, `startTime`, `provider`, `args`, `schemaVersion`. `image` dropped — per-stage in this codebase, no single value applies at run level.
- [x] `pipeline-state.ts` path resolver delegated to `RunRecorder`. PipelineRunner now holds `runStateDir = recorder.stateDir()` and all save/load/delete state calls flow through it.
- [x] Removed the four mid-run `writeRunManifest()` calls in `pipeline-runner.ts`. Existing `logger.*` calls at those sites already route to `events.jsonl` via the shim, so no replacement events were needed.
- [x] `summary.json` + `sealed` written at finalize (also on abort)
- [x] `app/server/run-controller.ts` migrated to scan `runs/<id>/` folders and synthesize the legacy `RunManifest` shape from `run.json` + `sealed` + `summary.json`. Status derived: `sealed && summary.outcome` → success/error; alive PID on same host → running; else cancelled.
- [x] `app/server/pipeline-watcher.ts` state path updated. Chokidar watches per-run paths; `read()` picks the latest run folder.
- [~] **`src/logger.ts` replaced by a thin shim** (not deleted). pino + pino-pretty deps removed; `ART_TUI_LOG_DIR` branch removed. The shim keeps the pino-compatible API (`logger.info(obj, msg)`) and routes events to the active recorder + stderr for warn/error/fatal. Functionally equivalent to deleting + migrating every site, but avoids touching ~90 call sites surgically. Documented in §7.
- [x] Migrate every `logger.*` call site to `recorder.event(...)`; for fatal cases, also `console.error(...)` — handled by the shim. Sites unchanged; behavior matches the design.
- [ ] Add the 3 surviving CLI output sites (run start/end one-liners, pre-recorder fatal errors path). Not done — current CLI behavior unchanged. Existing `console.error` paths (e.g. `cli/run.ts:101` for missing `__art__/`) already serve case 2; cases 1 and 3 (run start/end summary line, size-gate prompt) come in Phase 3.
- [x] Remove `ART_TUI_LOG_DIR` branch in engine-setup
- [x] Remove stale `_current.json` doc comment in `run-manifest.ts`. Also pared the file down to `generateRunId` + the in-memory `RunManifest` type; writers removed.
- [x] Tests rewritten for new layout. 400/400 unit tests pass. `run-manifest.test.ts` reduced to `generateRunId` only; `pipeline-runner.test.ts` resume/post-run tests now thread an explicit `runId` and use a new `runStateDir(groupDir, runId)` helper.

**Phase 1 self-review findings** (`bf2e1c6` addressed the first three; the last three are deferred to a follow-up):

- [x] Add `schemaVersion` to run.json / summary.json / events.jsonl records
- [x] Capture `runStartTime` at `run()` entry instead of construct time
- [x] Drop `image` from `run.json`; add `args` (process.argv.slice(2))
- [ ] PipelineRunner constructor has filesystem side effects (creates run dir). Move to an explicit `start()` step.
- [ ] Process-global recorder hook (`setActiveRecorder` / `getActiveRecorder`) is fragile — invariant ("one active at a time") is implicit. Consider explicit DI through the constructor.
- [ ] Logger shim has no LOG_LEVEL filtering — `debug` events always archived. Add filtering by `process.env.LOG_LEVEL`.

### Phase 2 — Stream sink migration (no new data, just relocation)

- [ ] Per-stage `agent.stream.log` / `stdout.log` / `stderr.log` replace the single pipeline log file
- [ ] `container-runner.ts` per-container log files deleted
- [ ] Existing scattered `logger.info(...)` "what happened" sites also emit `recorder.event(...)`

### Phase 3 — L1 stage I/O

Status: **base subset done**. Per-stage I/O records written at `runs/<id>/nodes/<n>/stages/<s>/`. Artifact diff + size gate deferred (significant new infrastructure: shadow git, host requirement on git binary).

- [x] Capture `promptSource` (path + sha256) and `resolvedSystemPrompt`. Full text in `prompt.txt`; sha256 in `stage.json.inputHashes.prompt`. `promptSource` written to a sibling `prompt.source` file containing either `agents/<name>.md` (resolved from a ref) or `inline`.
- [x] Capture `initialPrompt` / `ephemeralSystemPrompt` from `buildPayloadHandoff` → `initial.txt`
- [x] Capture `substitutions` map. `substitutions.json` carries `insertId`/`index`/`invocationId`/`parentNodeId`/`localName` plus the full per-lane substitution map under `substitutions` (insertId, index, plus any `countFrom: 'payload'` fields). Stitch baking populates `PipelineStageDispatch.substitutions` so the record is complete.
- [x] Capture `resolvedCommand`. Full command written to `command.sh`; sha256 in `stage.json.inputHashes.command`. `shell` / `timeout` / `env` snapshot in a sibling `command.json`.
- [x] Artifact diff per writeable mount:
  - [x] At stage start, hardlink-copy each rw mount into `runs/<id>/nodes/<n>/stages/<s>/.pre/` via `cp -al`
  - [x] At stage end, `git diff --no-index --no-color` against current rw mount → save unified diff to `diff/<mount>.diff` plus `diff/summary.json` (`{mount, changed, bytes}` per mount)
  - [x] Remove `.pre/` snapshot after diff is written (always, even on failure paths)
  - [x] Add `git`, `cp -l`, `du -sb` to host requirements doc
  - [x] Scoped to top-level `mounts: { <key>: "rw" }` entries only. `project` mount and sub-path mounts excluded for v1 (project can be huge; sub-paths complicate snapshot semantics).
  - [x] Best-effort throughout. Missing binaries or any individual cp/git failure logs a single line via `console.error` and silently disables diff for the run; no abort. `ART_NO_DIFF=1` or `--no-diff` opts out explicitly.
- [x] **`art run` size gate (pre-flight)**: at startup, before any stage runs, `du -sb` each rw mount key referenced by any stage. If any exceeds the threshold (`ART_DIFF_SIZE_LIMIT`, default `1G`; accepts `500M`, `2G`, `2GiB`, …), emit the warning per mount to stderr and prompt:
  ```
  Continue? [y/N]
  ```
  `--yes` / `-y`, `CI=1`, or non-TTY stdin skip the prompt (warning still emitted). `--no-diff` skips the gate entirely.
- [x] Capture matched marker, payload, selected transition index, retry count, container exit code. `stage.json` carries `matchedMarker`, `transitionTarget`, `payloadLen`, `durationMs`, `result`, `retryCount`, `exitCode`. `ContainerOutput` was extended with `exitCode` + `durationMs` so the close handler propagates the kernel exit code up to the recorder.
- [x] Stitch invocation event in `events.jsonl`. `recorder.event({ type: 'stitch.invoked', ... })` emitted when a stage triggers a template stitch; carries template, joinPolicy, child count, child node ids.

### Phase 2 — Stream sink migration (deferred)

Per-stage `agent.stream.log` / `stdout.log` / `stderr.log` and removal of `container-runner.ts` per-container log files: **deferred**. The pipeline-watcher UI live-tail tails the legacy `pipeline-{ts}.log`; migrating cleanly requires the watcher to switch to per-stage files in lockstep. Defer until UI redesign needs it or per-stage tailing becomes a request.

### Phase 4 — L2 decision logs + IPC mirror

- [ ] `parseStageMarkers` returns candidate set; recorder writes `decisions.jsonl`
- [ ] No-match feedback events
- [ ] Barrier evaluation events with `{ joinPolicy, settlements, outcome }`
- [ ] Container retry events
- [ ] IPC mirror in `nodes/<n>/stages/<s>/ipc/`

### Phase 5 — L3 provider / turn details

- [ ] IPC protocol extension: `turn` message type
- [ ] `claude-engine.ts` emits per-turn `{ tokensIn, tokensOut, cacheHit, model, latencyMs, finishReason }`
- [ ] `codex-engine.ts` emits the same shape
- [ ] Recorder writes `turns/NNN.json`
- [ ] OAuth refresh + auth diagnostic events extend the work in `05c837a` / `0cf3a5a`

### Phase 6 — L4 container + provenance

- [ ] `container.json` per stage with image, resolved mounts, devices, gpu, env, exit code, duration
- [ ] `provenance.json` + `pipeline.snap.json` at run start
- [ ] Mount-watchpoint violations array populated from L1 diff

### Phase 7 — Retention + inspect

- [ ] Background retention sweep (config; default keep 10 sealed)
- [ ] Optional gzip of heavy files on sealed runs
- [ ] `art inspect <runId>` CLI: print events.jsonl as a readable timeline; dovetail stage stream excerpts at the right moments

---

## 7. Design decisions log

- L1 prompt/command storage uses **hash-in-record + full-text-on-disk** so records stay compact while preserving reproducibility.
- "Prompt" in an L1 record means the *opening* package only; subsequent feedback / retry prompts during the same stage execution belong in L2 decision logs.
- Run state is **derived from PID + sealed marker**, not stored. No mutable `status` field anywhere.
- The "current run" concept is replaced by **live runs (plural)**, scanned at query time. No pointer files, no symlinks.
- Stitched child `PipelineRunner` instances **share the parent's `RunRecorder`**; the run directory is owned by the parent.
- `events.jsonl` is the single source of truth for run-wide timeline. Per-stage decisions are denormalized into `decisions.jsonl` for ergonomics.
- **Artifact diff**: ephemeral pre-state snapshot via hardlink-copy + `git diff --no-index`, snapshot discarded at stage end. Pre-state is *not* preserved beyond stage runtime. Rationale: computing a diff inherently requires pre-state to exist *during* the stage; preserving it longer (e.g. via persistent shadow git) adds dedup wins but also persistent disk cost, and the typical use case is "what did this stage change", not "let me reconstruct the state at stage 3 a week later". Hardlinks make the snapshot near-free when the stage touches few files; copy-on-write only kicks in for actually-modified files.
- **Size gate**: `art run` warns and prompts when any rw mount exceeds 1 GiB (configurable). Rationale: the hardlink snapshot is cheap for the *unchanged* portion but the modified portion costs full disk; for a multi-GB rw mount that the stage substantially rewrites, the temporary space can be surprising. The gate puts that cost in front of the user before stage 0 starts, not mid-run.
- **Recorder write-failure policy is criticality-tiered.** Today, `savePipelineState` and `writeRunManifest` throw on write failure and the exception propagates up — most callers have no try/catch, so a disk-full crashes the run. Atomic write (tmp + rename) prevents corruption but no recovery. New policy preserves "fail fast on integrity, best-effort on telemetry":

  | Write | On failure |
  | ----- | ---------- |
  | Run dir creation, `run.json` initial write | Throw / crash (cannot proceed) |
  | `state/PIPELINE_STATE.json` save | Throw / crash (matches today's behavior — integrity > continuity) |
  | `events.jsonl` / `decisions.jsonl` append | `console.error(...)` once, continue (lost line is telemetry, not state) |
  | Stream sinks (`agent.stream.log`, `stdout.log`, `stderr.log`) | Same: log once, continue |
  | `summary.json` + `sealed` at finalize | Best-effort. `console.error(...)` if it fails; the work itself is already done |

  Without this tiering, naive "throw everywhere" makes a single failed event-log line kill the run; naive "swallow everywhere" lets state-file corruption go silent.

- Visualization is deferred. Once the data is stable, any UI can read from `runs/<id>/`.

---

## 8. Open questions

- [ ] Retention policy default: keep last N runs (e.g. 10), bound by disk size, or both?
- [ ] Redaction: prompts can include user secrets via env. Do we need a redaction pass before persisting, or rely on the env whitelist in provenance?
- [x] Schema versioning: each record carries `schemaVersion`. **Decision** (committed in `bf2e1c6`): start at `1`; readers refuse unknown versions (hard fail on mismatch). Bump on any incompatible shape change.
- [ ] PID start-time tracking to defeat reuse: defer to v2 unless a real false-positive is observed?
- [ ] Per-mount opt-out of diff tracking (`mounts: { foo: { mode: "rw", track: false } }`): worth designing now, or defer until users ask?
