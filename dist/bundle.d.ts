export interface BundleMetadata {
    remote: string;
    pipeline_name: string;
    tag: string;
    project?: string;
    pulled_at: string;
    hashes: Record<string, string>;
}
export declare function contentHash(content: string): string;
export declare function loadBundleMeta(dir: string): BundleMetadata | null;
export declare function saveBundleMeta(dir: string, meta: BundleMetadata): void;
export declare function relativeBundlePath(dir: string, filePath: string): string;
export interface BundleFile {
    relPath: string;
    absPath: string;
    content: string;
    hash: string;
}
export declare function readBundleFiles(dir: string): BundleFile[];
export declare function classifyFile(relPath: string): {
    kind: 'agent' | 'pipeline' | 'template' | 'dockerfile' | 'unknown';
    name: string;
};
//# sourceMappingURL=bundle.d.ts.map