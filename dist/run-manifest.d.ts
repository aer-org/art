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
export declare function isPidAlive(pid: number): boolean;
//# sourceMappingURL=run-manifest.d.ts.map