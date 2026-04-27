import type { PipelineStage } from './pipeline-runner.js';
export interface PipelineTemplate {
    name: string;
    entry: string;
    stages: PipelineStage[];
}
/**
 * Resolve the absolute path for a template given a bundleDir.
 * Enforces containment — the resolved path must remain inside the templates
 * dir, rejecting traversal (`..`, absolute names).
 */
export declare function resolveTemplatePath(bundleDir: string, name: string): string;
export declare function loadPipelineTemplate(bundleDir: string, name: string): PipelineTemplate;
/**
 * Validate a parsed template object and return a normalized PipelineTemplate.
 * Throws on any schema violation. Pure function — no I/O.
 */
export declare function validatePipelineTemplate(input: unknown, name: string): PipelineTemplate;
//# sourceMappingURL=pipeline-template.d.ts.map