type JsonRpcId = string | number;
interface JsonRpcRequest {
    id: JsonRpcId;
    method: string;
    params?: unknown;
}
interface JsonRpcNotification {
    method: string;
    params?: unknown;
}
export interface CodexExternalLogin {
    accessToken: string;
    chatgptAccountId: string;
    chatgptPlanType?: string | null;
}
export interface CodexAppServerInitOptions {
    cwd?: string;
    clientName?: string;
    clientTitle?: string;
    clientVersion?: string;
}
export interface CodexAppServerClientOptions {
    codexBin?: string;
    env?: Record<string, string | undefined>;
    onServerRequest?: (request: JsonRpcRequest) => Promise<unknown> | unknown;
    onNotification?: (notification: JsonRpcNotification) => void;
}
export declare class CodexAppServerClient {
    private readonly codexBin;
    private readonly env;
    private readonly onServerRequest?;
    private readonly onNotification?;
    private proc;
    private nextId;
    private readonly pending;
    constructor(options?: CodexAppServerClientOptions);
    start(): Promise<void>;
    initialize(options?: CodexAppServerInitOptions): Promise<unknown>;
    loginWithExternalAuth(login: CodexExternalLogin): Promise<unknown>;
    request(method: string, params?: unknown): Promise<unknown>;
    notify(method: string, params?: unknown): Promise<void>;
    close(): Promise<void>;
    private handleInboundLine;
    private handleServerRequest;
}
export {};
//# sourceMappingURL=codex-app-server-client.d.ts.map