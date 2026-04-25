import { type SubstitutionMap } from './stitch.js';
import { AdditionalMount, RegisteredGroup } from './types.js';
export interface PipelineTransition {
    marker: string;
    next?: string | string[] | null;
    template?: string;
    count?: number;
    countFrom?: 'payload';
    substitutionsFrom?: 'payload';
    prompt?: string;
}
export type StageKind = 'agent' | 'command';
export interface PipelineStage {
    name: string;
    kind?: StageKind;
    agent?: string;
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
    fan_in?: 'all';
    transitions: PipelineTransition[];
}
/**
 * Resolve the effective stage kind — explicit `kind` wins, otherwise infer
 * from presence of `command`.
 */
export declare function resolveStageKind(stage: PipelineStage): StageKind;
export interface PipelineConfig {
    stages: PipelineStage[];
    entryStage?: string;
}
export type StitchDirective = {
    mode: 'single';
    subs?: SubstitutionMap;
} | {
    mode: 'parallel';
    count: number;
    perCopySubs?: SubstitutionMap[];
};
/**
 * Pure helper: given a matched transition and the payload captured from the
 * agent's marker, return the StitchDirective that performStitch should use.
 * Throws with a descriptive message on any invalid payload shape.
 *
 * Callers must pass `payload` only when the transition has `countFrom:
 * "payload"`; otherwise the argument is ignored. The caller catches thrown
 * errors and surfaces them as STAGE_ERROR outcomes.
 */
export declare function resolveStitchInputs(t: PipelineTransition, payload: string | null): StitchDirective;
export interface PipelineState {
    version?: 2;
    currentStage: string | string[] | null;
    completedStages: string[];
    lastUpdated: string;
    status: 'running' | 'error' | 'success';
    activations?: Record<string, number>;
    completions?: Record<string, number>;
    insertedStages?: PipelineStage[];
}
export declare function assertValidScopeId(scopeId: string): void;
/**
 * Derive a short tag from a custom pipeline file path.
 * e.g. '/abs/path/to/my-pipeline.json' → 'my-pipeline'
 *      undefined (default PIPELINE.json) → undefined
 */
export declare function pipelineTagFromPath(pipelinePath: string | undefined): string | undefined;
export declare function savePipelineState(groupDir: string, state: PipelineState, tag?: string, scopeId?: string): void;
export declare function loadPipelineState(groupDir: string, tag?: string, scopeId?: string): PipelineState | null;
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
 *
 * Defensive unwrap: if a fenced payload body is *solely* an inline form of
 * the same marker (`[MARKER]` or `[MARKER: value]`), the inner value (or
 * null) is returned. This protects against agents double-wrapping the
 * marker — emitting inline syntax inside the fence — which would otherwise
 * leak literal brackets into downstream dispatchers.
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
    private scopeId;
    private manifest;
    private aborted;
    private activeHandles;
    private stageSessionIds;
    private baseStageCount;
    constructor(group: RegisteredGroup, chatJid: string, pipelineConfig: PipelineConfig, notify: (text: string) => Promise<void>, onProcess: (proc: import('child_process').ChildProcess, containerName: string) => void, groupDir?: string, runId?: string, pipelineTag?: string, scopeId?: string);
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