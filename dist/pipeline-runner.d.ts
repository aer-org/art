import { RegisteredGroup } from './types.js';
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
    runAsRoot?: boolean;
    exclusive?: string;
    transitions: PipelineTransition[];
}
export interface PipelineConfig {
    stages: PipelineStage[];
    entryStage?: string;
    errorPolicy: {
        maxConsecutive: number;
        debugOnMaxErrors: boolean;
    };
}
export interface PipelineState {
    currentStage: string | null;
    completedStages: string[];
    lastUpdated: string;
    status: 'running' | 'error' | 'success';
}
export declare function savePipelineState(groupDir: string, state: PipelineState): void;
export declare function loadPipelineState(groupDir: string): PipelineState | null;
export declare class PipelineRunner {
    private group;
    private chatJid;
    private config;
    private notify;
    private onProcess;
    private groupDir;
    constructor(group: RegisteredGroup, chatJid: string, pipelineConfig: PipelineConfig, notify: (text: string) => Promise<void>, onProcess: (proc: import('child_process').ChildProcess, containerName: string) => void, groupDir?: string);
    /** Send a visually prominent banner to TUI for stage transitions */
    private notifyBanner;
    /**
     * Build internal mounts for a stage based on its mount policy.
     * Returns absolute container paths under /workspace/group/ for direct overlay.
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
    /**
     * Spawn a one-off debug container to analyze a repeated error.
     */
    private runDebugSession;
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
//# sourceMappingURL=pipeline-runner.d.ts.map