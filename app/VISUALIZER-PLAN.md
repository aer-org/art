# Visualizer Plan — Transparency UI

Surface the per-run data the runtime now writes under `__art__/.state/runs/<runId>/` (see `docs/TRANSPARENCY-PLAN.md`) inside the existing `app/` debug UI. Live monitoring stays; historical inspection is new.

Status legend: `[ ]` not started, `[~]` in progress, `[x]` done.

---

## 1. Architecture decision

- Mermaid-feel graph: stays on **ReactFlow + dagre** (already in use in `web/src/components/PipelineGraph.tsx`). No mermaid library swap.
- Server data access: **mirror** the read helpers in `app/server/run-reader.ts` rather than importing `src/run-registry.ts` directly (separate package boundary preserved). ~100 line cost.
- Routing: hash routing in the React app. `/` = live (current), `/runs` = list, `/runs/<runId>` = detail, `/runs/<runId>/stages/<nodeId>/<stageName>` = stage drill.
- Live vs sealed: same UI, different data freshness — sealed = static, live = 5s polling, no SSE for the new views in v1.
- Diff rendering: `react-diff-view` (~30KB gzipped) for unified-diff display.

---

## 2. Information hierarchy (4 levels)

Each level represents one user action's worth of drilldown. Higher levels stay visible while a lower level opens, so context is preserved.

### L0 — Canvas (no interaction)

What's shown without clicking anything.

- [ ] Top bar: runId, provider, state chip (live/crashed/sealed), outcome chip, duration, total cost
- [ ] Stage nodes: name, kind icon (● agent / ▢ command), state color (gray pending / blue running / green success / red error / yellow crashed), retry pip if `retryCount > 0`
- [ ] Edges: marker label, outcome style (solid success, dashed red error)
- [ ] Stitch groups: dashed box + template name + lane count + joinPolicy; auto-expanded if ≤3 lanes else collapsed
- [ ] Bottom status bar: current active stages, last decision-event summary line

Data sources: `run.json`, `summary.json`, `state/PIPELINE_STATE.json`, `PIPELINE.json`, `events.jsonl` (latest stitch.invoked).

### L1 — Hover (preview only, no panel)

Lightweight tooltips. Sidebar does not open.

- [ ] Stage hover: duration, exit code (only if ≠0), retry count (only if >0), matched marker
- [ ] Edge hover: marker, transition next, count/joinPolicy if template
- [ ] Stitch group hover: per-lane mini-bar of states
- [ ] Top-bar provider hover: model, total tokens, total cost

### L2 — Click stage → sidebar slides in

Right-side 35–40% width panel; grid push, not overlay. Accordion sections, all visible at once.

#### Section: Input (default open)

- [ ] Prompt source label (`agents/build.md` or `inline`) with sha256 prefix
- [ ] Substitutions table (`{insertId, index, ...payload}`)
- [ ] Initial prompt: first 200 chars + "View full" → L3
- [ ] Command (command-mode stages only): first line + "View command" → L3
- [ ] Container summary: image + mount counts (ro/rw) + "View mounts" → L3

#### Section: Output

- [ ] Outcome chip (success/error)
- [ ] Matched marker
- [ ] Transition target (clickable → highlight that node in graph)
- [ ] Duration, exit code, retry count
- [ ] Diff summary per mount (`src: 12 added, 3 modified`) + "View diff" → L3
- [ ] Payload length + "View payload" → L3 (if non-empty)

#### Section: Internal

- [ ] Turn count + aggregate (`5 turns, 12.4k tokens, 8.2s, $0.04`) + "View turns" → L3
- [ ] Decision count by type (`marker: 5, no-match: 2, retry: 1`) + "View decisions" → L3
- [ ] Stream sizes (`agent.stream.log: 23KB`) + "View stream" → L3

Data sources: `stage.json`, `prompt.source`, `substitutions.json`, `initial.txt` (first chunk), `command.sh`+`command.json` (first chunk), `container.json` (summary), `diff/summary.json`, decisions filtered from `events.jsonl`, `turns/NNN.json` (aggregate only).

### L3 — Click in sidebar → second slide panel pushes from right of sidebar

Viewport-half width. Sidebar stays visible (context).

