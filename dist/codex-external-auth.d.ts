import { CodexExternalLogin } from './codex-app-server-client.js';
export declare class CodexExternalAuthManager {
    private inflight;
    private readonly authPath;
    constructor(opts?: {
        authPath?: string;
    });
    getExternalLogin(): CodexExternalLogin;
    refreshExternalLogin(): Promise<CodexExternalLogin>;
    private refreshLocked;
    private refreshViaHttp;
}
//# sourceMappingURL=codex-external-auth.d.ts.map