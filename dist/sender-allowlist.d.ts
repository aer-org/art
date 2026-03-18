export interface ChatAllowlistEntry {
    allow: '*' | string[];
    mode: 'trigger' | 'drop';
}
export interface SenderAllowlistConfig {
    default: ChatAllowlistEntry;
    chats: Record<string, ChatAllowlistEntry>;
    logDenied: boolean;
}
export declare function loadSenderAllowlist(pathOverride?: string): SenderAllowlistConfig;
export declare function isSenderAllowed(chatJid: string, sender: string, cfg: SenderAllowlistConfig): boolean;
export declare function shouldDropMessage(chatJid: string, cfg: SenderAllowlistConfig): boolean;
export declare function isTriggerAllowed(chatJid: string, sender: string, cfg: SenderAllowlistConfig): boolean;
//# sourceMappingURL=sender-allowlist.d.ts.map