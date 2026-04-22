/**
 * Stitch core: dynamically insert a pipeline template into a running
 * PipelineConfig's stage graph. Pure graph-in / graph-out functions — no I/O.
 *
 * Insertion modes:
 *   stitchSingle   — clone template once, rewire host transition to entry
 *   stitchParallel — clone template N times, converge lanes on a synthesized
 *                    fan-in barrier, rewire host transition to N entries
 *
 * Semantics (Option 1 — template owns downstream):
 *   Single: template stages with `next: null` terminate the pipeline.
 *   Parallel: template stages with `next: null` converge to the barrier,
 *             whose `next` is null (parallel block is terminal by default).
 */
import type { PipelineConfig, PipelineStage } from './pipeline-runner.js';
import type { PipelineTemplate } from './pipeline-template.js';
export declare const STITCH_SUBSTITUTION_FIELDS: readonly string[];
export type SubstitutionValue = string | number | boolean;
export type SubstitutionMap = Record<string, SubstitutionValue>;
export interface StitchSingleInput {
    config: PipelineConfig;
    originStage: string;
    originTransitionIdx: number;
    template: PipelineTemplate;
    substitutions?: SubstitutionMap;
}
export interface StitchSingleResult {
    updatedConfig: PipelineConfig;
    insertedStages: PipelineStage[];
    entryName: string;
    insertId: string;
}
export interface StitchParallelInput {
    config: PipelineConfig;
    originStage: string;
    originTransitionIdx: number;
    template: PipelineTemplate;
    count: number;
    perCopySubstitutions?: SubstitutionMap[];
}
export interface StitchParallelResult {
    updatedConfig: PipelineConfig;
    insertedStages: PipelineStage[];
    entryNames: string[];
    barrierName: string;
    insertId: string;
}
export declare function renamedStage(origin: string, templateName: string, copyIndex: number, stageName: string): string;
export declare function barrierNameFor(origin: string, templateName: string): string;
export declare function stitchSingle(input: StitchSingleInput): StitchSingleResult;
export declare function stitchParallel(input: StitchParallelInput): StitchParallelResult;
export declare function assertConfigAcyclic(config: PipelineConfig): void;
export declare function assertNoNameCollision(config: PipelineConfig): void;
//# sourceMappingURL=stitch.d.ts.map