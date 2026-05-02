import type { PipelineStage } from './pipeline-types.js';
export interface PipelineState {
    version?: 3;
    currentStage: string | string[] | null;
    completedStages: string[];
    lastUpdated: string;
    status: 'running' | 'error' | 'success';
    activations?: Record<string, number>;
    completions?: Record<string, number>;
    insertedStages?: PipelineStage[];
    joinSettlements?: Record<string, Record<string, 'success' | 'error'>>;
}
export declare function assertValidScopeId(scopeId: string): void;
/**
 * Derive a short tag from a custom pipeline file path.
 * e.g. '/abs/path/to/my-pipeline.json' -> 'my-pipeline'
 *      undefined (default PIPELINE.json) -> undefined
 */
export declare function pipelineTagFromPath(pipelinePath: string | undefined): string | undefined;
export declare function savePipelineState(stateDir: string, state: PipelineState, tag?: string, scopeId?: string): void;
export declare function loadPipelineState(stateDir: string, tag?: string, scopeId?: string): PipelineState | null;
//# sourceMappingURL=pipeline-state.d.ts.map