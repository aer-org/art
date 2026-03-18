import type { ServerResponse } from 'http';
interface Message {
    role: 'user' | 'assistant';
    content: string;
}
export interface ConversationState {
    phase: 'analysis' | 'direction';
    messages: Message[];
    codebaseContext: string;
    analysisResult?: string;
}
export declare function scanCodebase(projectDir: string): string;
export declare function initChat(apiKey: string, projectDir: string, res: ServerResponse): Promise<void>;
export declare function sendMessage(apiKey: string, projectDir: string, userMessage: string, res: ServerResponse): Promise<void>;
export declare function advancePhase(projectDir: string, artDir: string): {
    ok: boolean;
    phase: string;
    error?: string;
};
export declare function getChatState(projectDir: string, hasAuth: boolean): {
    hasAuth: boolean;
    phase: string | null;
    messageCount: number;
};
export {};
//# sourceMappingURL=llm-chat.d.ts.map