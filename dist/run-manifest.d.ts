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
export declare function writeRunManifest(stateDir: string, manifest: RunManifest): void;
export declare function readRunManifest(stateDir: string, runId: string): RunManifest | null;
export declare function listRunManifests(stateDir: string): RunManifest[];
//# sourceMappingURL=run-manifest.d.ts.map