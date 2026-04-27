export interface BundleResponse {
    pipeline: {
        name: string;
        project?: string;
        config: Record<string, unknown>;
        content_hash: string;
    };
    agents: Array<{
        name: string;
        system_prompt: string;
        content_hash: string;
        mcp_tools: string[];
        scope: 'shared' | 'user';
    }>;
    dockerfiles: Array<{
        image_name: string;
        content: string;
        content_hash: string;
    }>;
    templates: Array<{
        name: string;
        config: Record<string, unknown>;
        content_hash: string;
    }>;
}
export interface PushResult {
    agents_updated: number;
    pipelines_updated: number;
    dockerfiles_updated: number;
    templates_updated: number;
}
export declare class RegistryApi {
    private baseUrl;
    private token;
    constructor(baseUrl: string, token: string);
    private request;
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
        mcp_tools?: string[];
        project?: string;
    }): Promise<{
        content_hash: string;
    }>;
    pushPipeline(data: {
        name: string;
        config: Record<string, unknown>;
        project?: string;
    }): Promise<{
        content_hash: string;
    }>;
    pushDockerfile(data: {
        image_name: string;
        content: string;
    }): Promise<{
        content_hash: string;
    }>;
    pushTemplate(data: {
        name: string;
        config: Record<string, unknown>;
        pipeline_name?: string;
        project?: string;
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