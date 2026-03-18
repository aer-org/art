export declare function readSavedToken(): string | null;
export declare function saveToken(token: string): void;
export declare function readClaudeCliToken(): string | null;
/**
 * Resolve an auth token from available sources.
 * Chain: _ART_OAUTH_TOKEN → .env ANTHROPIC_API_KEY → ~/.config/aer-art/token → ~/.claude/.credentials.json
 * Returns null if no token found (no interactive prompt).
 */
export declare function resolveAuthToken(): string | null;
/**
 * Ensure authentication is available, prompting interactively if needed.
 * Sets process.env._ART_OAUTH_TOKEN when a token is found or provided.
 * Also sets ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN for the credential proxy.
 */
export declare function ensureAuth(): Promise<void>;
//# sourceMappingURL=auth.d.ts.map