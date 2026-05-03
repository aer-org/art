# Debugger Memory

This file is the debugger's durable notebook. Future sessions of you will read
it on every launch — keep it terse and curated.

## Conventions

- One entry per heading. Date the heading: `## YYYY-MM-DD — short title`.
- Lead with the **lesson**, then a one-line *why*. Avoid step-by-step
  reproductions; those belong in the conversation transcript, not here.
- Delete entries that turn out to be wrong rather than leaving them as
  "previously thought…".

## Entries

## 2026-05-01 — ART repo location and debugger boundary

**ART lives at `/home/sookwan.han/fpl_project/art` (`~/fpl_project/art`) on this machine.** Read it early when ART runtime, schema, app, or guardrail behavior matters. The debugger may use read-only context from the host filesystem, but writes belong only under the loaded project's `__art__/`.

## 2026-05-01 — execution permission boundary

**The loaded project `__art__/` is read/write/execute; the rest of the host filesystem is read/execute.** Every Bash execution asks the user first with `Yes`, `Yes, allow this command for this project`, or `No`; project-level approval remembers the exact command.

## 2026-05-01 — proactive pipeline debug loop

**Pipeline debug/create requests include running `art run` and iterating until the pipeline is verified functional.** Do not stop at inspection or ask "Want me to run it?"; run in the background, read state/logs, fix, and repeat until success, Stop/cancel, or a loud external blocker.

## 2026-05-01 — silent fallbacks forbidden

**Never hide failures behind placeholders or success markers.** Missing tools/files, empty outputs, skipped mounts, stale state, partial reports, and fallback behavior must fail loudly and be debugged.

## 2026-04-28 — exp6 pipeline debug: four cascading bugs

1. **EACCES on experiment dirs**: `build-matrix` runs as root, creates `exp_*` dirs owned by `root:root`. Engine (host user) can't mkdir sub-path mounts for fanout lanes. Fix: append `chmod -R a+rwX /workspace/experiments/` to build-matrix command.

2. **`set -o pipefail` unsupported in sh**: Template commands used `set -euo pipefail` / `set -uo pipefail`, but the container's default shell is `sh` (dash). Fix: remove `pipefail` (no commands use pipes anyway).

3. **hostMount paths use `/workspace/extra/` prefix**: Art mounts hostMounts at `/workspace/extra/<containerPath>`, not `/workspace/<containerPath>`. Template commands referenced `/workspace/Xilinx/` etc. Fix: change all to `/workspace/extra/Xilinx/` etc.

4. **hostMount allowlist missing entries**: `~/.config/aer-art/mount-allowlist.json` only had Xilinx paths. The `benchmarks_dcp` and `contest` hostMounts were silently skipped. Fix: add both paths to the allowlist.

Also: stale state lives in `__art__/.state/`, not the top-level `PIPELINE_STATE.json` files. Delete `__art__/.state/` to force a truly fresh run.

## 2026-04-28 — exp6 pipeline: two more bugs

5. **Docker cgroup timeout on large fanouts**: Launching 360 containers simultaneously overwhelms systemd's cgroup manager (`Timeout waiting for systemd to create docker-<hash>.scope`, exit code 125). ~40% of lanes fail. No concurrency limit in art's fanout (`withConcurrency()` in fanout.ts exists but is not wired up). Mitigation: ensure containers from previous runs are killed before restarting; reduces failure rate to ~20%. Root fix would require adding `maxConcurrent` to the fanout transition schema.

6. **Missing STAGE_ERROR transitions cause join hang**: If a template stage has only `STAGE_COMPLETE` transitions and the stage errors (e.g., Docker cgroup timeout), the lane never settles. With `joinPolicy: "all_settled"`, the pipeline hangs forever. Fix: add `{"marker": "STAGE_ERROR", "next": null}` to every template stage that lacks one.
