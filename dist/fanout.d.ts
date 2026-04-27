import type { PipelineConfig } from './pipeline-runner.js';
export interface FanoutInputItem {
    [key: string]: string | number | boolean;
}
export declare const MAX_FANOUT_RECURSION_DEPTH = 2;
/**
 * Parse the payload emitted by the stage preceding a dynamic-fanout stage.
 * Must be a JSON array of flat objects whose values are string | number | boolean.
 */
export declare function parseFanoutPayload(payload: string, stageName: string): FanoutInputItem[];
/**
 * Load a child pipeline template from disk, relative to bundleDir.
 * Returns a freshly parsed PipelineConfig per call (no caching) so substitutions
 * of different inputs don't share object refs.
 */
export declare function loadFanoutTemplate(bundleDir: string, templatePath: string, stageName: string): PipelineConfig;
/**
 * Apply flat {{key}} substitution to allowed fields of each stage in the template.
 * Only top-level PipelineStage fields listed in `allowedFields` are traversed.
 * Missing {{keys}} are left intact and a warning is logged — the agent will see them.
 */
export declare function applyFanoutSubstitutions(template: PipelineConfig, input: FanoutInputItem, allowedFields: string[], stageName: string): PipelineConfig;
/**
 * Simple p-limit-style semaphore.
 * Invariant: at most `max` tasks run at the same time.
 */
export declare function withConcurrency<T>(max: number | undefined, tasks: Array<() => Promise<T>>): Promise<T[]>;
/**
 * Build a short scopeId for a fanout child, constrained to the scopeId pattern
 * enforced by PipelineRunner. Format: "f<6-hex>" (7 chars) — deterministic per
 * (parent scope, parent stage, index) pair so recovery/debug can correlate.
 */
export declare function deriveChildScopeId(parentScopeId: string | undefined, parentStage: string, index: number): string;
/**
 * Count the nesting depth encoded in a scopeId chain. A top-level run has
 * undefined scopeId (depth 0). Each dynamic-fanout level appends one child
 * scope, so depth = number of fanout ancestors.
 *
 * Depth is tracked via the ART_FANOUT_DEPTH env variable on child runners.
 */
export declare function readFanoutDepth(): number;
export declare function assertFanoutDepthAllowed(stageName: string): number;
//# sourceMappingURL=fanout.d.ts.map