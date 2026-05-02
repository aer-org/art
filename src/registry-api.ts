import { RegistryError } from './registry-client.js';

export interface BundleResponse {
  pipeline: {
    name: string;
    content_hash: string;
    content: Record<string, unknown>;
  };
  agents: Record<
    string,
    {
      content_hash: string;
      system_prompt: string;
      mcp_tools: string[];
    }
  >;
  dockerfiles: Record<
    string,
    {
      content_hash: string;
      content: string;
      description: string | null;
    }
  >;
  templates: Record<
    string,
    {
      content_hash: string;
      content: Record<string, unknown>;
    }
  >;
}

export class RegistryApi {
  constructor(
    private baseUrl: string,
    private token?: string,
  ) {}

  private async request<T>(
    route: string,
    opts?: { method?: string; body?: unknown },
  ): Promise<T> {
    const url = new URL(route, this.baseUrl).toString();
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
    const init: RequestInit = {
      method: opts?.method ?? 'GET',
      headers,
    };
    if (opts?.body) init.body = JSON.stringify(opts.body);

    const res = await fetch(url, init);
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) detail = `${detail} — ${body.error}`;
      } catch {
        /* non-JSON */
      }
      throw new RegistryError(res.status, `${route}: ${detail}`);
    }
    return (await res.json()) as T;
  }

  static async signup(
    baseUrl: string,
    username: string,
    password: string,
  ): Promise<{ id: number; username: string }> {
    const url = new URL('/v1/users', baseUrl).toString();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) detail = body.error;
      } catch {
        /* non-JSON */
      }
      throw new RegistryError(res.status, detail);
    }
    return (await res.json()) as { id: number; username: string };
  }

  static async login(
    baseUrl: string,
    username: string,
    password: string,
  ): Promise<{ token: string; expires_at: number }> {
    const url = new URL('/v1/auth/login', baseUrl).toString();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) detail = body.error;
      } catch {
        /* non-JSON */
      }
      throw new RegistryError(res.status, detail);
    }
    return (await res.json()) as { token: string; expires_at: number };
  }

  async whoami(): Promise<{
    prefix: string;
    label: string | null;
    scope: 'read' | 'write';
    username?: string;
  }> {
    return this.request('/v1/whoami');
  }

  async fetchBundle(
    name: string,
    tag = 'latest',
    project?: string,
  ): Promise<BundleResponse> {
    const params = new URLSearchParams({ tag });
    if (project) params.set('project', project);
    return this.request(
      `/v1/pipelines/${encodeURIComponent(name)}/bundle?${params}`,
    );
  }

  async pushAgent(data: {
    name: string;
    system_prompt: string;
    dockerfile?: { name: string; tag?: string } | { hash: string };
    mcp_tools?: string[];
    project?: string;
    owner?: string;
    tags?: string[];
  }): Promise<{ content_hash: string }> {
    return this.request('/v1/agents', { method: 'POST', body: data });
  }

  async pushPipeline(data: {
    name: string;
    content: Record<string, unknown>;
    kind?: 'pipeline' | 'template';
    substitutions?: string[];
    project?: string;
    owner?: string;
    tags?: string[];
  }): Promise<{ content_hash: string }> {
    return this.request('/v1/pipelines', { method: 'POST', body: data });
  }

  async checkDockerfile(
    name: string,
  ): Promise<{ exists: boolean; latestHash?: string }> {
    try {
      const res = await this.request<{
        name: string;
        latest_hash: string;
      }>(`/v1/dockerfiles/${encodeURIComponent(name)}`);
      return { exists: true, latestHash: res.latest_hash };
    } catch (e) {
      if (e instanceof RegistryError && e.status === 404) {
        return { exists: false };
      }
      throw e;
    }
  }

  async pushDockerfile(data: {
    name: string;
    content: string;
    image_name?: string;
    project?: string;
    tags?: string[];
  }): Promise<{ content_hash: string }> {
    return this.request('/v1/dockerfiles', { method: 'POST', body: data });
  }

  async forkAgent(
    agentName: string,
    project?: string,
  ): Promise<{ name: string; content_hash: string }> {
    return this.request('/v1/agents/fork', {
      method: 'POST',
      body: { name: agentName, project },
    });
  }

  async promoteAgent(
    agentName: string,
    project?: string,
  ): Promise<{ name: string; content_hash: string }> {
    return this.request('/v1/agents/promote', {
      method: 'POST',
      body: { name: agentName, project },
    });
  }
}
