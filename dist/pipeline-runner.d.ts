import { AdditionalMount, RegisteredGroup } from './types.js';
export interface PipelineTransition {
    marker: string;
    next?: string | string[] | null;
    next_dynamic?: boolean;
    retry?: boolean;
    prompt?: string;
}
export interface PipelineStage {
    name: string;
    prompt?: string;
    prompts?: string[];
    prompt_append?: string;
    image?: string;
    command?: string;
    successMarker?: string;
    errorMarker?: string;
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
    fan_in?: 'all' | 'dynamic';
    transitions: PipelineTransition[];
}
export interface PipelineConfig {
    stages: PipelineStage[];
    entryStage?: string;
}
export interface PipelineState {
    currentStage: string | string[] | null;
    completedStages: string[];
    lastUpdated: string;
    status: 'running' | 'error' | 'success';
    activations?: Record<string, number>;
    completions?: Record<string, number>;
}
/**
 * Derive a short tag from a custom pipeline file path.
 * e.g. '/abs/path/to/my-pipeline.json' → 'my-pipeline'
 *      undefined (default PIPELINE.json) → undefined
 */
export declare function pipelineTagFromPath(pipelinePath: string | undefined): string | undefined;
export declare function savePipelineState(groupDir: string, state: PipelineState, tag?: string): void;
export declare function loadPipelineState(groupDir: string, tag?: string): PipelineState | null;
interface StageMarkerResult {
    matched: PipelineTransition | null;
    payload: string | null;
}
/**
 * Parse stage markers dynamically from the stage's transitions array.
 *
 * Supported forms (first match wins across transitions):
 *   [MARKER]                                          — no payload
 *   [MARKER: short inline payload]                    — single-line payload
 *   [MARKER]
 *   ---PAYLOAD_START---
 *   free-form multi-line payload (any chars incl. ])
 *   ---PAYLOAD_END---                                 — fenced payload
 *
 * The fenced form is preferred for anything non-trivial. Payload must not
 * contain the literal sentinel `---PAYLOAD_END---` (non-greedy match stops
 * at the first occurrence).
 */
export declare function parseStageMarkers(resultTexts: string[], transitions: PipelineTransition[]): StageMarkerResult;
export declare class PipelineRunner {
    private group;
    private chatJid;
    private config;
    private notify;
    private onProcess;
    private groupDir;
    private runId;
    private pipelineTag;
    private manifest;
    private aborted;
    private activeHandles;
    private stageSessionIds;
    constructor(group: RegisteredGroup, chatJid: string, pipelineConfig: PipelineConfig, notify: (text: string) => Promise<void>, onProcess: (proc: import('child_process').ChildProcess, containerName: string) => void, groupDir?: string, runId?: string, pipelineTag?: string);
    getRunId(): string;
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
     * Validate plan, initialize git if needed, write manifest, create log stream.
     * Returns null on validation failure.
     */
    private initRun;
    /**
     * Normalize transition.next to an array of target names (empty for pipeline end).
     */
    private static nextTargets;
    /**
     * Build predecessor map: for each stage, which stages have non-retry
     * transitions pointing to it?
     */
    private buildPredecessorMap;
    /**
     * Build reachability map: for each stage, which stages can it
     * transitively reach through the pipeline's transition graph?
     * Used by dynamic fan-in to determine if an unactivated predecessor
     * could still be activated by a currently-alive stage.
     */
    private buildReachabilityMap;
    /**
     * Check if a stage's fan-in gate is satisfied:
     * all predecessors must appear in completedStages.
     */
    private static fanInReady;
    /**
     * Check if a stage's dynamic fan-in gate is satisfied:
     * only predecessors that have been activated are checked.
     * A predecessor is "done" if its completion count matches its activation count.
     *
     * An unactivated predecessor (activation=0) is only skipped if no alive
     * stage can transitively reach it. If any alive stage could still activate
     * the predecessor via retry/error paths, the gate stays closed.
     */
    private static fanInReadyDynamic;
    /**
     * Determine entry stage and resume from previous state if applicable.
     */
    private resolveEntryStage;
    /**
     * Handle stage result: no-match → retry prompt, retry → re-send,
     * transition → close container and advance FSM.
     */
    private handleStageResult;
    /**
     * Save final pipeline state, close manifest and log stream.
     */
    private finalizeRun;
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
/**
 * Load and validate a pipeline config.
 * @param pipelinePath - Absolute path to a pipeline JSON file. When provided,
 *   groupFolder/groupDir are ignored and the file is loaded directly.
 * Returns null if the file doesn't exist.
 */
export declare function loadPipelineConfig(groupFolder: string, groupDir?: string, pipelinePath?: string): PipelineConfig | null;
export {};
//# sourceMappingURL=pipeline-runner.d.ts.map