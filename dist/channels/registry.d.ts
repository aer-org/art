import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';
export interface ChannelOpts {
    onMessage: OnInboundMessage;
    onChatMetadata: OnChatMetadata;
    registeredGroups: () => Record<string, RegisteredGroup>;
}
export type ChannelFactory = (opts: ChannelOpts) => Channel | null;
export declare function registerChannel(name: string, factory: ChannelFactory): void;
export declare function getChannelFactory(name: string): ChannelFactory | undefined;
export declare function getRegisteredChannelNames(): string[];
//# sourceMappingURL=registry.d.ts.map