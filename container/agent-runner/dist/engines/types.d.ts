import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
export type AgentProvider = 'claude' | 'codex';
export interface ExternalMcpServerInput {
    ref: string;
    name: string;
    transport: 'stdio' | 'http';
    tools: string[];
    startupTimeoutSec?: number;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    bearerTokenEnvVar?: string;
}
export interface EngineContainerInput {
    prompt: string;
    sessionId?: string;
    provider?: AgentProvider;
    groupFolder: string;
    chatJid: string;
    isMain: boolean;
    isScheduledTask?: boolean;
    assistantName?: string;
    endOnFirstResult?: boolean;
    ephemeralSystemPrompt?: string;
    externalMcpServers?: ExternalMcpServerInput[];
}
export interface RunTurnInput {
    prompt: string;
    sessionId?: string;
    mcpServerPath: string;
    containerInput: EngineContainerInput;
    sdkEnv: Record<string, string | undefined>;
    resumeAt?: string;
    ephemeralAppend?: string;
    onCloseRequested: () => boolean;
    pollIpcMessages?: () => string[];
    preCompactHookFactory?: (assistantName?: string) => HookCallback;
}
export type NormalizedEvent = {
    type: 'session.started';
    sessionId: string;
} | {
    type: 'assistant.text';
    text: string;
} | {
    type: 'tool.started';
    id: string;
    name: string;
    preview?: string;
    input?: unknown;
    assistantText?: string;
} | {
    type: 'tool.result';
    id: string;
    isError: boolean;
    errorText?: string;
} | {
    type: 'assistant.checkpoint';
    messageId?: string;
} | {
    type: 'task.notification';
    taskId: string;
    status: string;
    summary: string;
} | {
    type: 'turn.result';
    result: string | null;
} | {
    type: 'turn.error';
    error: string;
};
export interface TurnRunResult {
    newSessionId?: string;
    lastAssistantUuid?: string;
    closedDuringQuery: boolean;
    resultTexts: string[];
}
export interface AgentEngine {
    runTurn(input: RunTurnInput): AsyncGenerator<NormalizedEvent>;
}
