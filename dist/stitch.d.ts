/**
 * Stitch core: dynamically insert a pipeline template into a running
 * PipelineConfig's stage graph. Pure graph-in / graph-out functions — no I/O.
 *
 * Insertion modes:
 *   stitchSingle   — clone template once, synthesize a join stage, and rewire
 *                    the host transition to the template entry
 *   stitchParallel — clone template N times, synthesize a shared join stage,
 *                    and rewire the host transition to the N entries
 *
 * Semantics:
 *   - Inside a stitched template, authored `next: null` means "this template
 *     invocation ends here". Stitch rewires those terminal edges to the
 *     synthetic join stage for this invocation.
 *   - The synthetic join evaluates the configured join policy and either
 *     continues to the authored downstream `next` or ends the pipeline with
 *     an error.
 */
import type { JoinPolicy, PipelineConfig, PipelineStage } from './pipeline-types.js';
import type { PipelineTemplate } from './pipeline-template.js';
export declare const STITCH_SUBSTITUTION_FIELDS: readonly string[];
export declare const RESERVED_SUBSTITUTION_KEYS: readonly ["index", "insertId"];
export type SubstitutionValue = string | number | boolean;
export type SubstitutionMap = Record<string, SubstitutionValue>;
export interface StitchSingleInput {
    config: PipelineConfig;
    originStage: string;
    originTransitionIdx: number;
    template: PipelineTemplate;
    downstreamNext: string | null;
    joinPolicy: JoinPolicy;
    substitutions?: SubstitutionMap;
}
export interface StitchSingleResult {
    updatedConfig: PipelineConfig;
    insertedStages: PipelineStage[];
    entryName: string;
    joinName: string;
    insertId: string;
}
export interface StitchParallelInput {
    config: PipelineConfig;
    originStage: string;
    originTransitionIdx: number;
    template: PipelineTemplate;
    downstreamNext: string | null;
    joinPolicy: JoinPolicy;
    count: number;
    perCopySubstitutions?: SubstitutionMap[];
}
export interface StitchParallelResult {
    updatedConfig: PipelineConfig;
    insertedStages: PipelineStage[];
    entryNames: string[];
    joinName: string;
    insertId: string;
}
export declare function renamedStage(origin: string, templateName: string, copyIndex: number, stageName: string): string;
export declare function joinNameFor(origin: string, templateName: string): string;
export declare function copyPrefixFor(origin: string, templateName: string, copyIndex: number): string;
export declare function stitchSingle(input: StitchSingleInput): StitchSingleResult;
export declare function stitchParallel(input: StitchParallelInput): StitchParallelResult;
export declare function assertConfigAcyclic(config: PipelineConfig): void;
export declare function assertNoNameCollision(config: PipelineConfig): void;
//# sourceMappingURL=stitch.d.ts.map