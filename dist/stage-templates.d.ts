export interface StageTemplate {
    name: string;
    description: string;
    prompt: string;
    mounts: Record<string, 'ro' | 'rw' | null>;
    transitions: Array<{
        marker: string;
        next: string | null;
        prompt?: string;
    }>;
}
export declare const STAGE_TEMPLATES: Record<string, StageTemplate>;
export declare function getTemplate(name: string): StageTemplate | undefined;
export declare function listTemplates(): StageTemplate[];
//# sourceMappingURL=stage-templates.d.ts.map