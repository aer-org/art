# Automated Research Team (ART)

```bash
npm install -g aer-art
```

```bash
cd my-project
art init .                    # Scaffold __art__/ with default template
vim __art__/VISION.md         # Write your research goal
# Add tests to __art__/test_approved/
art run .                     # Manual mode — pauses for approval at each gate
art run . --auto              # Auto mode — 100 experiments overnight, no human needed
art compose .                 # Visual pipeline editor (React Flow web UI)
```

Requires **Node.js ≥ 20**, **Docker**, and **Git**.

---

## What is ART?

A generic TypeScript CLI **pipeline engine** that runs autonomous research loops on existing project directories. ART reads a `pipeline.json` defining phases, agents, permissions, and execution order, then orchestrates those phases in Docker-isolated containers.

**Inspiration**: Karpathy's [autoresearch](https://github.com/karpathy/autoresearch) (iterate → evaluate → commit/revert), but with adversarial benchmark separation, multi-agent architecture, and continuous insight tracking.

The **default pipeline template** ships a 5-agent research loop, but ART-the-framework has no hardcoded knowledge of "planner" or "builder" — it knows phases, agents, mounts, gates, and edges. Any pipeline can be designed via `art compose` and loaded as a template.

> **Agent philosophy** (from 가재가족 operating model):
> Agents are not tools but delegated operators with identity, memory, and doctrine. Each agent has a SOUL.md defining its personality and principles.
> "상태 보고는 가치가 없다" — status reports are worthless, only artifacts count.
> "실행 증거 없는 약속은 0점" — promises without execution evidence score zero.

---

## Default Pipeline — 5-Agent Research Loop

```
    ┌──────────┐
    │  PLAN    │ ← planner generates PLAN.md + METRICS.md
    └────┬─────┘
         │ [approval gate — manual mode only]
         ▼
    ┌──────────┐
    │  BUILD   │ ← builder writes code + run.sh, runs internally
    └────┬─────┘
         ▼
    ┌──────────┐
    │ VALIDATE │ ← host-side: outputs/ non-empty?
    └────┬─────┘
         ▼
    ┌──────────┐
    │  BENCH   │ ← benchmark runs eval scripts adversarially
    └────┬─────┘
         ▼
    ┌──────────┐
    │  REPORT  │ ← reporter analyzes code + results
    └────┬─────┘
         │         ┌──────────┐
         │────────→│HISTORIAN │ (async: updates INSIGHTS.md + memory/)
         ▼         └──────────┘
    ┌──────────┐
    │  TRACK   │ ← host-side: git commit if improved, revert if worse
    └────┬─────┘
         │ [approval gate — manual mode only]
         └──→ back to PLAN (loop)
```

The human writes **VISION.md** — the high-level goal. The **planner** reads the vision + accumulated insights and generates **PLAN.md** + **METRICS.md**. The **builder** executes the plan. The **benchmark** tests it adversarially. The **reporter** writes an unbiased analysis. The **historian** distills institutional memory. The **track** handler commits or reverts via git.

### Adversarial Permission Matrix

Permissions are enforced by **Docker mounts** — hidden files are not mounted, so agents physically cannot access them.

| | Project | VISION | PLAN | METRICS | Code | Eval scripts | Tests (approved) | Tests (generated) | Outputs | REPORT | INSIGHTS | Memory |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Planner** | ro | ro | **rw** | **rw** | — | HIDDEN | HIDDEN | HIDDEN | ro | HIDDEN | ro | ro |
| **Builder** | ro | HIDDEN | ro | ro | **rw** | HIDDEN | HIDDEN | HIDDEN | ro | HIDDEN | ro | ro |
| **Benchmark** | ro | HIDDEN | HIDDEN | ro | ro | ro | ro | **rw** | **rw** | — | HIDDEN | **rw** |
| **Reporter** | ro | HIDDEN | HIDDEN | ro | ro | — | ro | ro | ro | **rw** | HIDDEN | — |
| **Historian** | — | — | — | — | — | — | — | — | — | ro | **rw** | **rw** |

- Builder **cannot see** eval scripts or test code → prevents gaming
- Benchmark **cannot see** PLAN.md, VISION.md, or builder's SOUL → unbiased evaluation
- Reporter **cannot see** PLAN.md or VISION.md → fresh perspective
- `eval_approved.sh`, `eval_generated.sh`, and `test_approved/` are **locked** — no agent can ever write to them

