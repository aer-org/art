/**
 * ART_* environment-variable injection.
 *
 * The runtime injects a small fixed set of `ART_*` variables into every
 * stage container so scripts (and agents that shell out) can identify
 * which lane they are without needing the JSON-level substitution
 * machinery. For stitched lanes spawned via `substitutionsFrom: 'payload'`,
 * each top-level payload field also becomes an `ART_<UPPER>` variable.
 *
 * Always injected:
 *   ART_STAGE_NAME       — local stage name (template's authored name, or
 *                          the base stage name if not stitched)
 *   ART_INSERT_ID        — invocationId; same value across all sibling lanes
 *                          of one stitch (parent's perspective). `root` when
 *                          the stage is not part of a stitch.
 *   ART_LANE_INDEX       — copyIndex (0, 1, 2, …). `0` for non-stitched.
 *   ART_DISPATCH_NODE_ID — full dispatch tree id (`<invocationId>_<index>`),
 *                          `root` for the top-level scope. Useful for
 *                          correlating with RunRecorder artifacts.
 *
 * Payload-derived (only when stage.dispatch.substitutions has extra fields):
 *   ART_<UPPER_KEY>      — one per top-level field, value `String(v)`.
 *                          Reserved keys `insertId` and `index` are skipped
 *                          (already mapped to ART_INSERT_ID / ART_LANE_INDEX).
 *
 * ART_* env keys are reserved at author time (pipeline-config rejects them).
 */
import type { PipelineStage } from './pipeline-types.js';

export function buildArtEnv(stage: PipelineStage): Record<string, string> {
  const dispatch = stage.dispatch;
  const env: Record<string, string> = {
    ART_STAGE_NAME: dispatch?.localName ?? stage.name,
    ART_INSERT_ID: dispatch?.invocationId ?? 'root',
    ART_LANE_INDEX: String(dispatch?.copyIndex ?? 0),
    ART_DISPATCH_NODE_ID: dispatch?.nodeId ?? 'root',
  };
  const subs = dispatch?.substitutions;
  if (subs) {
    for (const [key, value] of Object.entries(subs)) {
      if (key === 'insertId' || key === 'index') continue; // already mapped
      const envKey = `ART_${key.toUpperCase()}`;
      env[envKey] = String(value);
    }
  }
  return env;
}

/**
 * Merge author-time stage.env with the runtime-injected ART_* set.
 * ART_* wins on conflict (the validator should already have rejected
 * authored ART_* keys, but defense in depth).
 */
export function mergeStageEnv(stage: PipelineStage): Record<string, string> {
  return { ...(stage.env ?? {}), ...buildArtEnv(stage) };
}
