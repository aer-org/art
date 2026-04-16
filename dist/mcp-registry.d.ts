export interface ExternalMcpServerBase {
    name?: string;
    tools?: string[];
    startupTimeoutSec?: number;
}
export interface ExternalMcpStdioServer extends ExternalMcpServerBase {
    transport?: 'stdio';
    command: string;
    args?: string[];
    env?: Record<string, string>;
}
export interface ExternalMcpHttpServer extends ExternalMcpServerBase {
    transport: 'http';
    url: string;
    bearerTokenEnvVar?: string;
}
export type ExternalMcpRegistryEntry = ExternalMcpStdioServer | ExternalMcpHttpServer;
export type ExternalMcpRegistry = Record<string, ExternalMcpRegistryEntry>;
export interface ResolvedExternalMcpServer {
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
export declare function getMcpRegistryPath(): string;
export declare function loadMcpRegistry(registryPath?: string): ExternalMcpRegistry;
export declare function validateStageMcpAccess(refs: string[] | undefined, registry?: ExternalMcpRegistry): void;
export declare function resolveStageMcpServers(refs: string[] | undefined, options?: {
    registry?: ExternalMcpRegistry;
    hostGateway?: string;
}): ResolvedExternalMcpServer[];
export declare function formatStageMcpAccessSummary(servers: ResolvedExternalMcpServer[]): string[];
//# sourceMappingURL=mcp-registry.d.ts.map