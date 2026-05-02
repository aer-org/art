import { type PipelineConfig } from './pipeline-types.js';
import { RegisteredGroup } from './types.js';
export type { JoinPolicy, PipelineConfig, PipelineStage, PipelineTransition, StageKind, TransitionOutcome, } from './pipeline-types.js';
export { resolveStageKind } from './pipeline-types.js';
export type { PipelineState } from './pipeline-state.js';
export { assertValidScopeId, loadPipelineState, pipelineTagFromPath, savePipelineState, } from './pipeline-state.js';
export type { StitchDirective } from './pipeline-transitions.js';
export { parseStageMarkers, resolveStitchInputs, } from './pipeline-transitions.js';
export { loadPipelineConfig } from './pipeline-config.js';
export declare class PipelineRunner {
    private group;
    private chatJid;
    private config;
    private notify;
    private onProcess;
    private groupDir;
    private stateDir;
    private bundleDir;
    private runId;
    private pipelineTag;
    private scopeId;
    private manifest;
    private aborted;
    private activeHandles;
    private stageSessionIds;
    private joinSettlements;
    private activations;
    private completions;
    private baseStageCount;
    constructor(group: RegisteredGroup, chatJid: string, pipelineConfig: PipelineConfig, notify: (text: string) => Promise<void>, onProcess: (proc: import('child_process').ChildProcess, containerName: string) => void, groupDir?: string, runId?: string, pipelineTag?: string, scopeId?: string, bundleDir?: string);
    /**
     * Compute the virtual sub-group folder for a stage container.
     * When scopeId is set, embed it so sibling runners that spawn the same
     * stage name get distinct IPC / sessions / conversations paths.
     */
    private stageSubFolder;
    /**
     * Sub-paths must be relative, non-empty, and cannot contain ".." segments
     * or start with a leading slash. Keeps the mount confined under its parent.
     */
    private isValidSubPath;
    getRunId(): string;
    private serializeJoinSettlements;
    private restoreJoinSettlements;
    private saveRunnerState;
    private copyIndexForJoinArrival;
    private recordJoinSettlement;
    private isJoinReady;
    private evaluateJoinOutcome;
    abort(): Promise<void>;
    /** Send a visually prominent banner to TUI for stage transitions */
    private notifyBanner;
    /**
     * Build all internal mounts for a stage: group mounts + project mount +
     * __art__ shadow + project:* sub-path overrides.
     * Shared by both agent mode and command mode.
     */
    private buildStageMounts;
    /**
     * Spawn a stage container as a virtual sub-group.
     * The container starts with an initial prompt and enters the IPC wait loop.
     */
    private spawnStageContainer;
    /**
     * Run a command-mode stage: spawn container with sh -c, collect stdout,
     * parse markers from output.
     */
    private runStageCommand;
    /**
     * Close a stage container and wait for it to exit (with timeout).
     */
    private closeAndWait;
    /**
     * Build commonRules dynamically from a stage's transitions.
     */
    private buildCommonRules;
    /**
     * Validate plan, write manifest, create log stream.
     * Returns null on validation failure.
     */
    private initRun;
    /**
     * Normalize transition.next to an array of target names (empty for pipeline end).
     */
    private static nextTargets;
    /**
     * Build predecessor map: for each stage, which stages have primary
     * transitions pointing to it?
     */
    private buildPredecessorMap;
    /**
     * Check if a stage's fan-in gate is satisfied:
     * all predecessors must appear in completedStages.
     */
    /**
     * Execute a stitch operation, mutating this.config to include the inserted
     * stages and returning the new host transition target (single name or an
     * array for parallel stitch).
     */
    private performStitch;
    private static fanInReady;
    /**
     * Determine entry stage and resume from previous state if applicable.
     * Restores activations/completions/joinSettlements into instance fields.
     */
    private resolveEntryStage;
    /**
     * Handle stage result: no-match → feedback prompt and re-send,
     * transition → close container and advance FSM.
     */
    private handleStageResult;
    /**
     * Save final pipeline state, close manifest and log stream.
     */
    private finalizeRun;
    private runJoinStage;
    /**
     * Run a single stage to completion (spawn → turn loop → close).
     * Self-contained: handles retries and container respawns internally.
     */
    private runSingleStage;
    /**
     * Main FSM loop with fan-out/fan-in support.
     * Spawns stage containers on-demand, runs parallel stages concurrently,
     * and gates fan-in stages until all predecessors complete.
     */
    run(): Promise<'success' | 'error'>;
}
//# sourceMappingURL=pipeline-runner.d.ts.map