export interface EngineSetupResult {
    engineRoot: string;
    folderName: string;
    dataDir: string;
    runtimeBin: string;
}
export declare function setupEngine(opts: {
    projectDir: string;
    artDir: string;
    credentialProxyPort?: number;
    ensureImages?: boolean;
}): Promise<EngineSetupResult>;
//# sourceMappingURL=engine-setup.d.ts.map