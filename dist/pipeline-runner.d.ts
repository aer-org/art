import { RegisteredGroup } from './types.js';
export declare function generateRunId(): string;
export interface RunManifest {
    runId: string;
    pid: number;
    startTime: string;
    endTime?: string;
    status: 'running' | 'success' | 'error' | 'cancelled';
    stages: Array<{
        name: string;
        status: string;
        duration?: number;
    }>;
    logFile?: string;
    outputLogFile?: string;
}
export interface CurrentRunInfo {
    runId: string;
    pid: number;
    startTime: string;
}
export declare function writeCurrentRun(groupDir: string, info: CurrentRunInfo): void;
export declare function readCurrentRun(groupDir: string): CurrentRunInfo | null;
export declare function removeCurrentRun(groupDir: string): void;
export declare function writeRunManifest(groupDir: string, manifest: RunManifest): void;
export declare function readRunManifest(groupDir: string, runId: string): RunManifest | null;
export declare function listRunManifests(groupDir: string): RunManifest[];
/**
 * Check if a PID is alive.
 */
export declare function isPidAlive(pid: number): boolean;
export interface PipelineTransition {
    marker: string;
    next?: string | null;
    retry?: boolean;
    prompt?: string;
}
export interface PipelineStage {
    name: string;
    prompt: string;
    image?: string;
    command?: string;
    mounts: Record<string, 'ro' | 'rw' | null | undefined>;
    devices?: string[];
    gpu?: boolean;
    runAsRoot?: boolean;
    exclusive?: string;
    transitions: PipelineTransition[];
}
export interface PipelineConfig {
    stages: PipelineStage[];
    entryStage?: string;
}
export interface PipelineState {
    currentStage: string | null;
    completedStages: string[];
    lastUpdated: string;
    status: 'running' | 'error' | 'success';
}
export declare function savePipelineState(groupDir: string, state: PipelineState): void;
export declare function loadPipelineState(groupDir: string): PipelineState | null;
interface StageMarkerResult {
    matched: PipelineTransition | null;
    payload: string | null;
}
/**
 * Parse stage markers dynamically from the stage's transitions array.
 * Matches `[MARKER]` or `[MARKER: payload]` patterns, first match wins.
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
    private manifest;
    private aborted;
    private currentHandle;
    private stageSessionIds;
    constructor(group: RegisteredGroup, chatJid: string, pipelineConfig: PipelineConfig, notify: (text: string) => Promise<void>, onProcess: (proc: import('child_process').ChildProcess, containerName: string) => void, groupDir?: string, runId?: string);
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
     * Main FSM loop. Spawns each stage container on-demand and closes it when leaving.
     */
    run(): Promise<'success' | 'error'>;
}
export interface AgentTeamConfig {
    agents: Array<{
        name: string;
        folder: string;
    }>;
}
/**
 * Load and validate AGENT_TEAM.json from a group folder.
 * Returns null if the file doesn't exist.
 */
export declare function loadAgentTeamConfig(groupFolder: string): AgentTeamConfig | null;
/**
 * Load and validate PIPELINE.json from a group folder.
 * Returns null if the file doesn't exist.
 */
export declare function loadPipelineConfig(groupFolder: string, groupDir?: string): PipelineConfig | null;
export {};
//# sourceMappingURL=pipeline-runner.d.ts.map