- [ ] **View prompt**: full `prompt.txt` text + sha256, Copy + Search
- [ ] **View initial**: full `initial.txt` (initial + ephemeral split)
- [ ] **View command**: `command.sh` + `command.json` (shell/timeout/env)
- [ ] **View mounts**: `container.json` mount table (host→container, ro/rw)
- [ ] **View diff**: mount selector → unified diff with `react-diff-view`, side-by-side toggle
- [ ] **View turns**: table `# | model | in | out | cache | latency | cost | finishReason`, row click → full meta JSON
- [ ] **View decisions**: filterable list by type, row click → JSON detail
- [ ] **View stream**: tail viewer with auto-scroll, kind toggle (agent/stdout/stderr), tail size slider
- [ ] **View payload**: text/JSON preview (auto-detect)
- [ ] **View retries**: attempt-by-attempt list with reason

### L4 — Run-level overlays (panel from right, doesn't conflict with L2/L3)

- [ ] **Run info**: provenance.json (agents/templates sha256 + env), pipeline.snap.json link, duration breakdown
- [ ] **Timeline view (Gantt)**: x = time, y = stage. Stage bars + decision markers. Click bar → sidebar for that stage.
- [ ] **Decisions list (cross-stage)**: filterable across the whole run, stage click → sidebar
- [ ] **Cost view**: per-stage cost stack chart from `turns/*.json`
- [ ] **Events raw**: developer-only escape hatch — `events.jsonl` tail viewer

---

## 3. UX principles (lock these before coding)