---

## Auto Mode vs Manual Mode

**Manual mode** (default) pauses for human approval at configured gates:

```bash
art run .
# Planner generates PLAN.md + METRICS.md
# Pauses: "Approve this plan? [y/n/edit]"
# Builder runs → Validate → Benchmark → Report
# Tracking (commit/revert)
# Pauses: "Keep this commit? [y/n/cherry-pick]"
```

**Auto mode** runs experiments autonomously — set it, sleep, wake up to results:

```bash
art run . --auto
# PLAN→BUILD→BENCH→REPORT→TRACK in a loop
# Each experiment creates a git node (commit or revert)
# Keeps going until time budget / max experiments / max failures
```

**Switch modes mid-session:**

```
/auto-start     → Switch to auto (creates git checkpoint, runs freely)
/auto-end       → Switch to manual (shows experiment history, merge/cherry-pick/revert)
```

When `/auto-end` runs, ART shows the full session:

```
Auto mode session: 2026-03-15T14:00:00Z → now
Started from: a1b2c3d (tag: art-auto-start-20260315T140000Z)

Experiments during auto mode:
  e4f5g6h  [art] experiment #13 — accuracy: 0.991 (+0.002) ✅
  h7i8j9k  [art] experiment #14 — accuracy: 0.989 (-0.002) ❌ reverted
  l0m1n2o  [art] experiment #15 — accuracy: 0.995 (+0.006) ✅ ← best

Resource constraints during this session:
  GPU unavailable: 14 times
  Memory ceiling:   6 times

Options: (1) keep all  (2) cherry-pick  (3) revert all
```

---

## Framework vs Template

ART-the-framework is a **generic pipeline engine**. It knows how to:
- Parse `pipeline.json` and walk edges
- Start Docker containers with specified mounts
- Inject SOUL files as agent identity
- Enforce read/write/hidden permissions via Docker mounts
- Run host-side phase handlers
- Manage approval gates, loop strategies, and git tracking

ART-the-framework does **NOT** know:
- What a "planner" or "builder" is
- That PLAN.md or METRICS.md exist
- What the default research loop looks like
- How many agents there should be

All of that lives in the **default pipeline template**. Replace it with a completely different pipeline and the same `art` binary runs it.

### Pipeline Templates

A template is a package containing the full research environment definition:

```
~/.art/templates/default/
├── pipeline.json           # Phase graph + permissions
├── SOUL/                   # Agent identity files
├── scaffold/               # Files copied at init (VISION.md, eval scripts)
└── config.defaults.toml    # Default config values
```

```bash
art init . --template ml-research    # Use a custom template
art compose .                        # Edit pipeline visually
art compose --save my-pipeline       # Save as reusable template
art compose --list                   # List available templates
```

---

## CLI Reference

```bash
art init <path>                     # Scaffold __art__/ (default template)
art init <path> --template <name>   # Scaffold with named template
art run <path>                      # Start loop (manual mode)
art run <path> --auto               # Start loop (auto mode)
art status [path]                   # Show project state
art compose [path]                  # Visual pipeline editor (web UI)
art compose --list                  # List templates
art compose --save <name>           # Save pipeline as template
art compose --delete <name>         # Delete user template
```

### Interactive Commands (during `art run`)

```
/auto-start     Switch to auto mode (git checkpoint)
/auto-end       Switch to manual mode (show history, merge/revert)
/status         Current experiment status
/stop           Stop after current phase
/vision         Show VISION.md
/constraints    Show resource constraint summary
```

---

## Configuration

`__art__/config.toml`:

```toml
[project]
name = "my-ml-project"

[agent]
backend = "claude-code"             # Modular — swap agent backends

[loop]
strategy = "fixed-time-budget"
time_budget_seconds = 300
max_experiments = 100
max_consecutive_failures = 5

[git]
auto_commit = true
tag_best = true
revert_on_failure = true

[docker]
image = "art-agent:latest"
auto_build = true

[compose]
port = 3100                         # Web UI port
```

---

## Project Directory Layout

