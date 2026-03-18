import { Channel, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';
export interface TelegramChannelOpts {
    onMessage: OnInboundMessage;
    onChatMetadata: OnChatMetadata;
    registeredGroups: () => Record<string, RegisteredGroup>;
}
export declare class TelegramChannel implements Channel {
    name: string;
    private bot;
    private opts;
    private botToken;
    constructor(botToken: string, opts: TelegramChannelOpts);
    connect(): Promise<void>;
    sendMessage(jid: string, text: string): Promise<void>;
    isConnected(): boolean;
    ownsJid(jid: string): boolean;
    disconnect(): Promise<void>;
    setTyping(jid: string, isTyping: boolean): Promise<void>;
}
//# sourceMappingURL=telegram.d.ts.map