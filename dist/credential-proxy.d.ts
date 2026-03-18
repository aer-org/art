import { Server } from 'http';
export type AuthMode = 'api-key' | 'oauth';
export interface ProxyConfig {
    authMode: AuthMode;
}
export declare function startCredentialProxy(port: number, host?: string): Promise<{
    server: Server;
    port: number;
}>;
/** Detect which auth mode the host is configured for. */
export declare function detectAuthMode(): AuthMode;
//# sourceMappingURL=credential-proxy.d.ts.map