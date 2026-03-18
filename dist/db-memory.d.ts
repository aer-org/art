/**
 * Pure-JS in-memory database backend.
 * Used when better-sqlite3 is not available (e.g. art CLI installs via npm).
 * All data lives in Maps/Arrays and is lost when the process exits.
 */
import { NewMessage, RegisteredGroup, ScheduledTask, TaskRunLog } from './types.js';
export interface ChatInfo {
    jid: string;
    name: string;
    last_message_time: string;
    channel: string;
    is_group: number;
}
export interface PipelineStageIssue {
    id: number;
    group_folder: string;
    stage: string;
    tool: string;
    tool_use_id: string;
    input_preview: string | null;
    input_hash: string;
    error_content: string;
    assistant_context: string | null;
    turn_index: number | null;
    timestamp: string;
    resolved: number;
}
export declare function initDatabase(): void;
export declare function _initTestDatabase(): void;
export declare function storeChatMetadata(chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean): void;
export declare function updateChatName(chatJid: string, name: string): void;
export declare function getAllChats(): ChatInfo[];
export declare function getLastGroupSync(): string | null;
export declare function setLastGroupSync(): void;
export declare function storeMessage(msg: NewMessage): void;
export declare function storeMessageDirect(msg: {
    id: string;
    chat_jid: string;
    sender: string;
    sender_name: string;
    content: string;
    timestamp: string;
    is_from_me: boolean;
    is_bot_message?: boolean;
}): void;
export declare function getNewMessages(jids: string[], lastTimestamp: string, botPrefix: string, limit?: number): {
    messages: NewMessage[];
    newTimestamp: string;
};
export declare function getMessagesSince(chatJid: string, sinceTimestamp: string, botPrefix: string, limit?: number): NewMessage[];
export declare function createTask(task: Omit<ScheduledTask, 'last_run' | 'last_result'>): void;
export declare function getTaskById(id: string): ScheduledTask | undefined;
export declare function getTasksForGroup(groupFolder: string): ScheduledTask[];
export declare function getAllTasks(): ScheduledTask[];
export declare function updateTask(id: string, updates: Partial<Pick<ScheduledTask, 'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'>>): void;
export declare function deleteTask(id: string): void;
export declare function getDueTasks(): ScheduledTask[];
export declare function updateTaskAfterRun(id: string, nextRun: string | null, lastResult: string): void;
export declare function logTaskRun(log: TaskRunLog): void;
export declare function getRouterState(key: string): string | undefined;
export declare function setRouterState(key: string, value: string): void;
export declare function getSession(groupFolder: string): string | undefined;
export declare function setSession(groupFolder: string, sessionId: string): void;
export declare function getAllSessions(): Record<string, string>;
export declare function getRegisteredGroup(jid: string): (RegisteredGroup & {
    jid: string;
}) | undefined;
export declare function setRegisteredGroup(jid: string, group: RegisteredGroup): void;
export declare function getAllRegisteredGroups(): Record<string, RegisteredGroup>;
export declare function insertPipelineIssue(issue: {
    groupFolder: string;
    stage: string;
    tool: string;
    toolUseId: string;
    inputPreview: string;
    inputHash: string;
    errorContent: string;
    assistantContext?: string;
    turnIndex?: number;
    timestamp: string;
}): void;
export declare function resolvePipelineIssues(inputHash: string, stage: string, groupFolder: string): void;
export declare function getPipelineIssues(groupFolder: string, stage?: string): PipelineStageIssue[];
export declare function getUnresolvedIssueCount(groupFolder: string, stage: string): number;
//# sourceMappingURL=db-memory.d.ts.map