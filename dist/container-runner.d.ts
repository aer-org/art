/**
 * Container Runner for AerArt
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess } from 'child_process';
import fs from 'fs';
/**
 * Prefix each line in a chunk with `[stageName] `.
 * Handles partial lines: returns { prefixed, remainder }.
 * Caller should carry `remainder` across chunks and flush it on stream end.
 */
export declare function prefixLogLines(chunk: string, stageName: string, remainder: string): {
    prefixed: string;
    remainder: string;
};
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
export declare function buildContainerArgs(mounts: VolumeMount[], containerName: string, devices?: string[], gpu?: boolean, runAsRoot?: boolean, image?: string, entrypoint?: string, runId?: string, privileged?: boolean, env?: Record<string, string>): string[];
export declare function runContainerAgent(group: RegisteredGroup, input: ContainerInput, onProcess: (proc: ChildProcess, containerName: string) => void, onOutput?: (output: ContainerOutput) => Promise<void>, logStream?: fs.WriteStream): Promise<ContainerOutput>;
export {};
//# sourceMappingURL=container-runner.d.ts.map