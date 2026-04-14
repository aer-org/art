export interface PromptRecord {
    id: string;
    title?: string;
    content: string;
    updated_at?: string;
    tags?: string[];
}
export interface StagePromptSource {
    prompt?: string;
    prompts?: string[];
    prompt_append?: string;
}
export interface ResolvedStagePrompt {
    text: string;
    promptIds: string[];
    promptHash: string | null;
}
export declare function getPromptDbPath(): string;
export declare function listPrompts(dbPath?: string): PromptRecord[];
export declare function getPromptById(id: string, dbPath?: string): PromptRecord | null;
export declare function queryPrompts(query: string, dbPath?: string): PromptRecord[];
export declare function resolvePromptIds(ids: string[], dbPath?: string): PromptRecord[];
export declare function resolveStagePrompt(stage: StagePromptSource, dbPath?: string): ResolvedStagePrompt;
export declare function promptPreview(record: PromptRecord, maxLen?: number): string;
//# sourceMappingURL=prompt-store.d.ts.map