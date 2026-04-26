export interface InitScaffoldTransition {
    marker: string;
    next: string | null;
    prompt?: string;
}
export interface InitScaffoldStage {
    name: string;
    prompt: string;
    mounts: Record<string, 'ro' | 'rw' | null>;
    transitions: InitScaffoldTransition[];
}
export declare function buildDefaultInitStages(): InitScaffoldStage[];
//# sourceMappingURL=default-stage-presets.d.ts.map