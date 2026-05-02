import type { PipelineConfig } from './pipeline-types.js';
/**
 * Load and validate a pipeline config.
 * @param pipelinePath - Absolute path to a pipeline JSON file. When provided,
 *   groupFolder/groupDir are ignored and the file is loaded directly.
 * Bundle-relative assets (agents/, templates/) resolve from the directory
 * containing the pipeline file (bundleDir).
 * Returns null if the file doesn't exist.
 */
export declare function loadPipelineConfig(groupFolder: string, groupDir?: string, pipelinePath?: string): PipelineConfig | null;
//# sourceMappingURL=pipeline-config.d.ts.map