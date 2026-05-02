import type { AdditionalMount } from './types.js';
export interface PipelineTransition {
    marker?: string;
    next?: string | string[] | null;
    template?: string;
    count?: number;
    countFrom?: 'payload';
    substitutionsFrom?: 'payload';
    joinPolicy?: JoinPolicy;
    outcome?: TransitionOutcome;
    afterTimeout?: boolean;
    prompt?: string;
}
export type StageKind = 'agent' | 'command';
export type TransitionOutcome = 'success' | 'error';
export type JoinPolicy = 'all_success' | 'any_success' | 'all_settled';
export interface PipelineStage {
    name: string;
    kind?: StageKind;
    agent?: string;
    prompt?: string;
    image?: string;
    command?: string;
    successMarker?: string;
    errorMarker?: string;
    timeout?: number;
    chat?: boolean;
    mounts: Record<string, 'ro' | 'rw' | null | undefined>;
    devices?: string[];
    gpu?: boolean;
    runAsRoot?: boolean;
    privileged?: boolean;
    env?: Record<string, string>;
    exclusive?: string;
    hostMounts?: AdditionalMount[];
    mcpAccess?: string[];
    resumeSession?: boolean;
    fan_in?: 'all';
    join?: {
        policy: JoinPolicy;
        expectedCopies: number;
        copyPrefixes: string[];
    };
    transitions: PipelineTransition[];
}
/**
 * Resolve the effective stage kind - explicit `kind` wins, otherwise infer
 * from presence of `command`.
 */
export declare function resolveStageKind(stage: PipelineStage): StageKind;
export interface PipelineConfig {
    stages: PipelineStage[];
    entryStage?: string;
}
//# sourceMappingURL=pipeline-types.d.ts.map