- [x] **Progressive disclosure**: L0 is just the graph + state. Each click goes exactly one level deeper.
- [x] **Push, don't overlay**: sidebar and L3 panel grid-push the canvas; no modal that hides the graph.
- [x] **Hash always**: when displaying prompt/command/initial, show sha256 prefix (8 chars) — same prompt twice is instantly comparable.
- [x] **Sync policy**: live run → L0/L2 poll every 5s. L3 is static at open time, manual refresh button.
- [x] **Empty states are explicit**: "No turns recorded (command mode)" not a blank box.
- [x] **Linkback**: any cross-reference in L3 (decision's stageName, transition target) is clickable → sidebar jumps.

---

## 4. Server endpoints (new, read-only, additive)

`app/server/routes/runs.ts` (new file). Existing routes untouched.

- [ ] `GET /api/runs` → list of `RunHeader` (state, outcome, duration, stages summary)
- [ ] `GET /api/runs/:runId` → `run.json` + `summary.json` + dispatch tree summary + stage index
- [ ] `GET /api/runs/:runId/events?type=&limit=` → events.jsonl (paginated/filtered)
- [ ] `GET /api/runs/:runId/stages/:nodeId/:stageName` → `stage.json` + `container.json` summary + file inventory
- [ ] `GET /api/runs/:runId/stages/:nodeId/:stageName/prompt` → raw `prompt.txt`
- [ ] `GET /api/runs/:runId/stages/:nodeId/:stageName/initial` → raw `initial.txt`
- [ ] `GET /api/runs/:runId/stages/:nodeId/:stageName/command` → `command.sh` + `command.json`
- [ ] `GET /api/runs/:runId/stages/:nodeId/:stageName/diff` → list of mounts with diff
- [ ] `GET /api/runs/:runId/stages/:nodeId/:stageName/diff/:mount` → unified diff
- [ ] `GET /api/runs/:runId/stages/:nodeId/:stageName/turns` → array of `turns/NNN.json`
- [ ] `GET /api/runs/:runId/stages/:nodeId/:stageName/stream?kind=agent|stdout|stderr&tail=500` → log tail
- [ ] `GET /api/runs/:runId/provenance` → `provenance.json`
- [ ] `GET /api/runs/:runId/pipeline-snap` → `pipeline.snap.json`

Supporting:
- [ ] `app/server/run-reader.ts` — file-system read helpers (mirror what `src/run-registry.ts` does for the new shape, kept in this package).

---

## 5. Frontend additions

```
web/src/
├── pages/
│   ├── LivePage.tsx          [~] rename of existing App body
│   ├── RunsListPage.tsx      [ ]
│   └── RunDetailPage.tsx     [ ]
├── components/
│   ├── (existing kept)
│   ├── RunTable.tsx                [ ]
│   ├── StageSidebar.tsx            [ ] L2 — replaces the old NodeModal for run detail view
│   ├── L3PromptViewer.tsx          [ ]
│   ├── L3CommandViewer.tsx         [ ]
│   ├── L3DiffViewer.tsx            [ ] uses react-diff-view
│   ├── L3TurnsTable.tsx            [ ]
│   ├── L3DecisionsList.tsx         [ ]
│   ├── L3StreamTail.tsx            [ ]
│   ├── L3ContainerInfo.tsx         [ ]
│   ├── L4RunInfo.tsx               [ ]
│   ├── L4Timeline.tsx              [ ] Gantt
│   ├── L4CostView.tsx              [ ]
│   ├── L4EventsRaw.tsx             [ ]
│   └── L4DecisionsCrossStage.tsx   [ ]
├── hooks/
│   ├── (existing kept)
│   ├── useRunList.ts         [ ]
│   ├── useRun.ts             [ ] sealed = static; live = 5s poll
│   ├── useStageDetail.ts     [ ]
│   └── useStageFile.ts       [ ] lazy fetch helper for L3 contents
└── router.tsx                [ ] hash routing
```

---

## 6. Open decisions (resolve before / during PR A)

- [ ] **Sidebar / L3 widths**: 35% / 50% (default)? Or user-resizable handles?
- [ ] **Accordion vs tabs in sidebar**: accordion (all sections visible, scroll) vs tabs (one at a time, less scrolling)?
  - Working default: accordion.
- [ ] **Stitch expand threshold**: 3 lanes? 5?
  - Working default: 3.
- [ ] **L4 location**: button in top bar opens overlay panel (vs separate page)?
  - Working default: same page, slide panel.
- [ ] **Lazy fetch granularity**: sidebar open → fetch `stage.json` + `container.json` together. L3 open → fetch its specific file.
- [ ] **react-diff-view dependency**: confirm bundle size impact acceptable before pulling.

---

## 7. Implementation phases (PR-sized chunks)

### Phase A — Read API foundation
- [x] `app/server/run-reader.ts` with file-system helpers (no chokidar; pure read). Mirrors the new `runs/<id>/` layout: listRuns, getRun, getStage, readEvents, readStageText/Command/Diff/Turns/Stream, readProvenance, readPipelineSnap.
- [x] Endpoints from §4 (13 routes registered in `app/server/routes/runs.ts`, wired in `index.ts`).
- [x] Unit tests for `run-reader.ts` covering missing files, malformed JSON, classification edges (sealed/live/crashed), stitched node walking, event filtering by type prefix + limit, stream tailing. 18 tests passing via `node --test` (Node 22 / `tsx --test` on Node 20).

### Phase B — Runs list page
- [x] `RunsListPage.tsx` + hash router skeleton (`router.tsx`: `/`, `/runs`, `/runs/:id`)
- [~] `RunTable.tsx` — basic table inlined into `RunsListPage.tsx` (state/outcome chips, duration/stages columns). Sort by runId desc (server). Filter chips deferred to Phase J.
- [x] Top-bar nav: Live | Runs (active state highlighted, projectDir indicator on right)
- [x] `RunDetailPage.tsx` scaffold so `/runs/:id` resolves (full content lands in Phase C).
- [x] `App.tsx` slimmed to router shell; original body moved to `pages/LivePage.tsx`.

### Phase C — Run detail header + graph
- [x] `RunDetailPage.tsx` with operator-console header (runId + state + provider + outcome + duration + host, with a 1px hairline above keyed to outcome) and a ReactFlow DAG reconstructed from `pipeline.snap.json` + `state/PIPELINE_STATE.json`. Live runs poll every 5s; sealed runs load once.
- [x] StageNode rewritten (inspector design): 3px left state stripe (pulses on running, dashed border for pending), kind glyph (● agent / ▢ command), retry pip (`↻N` orange badge) when `retryCount > 0`, error glyph for failed stages, JetBrains Mono throughout. Fade-in stagger on load.
- [x] Server endpoint `/api/runs/:runId/graph` reuses `buildGraph` against the archived pipeline snapshot + state, augments each node with `retryCount` / `exitCode` / `nodeId` from per-stage `stage.json`.
- [~] Stitch lanes are rendered as separate nodes with `stitched` sub-label (existing buildGraph behavior). **Dashed subgraph box** wrapping lanes (ReactFlow parent-node grouping) deferred — material for a Phase E polish along with the L3 panels.

### Phase D — L2 stage sidebar
- [x] `StageSidebar.tsx` with three sections (Input / Output / Internal). All visible (no accordion collapse needed yet — ~25 fields total, scroll inside). Slides in from the right with a grid-push transition; Esc closes.
- [x] Summary widgets only — `OutcomeChip`, `RetryExit`, `SubsLine`, `ContainerLine`, `DiffSummaryLine`, `TurnsLine`, `DecisionsLine`, `StreamsLine`. Each row has a "view" link that opens the L3 panel (wired but panels themselves stub until Phase E).
- [x] `useStageDetail` hook fetches stage.json + container.json + filtered events + turns + diff summary in parallel; refetches whenever selection changes.
- [~] Tooltips (L1) for graph nodes + edges — not yet. ReactFlow nodes already get implicit cursor feedback via hover styles, and the sidebar gives the full detail one click away. Implicit tooltips deferred to a Phase J polish.

### Phase E — L3 panel — Input (smallest first)
- [ ] `L3PromptViewer.tsx`, `L3CommandViewer.tsx`, `L3ContainerInfo.tsx`
- [ ] Slide-out panel framework — two-layer (sidebar + L3) push

### Phase F — L3 panel — Output (diff)
- [ ] `L3DiffViewer.tsx` with react-diff-view, mount selector
- [ ] Empty-state for unchanged mounts

### Phase G — L3 panel — Internal
- [ ] `L3TurnsTable.tsx` + per-turn detail
- [ ] `L3DecisionsList.tsx` + JSON detail
- [ ] `L3StreamTail.tsx` with kind toggle

### Phase H — L4 overlays
- [ ] `L4RunInfo.tsx` — provenance + pipeline.snap
- [ ] `L4Timeline.tsx` — Gantt
- [ ] `L4DecisionsCrossStage.tsx`
- [ ] `L4CostView.tsx`
- [ ] `L4EventsRaw.tsx`

### Phase I — Live-mode parity
- [ ] Convert `LivePage` to use the new RunDetailPage with 5s polling and the latest non-sealed run
- [ ] Eventually deprecate the old NodeModal once feature parity confirmed

### Phase J — Polish
- [ ] Shareable URLs (`/runs/:id?stage=foo&panel=diff`)
- [ ] Search across runs
- [ ] Export run as tarball
- [ ] Keyboard navigation (arrow keys between stages)

---

## 8. Out of scope for v1

- Cross-run comparison ("how did this run differ from the last?") — Phase J+1.
- Editing PIPELINE.json from the visualizer — that belongs to the existing Chat panel.
- Persistent dashboards / metrics over many runs — separate observability concern, not transparency.
- Auth / multi-user — visualizer is localhost dev tool, same trust boundary as the rest of `app/`.
- Replaying a run inside the UI ("step through events.jsonl") — interesting but Phase J+2 at earliest.

---

## 9. Cross-references

- Transparency data shape: `docs/TRANSPARENCY-PLAN.md` (filesystem layout §3, signal locations §3 Signal → location table).
- Existing debug UI: `app/PLAN.md` (the surface we're extending).
- CLI counterpart: `art inspect` in `src/cli/inspect.ts` — the visualizer is essentially the GUI of `art inspect` with richer interaction.

---

## 10. Data contract (regression guard)

A contract test in `tests/unit/pipeline-runner.test.ts` (describe `"Transparency contract for UX plan"`) runs one representative pipeline (root agent + stitch × 2 lanes + downstream agent + injected turn IPC) and asserts each on-disk artifact the UI depends on. Each `it` block is tied to a UX item from §2 of this plan. If a runtime change drops a field or stops writing a file, the test fails at the exact UX item that would silently break.

Coverage matrix (✓ = asserted by the contract test):

| UX item | File / event | Status |
| --- | --- | --- |
| L0 — top bar | `run.json` schemaVersion + pid + hostname + provider + args | ✓ |
| L0 — outcome chip | `summary.json` outcome + durationMs + totalStages | ✓ |
| L0 — sealed indicator | `sealed` marker | ✓ |
| L0 — DAG node colors | `state/PIPELINE_STATE.json` dispatchTree + completedStages | ✓ |
| L2 Input — prompt label | `prompt.txt` + `prompt.source` per stage | ✓ |
| L2 Input — initial handoff | `initial.txt` when present | ✓ |
| L2 Input — substitutions | `substitutions.json` with insertId/index/full substitutions map | ✓ |
| L2 Input — command | `command.sh` + `command.json` | todo (covered by Command-mode block) |
| L2 Input — container summary | `container.json` image + mode + mounts (rw flagged) | ✓ |
| L2 Output — stage record | `stage.json` matchedMarker + result + retryCount + duration + inputHashes | ✓ |
| L2 Output — diff | `diff/<mount>.diff` + `diff/summary.json` | ✓ (skipped on hosts without git+cp) |
| L2 Internal — turns | `turns/NNN.json` | ✓ |
| L2 Internal — decisions | `decision.marker` in events.jsonl per stage | ✓ |
| L2 Internal — barrier eval | `decision.barrier` in events.jsonl | ✓ |
| L4 — provenance | `provenance.json` agents + templates hashes + env | ✓ |
| L4 — pipeline snapshot | `pipeline.snap.json` mirrors authored config | ✓ |
| L4 — stitch event | `stitch.invoked` in events.jsonl with childNodeIds | ✓ |

Add an `it` block here whenever the plan adds a new UX item that requires runtime support. The test will then make the dependency explicit.
