/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { Server } from 'http';
export type AuthMode = 'api-key' | 'oauth';
export interface ProxyConfig {
    authMode: AuthMode;
}
export declare function startCredentialProxy(port: number, host?: string): Promise<Server>;
/** Detect which auth mode the host is configured for. */
export declare function detectAuthMode(): AuthMode;
//# sourceMappingURL=credential-proxy.d.ts.map