export interface BundleResponse {
    pipeline: {
        name: string;
        content_hash: string;
        content: Record<string, unknown>;
    };
    agents: Record<string, {
        content_hash: string;
        system_prompt: string;
        mcp_tools: string[];
    }>;
    dockerfiles: Record<string, {
        content_hash: string;
        content: string;
        description: string | null;
    }>;
    templates: Record<string, {
        content_hash: string;
        content: Record<string, unknown>;
    }>;
}
export declare class RegistryApi {
    private baseUrl;
    private token;
    constructor(baseUrl: string, token: string);
    private request;
    static signup(baseUrl: string, username: string, password: string): Promise<{
        id: number;
        username: string;
    }>;
    static login(baseUrl: string, username: string, password: string): Promise<{
        token: string;
        expires_at: number;
    }>;
    whoami(): Promise<{
        prefix: string;
        label: string | null;
        scope: 'read' | 'write';
        username?: string;
    }>;
    fetchBundle(name: string, tag?: string, project?: string): Promise<BundleResponse>;
    pushAgent(data: {
        name: string;
        system_prompt: string;
        dockerfile?: {
            name: string;
            tag?: string;
        } | {
            hash: string;
        };
        mcp_tools?: string[];
        project?: string;
        owner?: string;
        tags?: string[];
    }): Promise<{
        content_hash: string;
    }>;
    pushPipeline(data: {
        name: string;
        content: Record<string, unknown>;
        kind?: 'pipeline' | 'template';
        substitutions?: string[];
        project?: string;
        owner?: string;
        tags?: string[];
    }): Promise<{
        content_hash: string;
    }>;
    checkDockerfile(name: string): Promise<{
        exists: boolean;
        latestHash?: string;
    }>;
    pushDockerfile(data: {
        name: string;
        content: string;
        image_name?: string;
        project?: string;
        tags?: string[];
    }): Promise<{
        content_hash: string;
    }>;
    forkAgent(agentName: string, project?: string): Promise<{
        name: string;
        content_hash: string;
    }>;
    promoteAgent(agentName: string, project?: string): Promise<{
        name: string;
        content_hash: string;
    }>;
}
//# sourceMappingURL=registry-api.d.ts.map