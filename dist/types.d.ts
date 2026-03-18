export interface AdditionalMount {
    hostPath: string;
    containerPath?: string;
    readonly?: boolean;
}
/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/aer-art/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
    allowedRoots: AllowedRoot[];
    blockedPatterns: string[];
    nonMainReadOnly: boolean;
}
export interface AllowedRoot {
    path: string;
    allowReadWrite: boolean;
    description?: string;
}
export interface ContainerConfig {
    image?: string;
    additionalMounts?: AdditionalMount[];
    additionalDevices?: string[];
    runAsRoot?: boolean;
    timeout?: number;
    workspaceDir?: string;
    internalMounts?: Array<{
        hostPath: string;
        containerPath: string;
        readonly: boolean;
    }>;
}
export interface RegisteredGroup {
    name: string;
    folder: string;
    trigger: string;
    added_at: string;
    containerConfig?: ContainerConfig;
    requiresTrigger?: boolean;
    isMain?: boolean;
}
export interface NewMessage {
    id: string;
    chat_jid: string;
    sender: string;
    sender_name: string;
    content: string;
    timestamp: string;
    is_from_me?: boolean;
    is_bot_message?: boolean;
}
export interface ScheduledTask {
    id: string;
    group_folder: string;
    chat_jid: string;
    prompt: string;
    schedule_type: 'cron' | 'interval' | 'once';
    schedule_value: string;
    context_mode: 'group' | 'isolated';
    next_run: string | null;
    last_run: string | null;
    last_result: string | null;
    status: 'active' | 'paused' | 'completed';
    created_at: string;
}
export interface TaskRunLog {
    task_id: string;
    run_at: string;
    duration_ms: number;
    status: 'success' | 'error';
    result: string | null;
    error: string | null;
}
export interface Channel {
    name: string;
    connect(): Promise<void>;
    sendMessage(jid: string, text: string): Promise<void>;
    isConnected(): boolean;
    ownsJid(jid: string): boolean;
    disconnect(): Promise<void>;
    setTyping?(jid: string, isTyping: boolean): Promise<void>;
    syncGroups?(force: boolean): Promise<void>;
}
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;
export type OnChatMetadata = (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) => void;
//# sourceMappingURL=types.d.ts.map