# Bug: Fan-out acts as implicit barrier

## Summary

When a stage fans out to multiple next stages (e.g., `plan → [edit-A, edit-B]`), the runner treats the fan-out batch as an implicit barrier. Successor stages of individual fan-out targets do not start until **all** fan-out targets complete, even when they have only a single predecessor.

## Expected Behavior

Per the pipeline spec:
> "Fan-in is automatic: a stage with multiple predecessors waits for all to complete."

`test-A` has only one predecessor (`edit-A`). It should start immediately when `edit-A` completes, regardless of whether `edit-B` is still running.

## Actual Behavior

`edit-A` completes → engine logs `next: "test-A"` → but `test-A` does NOT start. Only after `edit-B` also completes does `test-A` (and `test-B`) start.

## Reproduction

Pipeline structure:
```
plan → [edit-A, edit-B]    (fan-out)
edit-A → test-A            (single predecessor)
edit-B → test-B            (single predecessor)
```

1. `plan` completes, emits `STAGE_COMPLETE`, `next: ["edit-A", "edit-B"]`
2. `edit-A` and `edit-B` start in parallel (correct)
3. `edit-A` completes (32s), emits `STAGE_COMPLETE`, `next: "test-A"`
4. **`test-A` does NOT start** — waits for `edit-B`
5. `edit-B` completes (5min later)
6. Now `test-A` and `test-B` both start

## Evidence (engine.log)

```json
// edit-crossbar completes, next is test-crossbar-unit
{"stage":"edit-crossbar","turn":1,"result":{"matched":{"marker":"STAGE_COMPLETE","next":"test-crossbar-unit",...}}}
{"stage":"edit-crossbar","status":"success","msg":"Pipeline stage container exited"}

// NO "Entering stage" for test-crossbar-unit follows
// Only after edit-imce also completes do the test stages start
```

## Impact

This serializes work that should run in parallel. In a pipeline with N independent modules:
- Expected: each edit→test chain runs independently
- Actual: all edits must complete before any test starts
- Worst case: total time = sum(all edits) + sum(all tests) instead of max(edit+test per chain)

## Suggested Fix

When a fan-out target completes and its `next` stage has only that single predecessor (no fan-in from other sources), the next stage should start immediately without waiting for sibling fan-out targets.
