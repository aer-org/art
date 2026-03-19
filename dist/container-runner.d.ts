/**
 * Container Runner for AerArt
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess } from 'child_process';
import fs from 'fs';
import { RegisteredGroup } from './types.js';
export interface ContainerInput {
    prompt: string;
    sessionId?: string;
    groupFolder: string;
    chatJid: string;
    isMain: boolean;
    isScheduledTask?: boolean;
    assistantName?: string;
    endOnFirstResult?: boolean;
    runId?: string;
}
export interface ContainerOutput {
    status: 'success' | 'error';
    result: string | null;
    newSessionId?: string;
    error?: string;
}
interface VolumeMount {
    hostPath: string;
    containerPath: string;
    readonly: boolean;
}
export declare function buildContainerArgs(mounts: VolumeMount[], containerName: string, devices?: string[], runAsRoot?: boolean, image?: string, entrypoint?: string, runId?: string): string[];
export declare function runContainerAgent(group: RegisteredGroup, input: ContainerInput, onProcess: (proc: ChildProcess, containerName: string) => void, onOutput?: (output: ContainerOutput) => Promise<void>, logStream?: fs.WriteStream): Promise<ContainerOutput>;
/**
 * Spawn a sub-agent in a separate container.
 * Creates a virtual group with its own folder, IPC, and session.
 * The sub-agent's output is sent to the parent's chatJid via streaming callbacks.
 */
export declare function spawnSubAgentContainer(opts: {
    agentId: string;
    prompt: string;
    name: string;
    parentFolder: string;
    chatJid: string;
    isMain: boolean;
    mounts: Array<{
        hostPath: string;
        containerPath?: string;
        readonly?: boolean;
    }>;
    systemPrompt?: string;
    onOutput?: (output: ContainerOutput) => Promise<void>;
}): Promise<void>;
export declare function writeTasksSnapshot(groupFolder: string, isMain: boolean, tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
}>): void;
export interface AvailableGroup {
    jid: string;
    name: string;
    lastActivity: string;
    isRegistered: boolean;
}
/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export declare function writeGroupsSnapshot(groupFolder: string, isMain: boolean, groups: AvailableGroup[], registeredJids: Set<string>): void;
export {};
//# sourceMappingURL=container-runner.d.ts.map