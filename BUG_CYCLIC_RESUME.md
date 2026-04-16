# Bug: Cyclic pipeline resume always falls back to entryStage

## Summary

When resuming a cyclic pipeline (e.g., `plan → build → review → plan → ...`), the engine always restarts from `entryStage` instead of resuming from the interrupted stage.

## Root Cause

`pipeline-runner.ts:1224`:

```typescript
const remaining = targets.filter((t) => !completedStages.includes(t));
initialStages = remaining.length > 0 ? remaining : [resolveEntry()];
```

`completedStages.includes(t)` checks the **entire history**. In a cyclic pipeline, every stage appears in `completedStages` after the first full cycle. So `remaining` is always empty, and the engine falls back to `resolveEntry()` → `entryStage`.

## Reproduction

1. Define a cyclic pipeline: `plan → build → review → plan → ...`
2. Let it run for 2+ full cycles
3. Interrupt during any stage (e.g., during `review`)
4. Restart the pipeline — it resumes from `plan`, not `review`

`PIPELINE_STATE.json` at interruption:
```json
{
  "completedStages": ["plan","build","review","plan","build","review","plan","build"],
  "status": "error"
}
```

Last completed = `build` → transition target = `review` → but `completedStages.includes("review")` is true → remaining = [] → fallback to `plan`.

## Suggested Fix

Check only stages completed **after the last occurrence** of `lastCompleted`, not the entire history:

```typescript
const lastIdx = completedStages.lastIndexOf(lastCompleted);
const afterLast = completedStages.slice(lastIdx + 1);
const remaining = targets.filter((t) => !afterLast.includes(t));
```

## Workaround

Manually remove all occurrences of the target stage from `completedStages` in `PIPELINE_STATE.json` before restarting.
