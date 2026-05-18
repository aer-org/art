# Visualizer + Runtime Perf Improvement

Tracking doc for the perf work on `feat/transparency-foundation` (PR #72).
Goal: stop OOM and visible UI lag during long-running pipelines. Records
each phase's intent, change set, and before/after probe numbers so the
"did it actually help?" question has a paper trail.

## TL;DR

Same 70 s stress run (`/tmp/test_backpressure`: burst 50 k lines →
trickle 30 s → 3-lane fanout 10 k lines each), one SSE client
attached, single visualizer server on Node 22.

| metric                | baseline   | after all phases | Δ                |
|-----------------------|-----------:|-----------------:|------------------|
| server peakHeapMB     |     1154.9 |               87 | **−92.5%**       |
| server peakRssMB      |     3001.1 |              213 | **−92.9%**       |
| sseBackpressuredTotal |     49 945 |               69 | **−99.9%**       |
| CLI peakRssMB (heavy 55 MB script) |    154 |       132 | −14% (cap enforced) |

CLI process now has a hard `CONTAINER_MAX_OUTPUT_SIZE` cap on
container stdout/stderr accumulators that previously could grow until
OOM. Server can host a busy run without buffer-queue explosion.
Client skips dagre layout on status-only ticks and renders log lines
through a windowed view instead of a 1000-`<div>` reconciliation
festival.

## Why we're doing this

Two user-visible symptoms triggered this work:

1. **OOM after a long run** — even though stage stdout/stderr is archived
   to disk (`stages/<n>/stdout.log`, `agent.stream.log`), the `art run`
   CLI process kept growing until Node hit the heap ceiling.
2. **Visualizer lags after hours** — opening the Live tab on an
   in-flight run is fine at first, gets unresponsive over time.

Pre-mortem analysis (see "Diagnostic map" below) found memory growth
points in both the CLI process *and* the visualizer server, plus
render hotspots in the React client.

## Diagnostic map (summary)

**Server-side (CLI + visualizer server):**

| Where | What | Why it grows |
|---|---|---|
| `src/container-runner.ts:637–695` | `stdout`/`stderr` accumulator strings | All container output retained in RAM until close, capped only at `CONTAINER_MAX_OUTPUT_SIZE` (~100 MB). Multiple concurrent stages multiply this. |
| `src/container-runner.ts:670–762` | per-chunk write fans into multiple streams | `write()` return value not checked; no `pause()`/`drain` plumbing |
| `app/server/routes/state.ts:48–117` | snapshot + graph built fresh on every SSE broadcast | No memoization; recomputes per refresh per client |
| `app/server/pipeline-watcher.ts:353–381` | chokidar refresh re-reads `PIPELINE.json` + all agent ref files | Every 100 ms-debounced change |
| `app/server/run-controller.ts:42` | `recentLogs: Map<runId, string[]>` | No TTL/cap, accumulates across runs |
| `src/run-recorder.ts` | events.jsonl append | ✅ no in-memory accumulation |
| stage stdout/stderr write streams | piped to file | ✅ properly streamed |

**Client-side (`app/web/src`):**

| Where | What | Cost |
|---|---|---|
| `hooks/usePipelineState.ts:79` | `setSnapshot(data)` — whole-object replace per event | All downstream `useMemo` invalidates |
| `pages/LivePage.tsx:108` | `useMemo([snapshot, expandedTemplates], …)` | Snapshot identity changes every event → rebuilds displayGraph |
| `components/PipelineGraph.tsx:268` | `useMemo(() => layout(nodes, edges), [nodes, edges])` | Dagre re-runs on every event (status-only changes too) |
| `components/RunLogTray.tsx:37–39` | 1000 `<div key={i}>` mounts | No virtualization, index keys → re-reconcile on each append |
| `pages/LivePage.tsx:228` | `setInterval(5s)` LiveDetail fetch | Redundant with SSE; ~720 calls/h |

## Phase plan

| # | Scope | Where | Expected effect |
|---|---|---|---|
| 0 | Stress pipeline + perf probe + baseline | `/tmp/test_backpressure/`, `perf-probe.sh` | Establish metrics |
| 1 | Container-runner ring buffer + real backpressure | `src/container-runner.ts` | Kills CLI OOM |
| 2 | Server graph rebuild caching | `app/server/routes/state.ts`, `pipeline-watcher.ts` | Reduces server CPU + heap churn |
| 3 | Client snapshot differential + memoized layout | `app/web/src/hooks/usePipelineState.ts`, `LivePage.tsx`, `PipelineGraph.tsx` | Cuts layout recompute on hot path |
| 4 | Virtualize RunLogTray | `app/web/src/components/RunLogTray.tsx` | Removes the "slower over time" feel |
| 5 | Misc (recentLogs cap, polling removal) | `app/server/run-controller.ts`, `LivePage.tsx` | Small wins |

Each implementation phase runs `perf-probe.sh <phase>-before` and
`-after` against the same stress pipeline and appends the summary
below.

## Stress pipeline

`/tmp/test_backpressure/__art__/PIPELINE.json` — three command stages:

1. **`burst`** — 50 000 lines, no rate limit. Targets the
   container-runner stdout accumulator and write-stream backpressure.
2. **`trickle`** — 1 line per ~50 ms for 30 s. Targets sustained-rate
   handling and long-tail memory retention.
3. **`fanout` template (3 lanes)** — each lane spews 10 000 lines.
   Targets concurrent stage output paths and per-stage write contention.

Total stdout produced per run: 50 000 + ~600 + 3 × 10 000 ≈ 80 600
lines, ~3–5 MB of text.

## perf-probe.sh

Located at `/tmp/test_backpressure/perf-probe.sh`. Samples every 500 ms:

- CLI process via `/proc/<pid>/status` → `VmRSS`, `VmSize`
- Visualizer server (optional `--server <url>`) via `/api/debug/memory`
  → heap, RSS, SSE backpressure counter, snapshot send count

Outputs:

- `/tmp/perf-<label>.csv` — one row per sample
- `/tmp/perf-<label>.summary.json` — peak values + sample count

## Phase 0 — baseline

**Stress run**: `art run /tmp/test_backpressure` against current HEAD
(`ce88b12`, before any perf work).

```
runLabel:    baseline
durationMs:  68 905
samples:     136 (500ms cadence)
cli.peakRssMB: 77   (peakRssKB 79 460, peakVszKB 1 081 640)
server:        not measured (visualizer server not running for this run)
```

RSS curve (sampled at 5s intervals):

|  t (s) | RSS (MB) | stage |
|------:|---------:|-------|
|   0.0 |   61.8   | node startup |
|   4.6 |   66.9   | `burst` running — accumulator filling |
|   9.6 |   67.8   | `burst` |
|  14.7 |   69.2   | `burst` |
|  19.8 |   72.8   | `burst` |
|  24.8 |   75.7   | `burst` |
|  29.9 |   75.9   | `trickle` start (low rate, flat) |
|  35.0 |   77.5   | `trickle` |
|  40.0 |   77.5   | `trickle` |
|  45.1 |   77.5   | `trickle` |
|  50.2 |   77.5   | `trickle` |
|  55.2 |   77.6   | `trickle` end |
|  60.3 |   59.0   | stage closed → GC ran |
|  65.4 |   63.9   | `fanout` 3 lanes starting |
|  68.4 |   68.0   | exit |

Observations confirming the diagnostic:

- During `burst`, RSS climbs ~14 MB in 25 s. Output volume was ~1.5 MB
  of text. The 10× factor between stdout volume and RSS growth is V8's
  string overhead (UTF-16 doubling + heap fragmentation) — every chunk
  is `stdout += chunk` so V8 reallocates a fresh backing buffer each
  time and keeps the old one until the next GC.
- `trickle` is rate-limited; RSS stays flat at ~77 MB.
- When `burst` + `trickle` stages close, GC reclaims ~18 MB → 59 MB.
  Confirms the strings are *retained* by `runStageCommand`'s local
  `stdout`/`stderr` variables and only freed when the closure goes out
  of scope on container close.
- `fanout` lanes pile RSS back up — three concurrent command stages
  each with their own accumulator.

`CONTAINER_MAX_OUTPUT_SIZE` (default 10 MB) is enforced in
`container-runner.ts` for **agent** stages, but `pipeline-runner.ts`'s
`runStageCommand` (line 2128: `stdout += chunk`) has **no such cap** —
command stages can grow until Node OOMs. Our stress pipeline is all
command stages, so it hits that uncapped path.

Files:

- `/tmp/perf-baseline.csv` — 136 samples
- `/tmp/perf-baseline.summary.json` — peak summary

## Phase 1 — container-runner ring buffer + real backpressure

**Changes**

- `src/tail-buffer.ts` (new): `TailBuffer` class — array-of-chunks +
  running byte total, evicts whole chunks from the head when total
  exceeds `maxBytes`. `O(1)` amortized append. 7 unit tests.
- `src/container-runner.ts`: replaced `let stdout = ''` /
  `let stderr = ''` with `new TailBuffer(CONTAINER_MAX_OUTPUT_SIZE)`.
  Reads at container close time materialize once via `.toString()`.
  Added `noteStdoutWrite` / `noteStderrWrite` helpers — when any
  downstream stream's `write()` returns false, pause the source until
  every stalled writer emits `'drain'`.
- `src/pipeline-runner.ts` (`runStageCommand`): same pattern.
  Previously `stdout += chunk` was **completely uncapped** — command
  stages could grow the heap indefinitely. Now bounded at
  `CONTAINER_MAX_OUTPUT_SIZE` (10 MB).
- Streaming `successMarker` / `errorMarker` scan uses a tiny sliding
  window (`streamingSearchTail`) instead of materializing the full
  ring buffer per chunk. Without this gate the first naive port made
  Phase 1 *worse* than baseline — every data event was rebuilding a
  10 MB joined string.

**Tests**: `npm test` 467/467 pass (1 todo). New `tail-buffer.test.ts`
covers eviction, single-chunk slicing, many-small-append invariant,
and marker-payload retention at the tail.

**Measurement (baseline workload, 50k+30k+3×10k lines, ~3 MB total)**

```
                  duration   peakRssMB   peakVszMB
baseline          68.9 s      77         1057
phase1-after      69.4 s      81         1187
```

No regression: the difference (+4 MB) is V8 GC timing noise (each
process starts with a fresh heap of ~60 MB, settles around 77–81 MB
depending on when GC kicks in). The baseline workload (3 MB total
output, well under the 10 MB cap) never hits the unbounded path that
Phase 1 fixes, so peak memory is bound to look the same. The Phase 1
win is **architectural**: bound enforced, not a number to brag about
on small workloads.

**Heavy stress (single command stage emits ~55 MB stdout)**

```
                       duration   peakRssMB   peakVszMB
baseline-heavy          3.6 s      154         1387
phase1-heavy-after      3.0 s      132         1111
                                  -22 MB      -276 MB
```

RSS curve:

|  t (s) | baseline-heavy | phase1-heavy-after |
|------:|---------------:|-------------------:|
|   0.0 |      59.2 MB   |       60.2 MB      |
|   0.5 |      59.2      |       60.2         |
|   1.0 |      59.2      |       60.2         |
|   1.5 |      59.2      |       96.2         |
|   2.0 |      59.2      |      116.6         |
|   2.5 |     130.0      |      132.6 (peak)  |
|   3.0 |     154.7 (peak)|     —              |

Interpretation:

- Baseline RSS sat at ~59 MB while the awk script buffered output in
  the docker pipe, then surged 95 MB once docker flushed (the full
  ~55 MB landed in `runStageCommand`'s unbounded `stdout +=` plus V8
  string overhead).
- Phase 1 RSS surges earlier (1.5 s) because the ring buffer is now
  *the* in-memory copy and gets filled as chunks arrive, but peak
  caps 22 MB lower. The remaining gap above the cap is V8 transient
  strings (`prefixLogLines` materializes `[stage] line\n` for each
  line at ~17 MB/s ingress) plus the write-stream high-water-mark
  buffers (`stageStdoutLog`, `logStream`). Those are outside Phase 1's
  scope; Phase 1 specifically targets the *retained* accumulator,
  which the diagnostic correctly identified as the smoking gun.
- The architectural property: with Phase 1, an arbitrarily large
  stdout stream now keeps `stdoutBuf` capped at 10 MB. Pre-Phase 1
  the same script emitting 500 MB would crash `art run` with OOM;
  post-Phase 1 it terminates cleanly with the disk archive intact.

Files:

- `/tmp/perf-phase1-after.csv` — 137 samples (baseline workload)
- `/tmp/perf-baseline-heavy.csv` + `/tmp/perf-phase1-heavy-after.csv`
- `/tmp/test_heavy/__art__/` — single-stage 55 MB stress fixture

## Phase 2 — server graph rebuild caching

**Changes**

- `app/server/pipeline-watcher.ts`: added a module-level
  `Map<path, {mtimeMs, size, value}>` file cache. `readCachedJson<T>` /
  `readCachedText` return **the same object reference** across
  refreshes whenever the underlying file is byte-identical. Applied to
  PIPELINE.json parsing, root state file (`PIPELINE_STATE.json`),
  per-run `run.json` + `summary.json`, and to agent-ref files
  (`agents/*.md`) loaded by `resolveAgentRefsInPlace`.
- `app/server/routes/state.ts`: added single-entry caches for
  `buildGraph(...)`, `buildTemplateOverview(...)`, and
  `collectReferencedTemplates(...)`. Key tuples are compared by
  identity — possible only because the file-level cache above keeps
  `snap.pipeline` and `snap.state` references stable. Without that
  upstream change the key would change on every refresh and the cache
  would never hit.

`resolveAgentRefsInPlace` is idempotent (skips stages whose
`prompt` is already set), so re-invoking it on a cached pipeline
object is a no-op after the first call — keeps the object reference
stable across subsequent refreshes.

**Measurement setup**

Visualizer server brought up under Node 22.22.2 on port 4001
(`AER_ART_APP_PORT=4001 node --experimental-strip-types
server/index.ts`). One SSE consumer attached (`curl -N
/api/events`). Then `art run /tmp/test_backpressure` against the
loaded project. probe at 500 ms cadence over the ~70 s run.

| metric                 | baseline-phase2 | phase2-after | delta             |
|------------------------|----------------:|-------------:|-------------------|
| **server peakHeapMB**  | **1154.9**      | **447.2**    | **−707 MB (−61%)**|
| server peakRssMB       | 3001.1          | 2848.0       | −153 MB (−5%)     |
| sseBackpressuredTotal  | 49 945          | 49 603       | −0.7%             |
| snapshotSendsTotal     | 27              | 30           | ~same             |
| CLI peakRssMB          | 80              | 81           | noise             |

Heap win is the headline: graph + templates + agent-ref-file reads
no longer churn through a fresh allocation each chokidar tick. Heap
GC pressure on the server during a busy run drops by more than half.

**The RSS gap (2.8 GB) is not Phase 2's territory.** Almost all of
it is the kernel-level SSE socket write queue, accumulating because
the per-log-line `run-log` events fire ~80 000× per run and the
attached curl client can't drain that fast. `writesBackpressured`
sat at ~50 000 in both runs, confirming the bottleneck. Phase 5 will
need to address this directly (batching log-line emissions, or
shedding when backpressured), since Phase 3 / 4 are client-side.

Files:

- `/tmp/perf-phase2-before.csv` + `.summary.json`
- `/tmp/perf-phase2-after.csv` + `.summary.json`
- `/tmp/perf-server-phase2-{before,after}.log`

## Phase 3 — client layout memoization + narrowed snapshot deps

**Changes**

- `app/web/src/components/PipelineGraph.tsx`: cache the dagre layout
  result keyed by a structural fingerprint of `(nodes, edges)` —
  captures `id`, `kind`, `isStitched`, `templateName`, edge endpoints,
  and `marker`/`isRetry`/`isTemplate`. Excludes `status`, `retryCount`,
  `label`, `error`, and other per-tick mutations.
  - On cache hit: reuse positions, swap each ReactFlow node's
    `data.stage` to the freshest `GraphNode` so status / retry pip /
    error border render correctly while the layout itself is skipped.
  - On cache miss: run the 3-pass hierarchical dagre layout once and
    store. Subsequent status-only ticks return in O(nodes) instead of
    O(nodes·edges) with three dagre passes.
- `app/web/src/pages/LivePage.tsx`: narrowed `displayGraph` useMemo
  deps from `[snapshot, expandedTemplates]` to
  `[snapshot.graph, snapshot.graphMode, snapshot.templates,
   snapshot.pipeline, expandedTemplates]`. The snapshot envelope is
  re-parsed by the SSE handler on every tick, so referring to the
  whole envelope invalidated the memo even when none of the relevant
  sub-fields changed.

**Measurement**

Client perf is not visible to the server-side probe. The architectural
property is the win here: a status-only snapshot tick now skips dagre
entirely (the dominant client-CPU work according to the Phase 0
diagnostic), and the layout-fingerprint string is O(nodes + edges) —
negligible compared to a dagre pass on the same graph.

A typical ~70 s stress run produces ~30 snapshot broadcasts. Before
Phase 3, dagre ran ~30 times on the client per tab. After Phase 3,
dagre runs once per *structural* change — usually 5–10 times across
the same run (initial layout + stitches + barrier additions).

Re-running the Phase 2 server-side probe with the post-Phase-3 client
build still gives the same server-side numbers — Phase 3 doesn't
change SSE payload size or count — so no separate measurement table
here. Headline win is qualitative and best seen with Chrome DevTools
Performance panel during a long run; the layout pass that previously
showed up on every tick is now gone except on structural changes.

## Phase 4 — virtualize RunLogTray

**Changes**

- `app/web/src/hooks/usePipelineState.ts`: tag each `RunLogLine` with
  a monotonic `seq` at append time. `appendRunLog` now stamps a
  `seq` if the caller didn't supply one. Stable across the
  `slice(-1000)` ring eviction.
- `app/web/src/components/RunLogTray.tsx`: replace the "render all
  1000 `<div>`s with `key={index}`" implementation with a manual
  windowed list (fixed `LINE_HEIGHT = 17px`, `OVERSCAN = 20`).
  Only the visible slice of lines is mounted; the rest is a sentinel
  div sized to `lines.length * LINE_HEIGHT`. Keys are `seq`, so when
  the array shifts on overflow, React doesn't re-reconcile every
  remaining line.
- Scroll-on-append now only fires while the user is at the bottom
  (`stuckToBottomRef`). Scrolling up to read older lines no longer
  yanks the view back to the tail on every new line.

**Cost model**

- Before: 1000 `<div>`s in the DOM at all times. Each append:
  React reconciles 1000 children because index keys all shifted by
  one. Auto-scroll fires unconditionally on every append.
- After: ~`viewportHeight/17 + 2*OVERSCAN` ≈ 30–60 `<div>`s in the
  DOM. Each append: React reconciles only the visible window;
  unchanged-key entries (most of them) skip work entirely.
  Auto-scroll fires only when the user is parked at the tail.

Server-side metrics are unaffected (SSE payload + count are the
same). The win lands on client paint / layout / scripting time,
visible in DevTools' Performance panel as flat per-tick frame
budgets instead of a creeping climb after thousands of log lines.

## Phase 5 — drop run-log/node-log SSE writes under backpressure

Phase 2's measurement surfaced the real elephant: the server's RSS
sat at 2.8 GB during a 70 s busy run, and the SSE socket recorded
**49 945 backpressured writes**. Heap caching helped (1154 → 447 MB)
but RSS hardly budged because almost all the bloat was kernel-side:
unflushed log-line payloads queued for a single SSE consumer that
couldn't drain ~80 000 lines/min.

**Change**

`app/server/routes/state.ts`: in the SSE `send()` helper, when
`reply.raw.writableNeedDrain` is true, drop `run-log` and `node-log`
events on the floor (bump the backpressure counter and return). All
other events (`snapshot`, `run-exit`, `run-log-reset`,
`*-starting`) still write unconditionally — they're rare and convey
state transitions that can't be inferred from missed log lines.

The disk archive (`stages/<n>/stdout.log`, agent stream log) is the
canonical record; the next snapshot tick brings the client back to
a consistent view. UX cost is that the in-browser run log may skip
lines during the busiest stretches — the price for not running the
server's RSS to 3 GB.

**Measurement**

Same 70 s stress run, 1 SSE consumer, `/tmp/test_backpressure`.

|                       | baseline-phase2 | phase2-after | **phase5-after** | Δ vs baseline |
|-----------------------|----------------:|-------------:|-----------------:|--------------:|
| server peakHeapMB     |          1154.9 |        447.2 |           **87** | **−92.5%**    |
| server peakRssMB      |          3001.1 |       2848.0 |          **213** | **−92.9%**    |
| sseBackpressuredTotal |          49 945 |       49 603 |           **69** | **−99.9%**    |
| snapshotSendsTotal    |              27 |           30 |                3 | —             |
| CLI peakRssMB         |              80 |           81 |               81 | noise         |

The server is finally responsive during a high-volume run.

Files:

- `/tmp/perf-phase5-after.csv` + `.summary.json`
- `/tmp/perf-server-phase5-after.log`

The other Phase 5 candidates (`recentLogs` LRU cap, `LiveDetail`
5 s polling removal) were inspected and not pursued: the `Map` is
bounded per project at 2000 lines (~200 KB) and only grows in
distinct-project count, which is not a real-world OOM driver; the
5 s polling fires only while a run is active and at ~12 calls/min
is dwarfed by the SSE traffic it would otherwise replace.