```
my-project/                         # Your existing project (read-only to agents)
├── src/, data/, ...
│
├── __art__/                        # All ART artifacts
│   ├── SOUL/                       # Agent identity files
│   │   ├── planner.md, builder.md, benchmark.md
│   │   ├── reporter.md, historian.md
│   ├── pipeline.json               # Active pipeline definition
│   ├── config.toml                 # Settings
│   ├── VISION.md                   # Human-written goal
│   ├── PLAN.md                     # Planner-generated plan
│   ├── METRICS.md                  # Planner-generated metrics
│   ├── run.sh                      # Builder-written entry point
│   ├── eval_approved.sh            # LOCKED — human-written
│   ├── eval_generated.sh           # LOCKED — human-written
│   ├── test_approved/              # LOCKED — human-written tests
│   ├── test_generated/             # Benchmark writes here
│   ├── outputs/                    # Run + eval results (gitignored)
│   ├── REPORT.md                   # Reporter analysis
│   ├── INSIGHTS.md                 # Historian cumulative wisdom
│   └── memory/                     # Structured memory
│       ├── MAP.md                  # Pointer file
│       ├── experiments/            # Per-experiment records
│       └── benchmark/              # Benchmark agent memory
│           ├── patterns.md
│           └── coverage.md
└── .git/
```

---

## Git Strategy

Each experiment produces a git artifact:

```bash
# Improved → commit + tag
git commit -m "[art] experiment #12 — accuracy: 0.997 (+0.003)"
git tag art-exp-12
git tag art-best-12              # If new best

# Worse → revert builder changes, keep reports + memory
git tag art-exp-12-reverted
```

Auto mode creates a checkpoint tag for safe rollback:
```bash
git tag art-auto-start-<timestamp>
```

---

## Permission Enforcement

Three layers of defense:

1. **Docker mounts** (primary) — only declared files are mounted into the container. Hidden files physically don't exist in the agent's filesystem.
2. **CLAUDE.md injection** (secondary) — ART generates a CLAUDE.md from the agent's SOUL file + permission rules. Defense-in-depth.
3. **Post-agent validation** (tertiary) — after each agent finishes, ART validates that only permitted files were modified. Violations are reverted and logged.

---

## Resource Constraint Reporting

When agents hit resource limits during auto mode, ART logs them transparently to `resource_requests.json`:

```json
{
  "constraints": [
    {
      "experiment": 7,
      "phase": "build",
      "type": "gpu_unavailable",
      "detail": "Builder attempted CUDA training, fell back to CPU"
    }
  ],
  "summary": {
    "total_constraints": 23,
    "by_type": { "gpu_unavailable": 14, "memory_ceiling": 6, "storage_near_capacity": 3 }
  }
}
```

This is factual reporting. No product recommendations, no links, no upsells.

---

## Architecture

```
src/
├── cli/                    # CLI commands (init, run, status, compose)
├── core/
│   ├── pipeline-engine.ts  # Generic FSM executor
│   ├── pipeline-loader.ts  # Load + validate pipeline.json
│   ├── agent-phase-runner.ts # Generic agent runner (mount → SOUL → container → validate)
│   ├── host-phase-registry.ts
│   ├── host-phases/
│   │   ├── validate.ts     # outputs_nonempty check
│   │   └── track.ts        # git commit/revert/tag + metrics comparison
│   ├── metrics.ts          # Parse METRICS.md + eval JSONs
│   ├── memory.ts           # Experiment records
│   ├── auto-mode.ts        # Auto/manual mode switching
│   └── resource-log.ts     # Constraint tracking
├── agents/                 # Agent backend adapters (v1: Claude Code)
├── docker/                 # Container + volume management
├── strategies/             # Loop strategies (v1: fixed-time-budget)
├── permissions/            # Enforcer + CLAUDE.md generation
├── pipeline/               # Schema, validator, template management
├── templates/default/      # Default template package
└── web/                    # art compose (Express + React Flow)
```

---

## Agent Integrity

ART's value proposition rests on agents operating with integrity:

- Agents are **never** system-prompted to advertise, upsell, or recommend paid products
- SOUL files contain only the agent's role, principles, and operational instructions
- When agents run in auto mode, they work exclusively on the user's research goals
- Resource constraints are reported factually, not as sales opportunities

---

## Development

```bash
git clone https://github.com/aer-org/art.git
cd art
npm install
npm run build        # Compile TypeScript
npm test             # Run tests
npm run dev          # Watch mode
```

---

## License

**AGPL-3.0** — Commercial license available.

AGPL ensures that anyone running ART as a network service (e.g., "Autonomous Research as a Service") must open-source their modifications. Researchers using ART locally are unaffected. Companies embedding ART in proprietary products purchase a commercial license.
