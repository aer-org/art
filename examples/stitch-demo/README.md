# stitch-demo

Minimal pipeline that exercises every stitch primitive: three levels of nested
single stitch followed by a parallel stitch with a synthesized join stage.
All stages are agent-mode with trivial prompts that ask Claude to emit one
specific marker — the demo is about the host-side graph mutation, not the
agent's reasoning.

## What you'll see

```
start
  └── [GO] ──►  demo (template, single stitch)
        └── intro ──[DEEPER]──►  deep1 (template, single stitch)
              └── work ──[DEEPER]──►  deep2 (template, single stitch)
                    └── work ──[PARALLEL, count=3]──►  lane (template, parallel stitch)
                          ├── task #0 ─┐
                          ├── task #1 ─┼─►  join ──►  (pipeline ends)
                          └── task #2 ─┘
```

Resolved stage names at runtime (deterministic):

- `start`
- `start__demo0__intro`
- `start__demo0__intro__deep10__work`
- `start__demo0__intro__deep10__work__deep20__work`
- `start__demo0__intro__deep10__work__deep20__work__lane0__task`
- `start__demo0__intro__deep10__work__deep20__work__lane1__task`
- `start__demo0__intro__deep10__work__deep20__work__lane2__task`
- `start__demo0__intro__deep10__work__deep20__work__lane__join`

Every level of stitch logs a `🧵 Stitched template "<name>" after <origin>`
banner to the pipeline log.

## Layout

```
__art__/
├── PIPELINE.json                 # base DAG (just `start` → demo template)
└── templates/
    ├── demo.json                 # intro → deep1
    ├── deep1.json                # work  → deep2
    ├── deep2.json                # work  → lane (parallel count=3)
    └── lane.json                 # task  → null (converges on join)
```

## Run

```bash
# Build once
npm run build
./container/build.sh

# Register the example as a group (adjust path if running from a checkout)
art compose examples/stitch-demo
art run stitch-demo
```

Watch the pipeline log stream — you should see the stitch banners in order,
three agents in parallel during the lane phase, then the synthesized join
firing once all three `DONE`s have arrived.

## What is exercised vs. what is skipped

Exercised:
- Nested single stitch (template A → B → C each via single stitch).
- Parallel stitch with `count: N` producing N renamed copies + a synthesized
  join stage.
- Join waiting for every lane before continuing.
- `{{insertId}}` and `{{index}}` substitution (the lane prompt references
  both — inspect the lane agents' prompts in the log).
- State persistence of `insertedStages` — if you `Ctrl+C` mid-run and resume,
  the stitched stages are rehydrated.

Skipped (intentional):
- No payload forwarding, MCP access, host mounts, GPU, or `resumeSession`
  tuning. See `examples/autoresearch` for payloads and heavier stage config.
- No recovery paths — every agent emits the "go deeper" marker. If you want
  to exercise `next: null` termination from a mid-pipeline marker, tweak one
  of the template prompts to ask for `[STOP]` instead, and add a matching
  transition.

## Try tweaking

- Change `count: 3` in `deep2.json` to `10` and re-run — you'll get ten
  parallel lanes with unique names like `…__lane9__task`.
- Replace `lane.json` with a 2-stage template (task1 → task2 → null) and
  re-run — each lane now has two sequential stages internally, and only
  the final one hits the join.
- Insert another level: make `deep2.json` stitch a new `deep3.json` before
  the parallel step. Stitch depth is unlimited (DAG always grows downward).
