# stitch-showcase

One demo pipeline that exercises every transition / stitch primitive together:

1. **Base-pipeline node transitions** (3 chained stages: `kickoff → prepare → launch`).
2. **Single stitch of a multi-stage template** (`launch` stitches `main`, which has 3 internal stages: `init → gather → dispatch`).
3. **Payload-driven parallel stitch of a multi-stage template** (`dispatch` emits a 3-element payload → `worker` is stitched 3× in parallel, each lane is 3 stages: `ingest → process → finalize`).
4. **Per-lane substitution** (`{{id}}`, `{{kind}}`, `{{insertId}}`, `{{index}}` are substituted inside every worker lane's prompts, transitions, and mount keys).

## Expected runtime shape

```
kickoff ──[OK]──► prepare ──[OK]──► launch ──[GO]──► (stitch "main")
                                                        │
                                                        ▼
                          launch__main0__init ──[OK]──► launch__main0__gather ──[OK]──►
                          launch__main0__dispatch ──[PLAN_READY, payload×3]──► (stitch "worker" ×3)
                                                        │
                     ┌──────────────────────────────────┼──────────────────────────────────┐
                     ▼                                  ▼                                  ▼
            worker0 (alpha/fast)              worker1 (beta/slow)              worker2 (gamma/medium)
              ingest → process → finalize       ingest → process → finalize      ingest → process → finalize
                     │                                  │                                  │
                     └──────────────────────────────────┴──────────────────────────────────┘
                                                        ▼
                                                  join ──► (pipeline ends)
```

After a successful run, `__art__/output/` contains three files:

- `output/alpha.txt` — `id=alpha / kind=fast / index=0`
- `output/beta.txt` — `id=beta / kind=slow / index=1`
- `output/gamma.txt` — `id=gamma / kind=medium / index=2`

The file contents prove per-lane substitution reached (a) prompts inside a stitched template, (b) mount keys (implicitly — writing to `/workspace/output/{{id}}.txt` uses the per-lane filename), and (c) each lane received a distinct payload object.

## Run

```bash
art run examples/stitch-showcase
```
