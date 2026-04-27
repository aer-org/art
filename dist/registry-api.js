import { RegistryError } from './registry-client.js';
export class RegistryApi {
    baseUrl;
    token;
    constructor(baseUrl, token) {
        this.baseUrl = baseUrl;
        this.token = token;
    }
    async request(route, opts) {
        const url = new URL(route, this.baseUrl).toString();
        const init = {
            method: opts?.method ?? 'GET',
            headers: {
                authorization: `Bearer ${this.token}`,
                'content-type': 'application/json',
            },
        };
        if (opts?.body)
            init.body = JSON.stringify(opts.body);
        const res = await fetch(url, init);
        if (!res.ok) {
            let detail = `${res.status} ${res.statusText}`;
            try {
                const body = (await res.json());
                if (body.error)
                    detail = `${detail} — ${body.error}`;
            }
            catch {
                /* non-JSON */
            }
            throw new RegistryError(res.status, `${route}: ${detail}`);
        }
        return (await res.json());
    }
    async whoami() {
        return this.request('/v1/whoami');
    }
    async fetchBundle(name, tag = 'latest', project) {
        const params = new URLSearchParams({ tag });
        if (project)
            params.set('project', project);
        return this.request(`/v1/pipelines/${encodeURIComponent(name)}/bundle?${params}`);
    }
    async pushAgent(data) {
        return this.request('/v1/agents', { method: 'POST', body: data });
    }
    async pushPipeline(data) {
        return this.request('/v1/pipelines', { method: 'POST', body: data });
    }
    async pushDockerfile(data) {
        return this.request('/v1/dockerfiles', { method: 'POST', body: data });
    }
    async pushTemplate(data) {
        return this.request('/v1/templates', { method: 'POST', body: data });
    }
    async forkAgent(agentName, project) {
        return this.request('/v1/agents/fork', {
            method: 'POST',
            body: { name: agentName, project },
        });
    }
    async promoteAgent(agentName, project) {
        return this.request('/v1/agents/promote', {
            method: 'POST',
            body: { name: agentName, project },
        });
    }
}
//# sourceMappingURL=registry-api.js.map