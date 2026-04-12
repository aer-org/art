interface ClaudeAiOauth {
    accessToken: string;
    expiresAt: number;
    refreshToken: string;
    scopes: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
}
/**
 * Manages an OAuth access token with automatic refresh. One instance per
 * credentials-file target; safe to call `getAccessToken` concurrently.
 */
export declare class OAuthRefresher {
    private cache;
    private inflight;
    private readonly credsPath;
    private readonly clientId;
    constructor(opts?: {
        credsPath?: string;
        clientId?: string;
    });
    /** True if the credentials file looks refreshable. */
    static isAvailable(credsPath?: string): boolean;
    /**
     * Return a valid access token, refreshing if it's within the expiry buffer
     * (or unconditionally if `force`). Deduplicates concurrent refreshes within
     * the process; coordinates across processes via proper-lockfile.
     */
    getAccessToken(force?: boolean): Promise<string>;
    private isExpired;
    private readCreds;
    private writeCreds;
    private refreshLocked;
    protected httpRefresh(current: ClaudeAiOauth): Promise<ClaudeAiOauth>;
}
export {};
//# sourceMappingURL=oauth-refresh.d.ts.map