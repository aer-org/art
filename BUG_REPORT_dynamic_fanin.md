# Bug: `fan_in: "dynamic"` stages never start after `next_dynamic` transition

## Summary

When a stage with `next_dynamic: true` completes and activates target stages that have `fan_in: "dynamic"`, those target stages are never started. The engine reports "Fan-in stages stuck — predecessors did not complete".

## Expected Behavior

Per the pipeline spec on `fan_in: "dynamic"`:
> "dynamic" = wait only for activated predecessors

An eval stage emits `[STAGE_COMPLETE]` with `next_dynamic: true` and selects `["edit-A", "edit-B"]`. Both targets have `fan_in: "dynamic"`. They should start immediately, waiting only for the eval stage (the activated predecessor).

## Actual Behavior

The engine detects the eval completion and resolves the correct next targets, but then immediately reports them as stuck:

```json
// Eval completes successfully, next_dynamic selects both edits
{"stage":"eval-test-imcflow_with_axi","turn":1,"result":{
  "matched":{"marker":"STAGE_COMPLETE",
    "next":["edit-crossbar","edit-imce"],
    "next_dynamic":true,
    "prompt":"test-imcflow_with_axi eval complete — re-running selected edits"
  },"payload":null},"msg":"Stage result received"}

// Eval container exits cleanly
{"stage":"eval-test-imcflow_with_axi","status":"success","msg":"Pipeline stage container exited"}

// Immediately stuck — neither edit stage starts
{"waiting":["edit-crossbar","edit-imce"],"msg":"Fan-in stages stuck — predecessors did not complete"}
```

No "Entering stage" log appears for either edit stage. The pipeline terminates.

## Pipeline Configuration

```json
// Eval stage — selects which edits to re-run
{
  "name": "eval-test-imcflow_with_axi",
  "transitions": [{
    "marker": "STAGE_COMPLETE",
    "next": ["edit-crossbar", "edit-imce"],
    "next_dynamic": true
  }]
}

// Edit stages — should accept dynamic fan-in
{
  "name": "edit-crossbar",
  "fan_in": "dynamic",
  ...
}
{
  "name": "edit-imce",
  "fan_in": "dynamic",
  ...
}
```

## Context

These edit stages have multiple predecessors across the pipeline lifecycle:
- `plan` → `[edit-crossbar, edit-imce]` (initial entry)
- `eval-test-imcflow` → `[edit-crossbar, edit-imce]` (loop re-entry, next_dynamic)
- `eval-test-imcflow_with_axi` → `[edit-crossbar, edit-imce]` (loop re-entry, next_dynamic)

The engine appears to require ALL predecessors (plan + both evals) to have completed, rather than only the **activated** predecessor (the eval that just ran).

## Reproduction

Minimal pipeline:
```json
{
  "stages": [
    {
      "name": "start",
      "prompt": "Do something. Emit [STAGE_COMPLETE].",
      "mounts": {},
      "transitions": [{"marker": "STAGE_COMPLETE", "next": "check"}]
    },
    {
      "name": "check",
      "prompt": "",
      "command": "echo '[STAGE_ERROR]'",
      "image": "ubuntu:22.04",
      "mounts": {},
      "transitions": [
        {"marker": "STAGE_COMPLETE", "next": null},
        {"marker": "STAGE_ERROR", "next": "eval"}
      ]
    },
    {
      "name": "eval",
      "prompt": "Pick which to re-run. Emit [STAGE_COMPLETE].",
      "mounts": {},
      "transitions": [{
        "marker": "STAGE_COMPLETE",
        "next": ["start"],
        "next_dynamic": true
      }]
    }
  ],
  "entryStage": "start"
}
```

Where `start` has `fan_in: "dynamic"`. After eval completes, `start` should re-enter but gets stuck.

## Impact

This completely breaks eval→edit repair loops. The eval agent correctly analyzes failures and selects which edits to re-run, but the pipeline engine cannot execute the re-entry. The entire self-healing loop is non-functional.

## Log Files

- Pipeline log: `__art__/logs/pipeline-2026-04-03T11-11-49-502Z.log`
- Engine log: `__art__/logs/engine.log` (last 10 lines)
