export interface Remote {
    url: string;
    default?: boolean;
}
export interface RemotesConfig {
    remotes: Record<string, Remote>;
}
export interface RemoteCredentials {
    token: string;
    scope: 'read' | 'write';
    username?: string;
    saved_at: string;
}
export declare function loadRemotes(): RemotesConfig;
export declare function saveRemotes(config: RemotesConfig): void;
export declare function getDefaultRemote(): {
    name: string;
    remote: Remote;
} | null;
export declare function getRemote(name: string): Remote | null;
export declare function resolveRemote(remoteName?: string): {
    name: string;
    remote: Remote;
};
export declare function loadRemoteCredentials(remoteName: string): RemoteCredentials | null;
export declare function saveRemoteCredentials(remoteName: string, creds: RemoteCredentials): void;
export declare function deleteRemoteCredentials(remoteName: string): boolean;
export declare function resolveRemoteWithAuth(remoteName?: string): {
    name: string;
    url: string;
    token: string;
};
//# sourceMappingURL=remote-config.d.ts.map