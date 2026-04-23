export interface Credentials {
    server: string;
    token: string;
    scope: 'read' | 'write';
    saved_at: string;
}
export interface AgentVersion {
    content_hash: string;
    system_prompt: string;
    mcp_tools: string[];
    dockerfile_hash: string | null;
    dockerfile_image_name: string | null;
}
export interface DockerfileVersion {
    content_hash: string;
    content: string;
    description: string | null;
    created_at: number;
    image_name: string;
}
/**
 * Canonical local Docker tag for a dockerfile version.
 * Two machines resolving the same hash produce the same tag.
 */
export declare function canonicalImageTag(imageName: string, contentHash: string): string;
export interface WhoamiResponse {
    prefix: string;
    label: string | null;
    scope: 'read' | 'write';
    created_at: number;
    expires_at: number | null;
}
export declare function loadCredentials(): Credentials | null;
export declare function saveCredentials(creds: Credentials): void;
export declare function deleteCredentials(): boolean;
export declare function credentialsPath(): string;
export interface AgentRef {
    name: string;
    tag: string;
}
export declare function parseAgentRef(ref: string): AgentRef;
export declare class RegistryError extends Error {
    status: number;
    constructor(status: number, message: string);
}
export declare class RegistryClient {
    private creds;
    constructor(creds: Credentials);
    private request;
    whoami(): Promise<WhoamiResponse>;
    resolveAgentTag(ref: AgentRef): Promise<{
        version_id: number;
        content_hash: string;
    }>;
    fetchAgentVersion(hash: string): Promise<AgentVersion>;
    fetchDockerfileVersion(hash: string): Promise<DockerfileVersion>;
    resolveAndFetchAgent(ref: string): Promise<{
        hash: string;
        version: AgentVersion;
    }>;
}
//# sourceMappingURL=registry-client.d.ts.map