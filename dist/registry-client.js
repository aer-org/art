import fs from 'fs';
import os from 'os';
import path from 'path';
const CONFIG_DIR = path.join(os.homedir(), '.config', 'aer-art');
const CACHE_DIR = path.join(os.homedir(), '.cache', 'aer-art');
const CREDENTIALS_PATH = path.join(CONFIG_DIR, 'credentials.json');
/**
 * Canonical local Docker tag for a dockerfile version.
 * Two machines resolving the same hash produce the same tag.
 */
export function canonicalImageTag(imageName, contentHash) {
    const short = contentHash.replace('sha256:', '').slice(0, 12);
    return `${imageName}:sha256-${short}`;
}
export function loadCredentials() {
    if (!fs.existsSync(CREDENTIALS_PATH))
        return null;
    try {
        return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    }
    catch {
        return null;
    }
}
export function saveCredentials(creds) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), {
        mode: 0o600,
    });
    try {
        fs.chmodSync(CREDENTIALS_PATH, 0o600);
    }
    catch {
        /* best effort on unsupported platforms */
    }
}
export function deleteCredentials() {
    if (!fs.existsSync(CREDENTIALS_PATH))
        return false;
    fs.unlinkSync(CREDENTIALS_PATH);
    return true;
}
export function credentialsPath() {
    return CREDENTIALS_PATH;
}
function cachePath(kind, hash) {
    const safe = hash.replace(/[^a-zA-Z0-9:_-]/g, '_');
    return path.join(CACHE_DIR, kind, `${safe}.json`);
}
function readCache(kind, hash) {
    const p = cachePath(kind, hash);
    if (!fs.existsSync(p))
        return null;
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    catch {
        return null;
    }
}
function writeCache(kind, hash, data) {
    const p = cachePath(kind, hash);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data));
}
export function parseAgentRef(ref) {
    const idx = ref.lastIndexOf(':');
    if (idx === -1)
        return { name: ref, tag: 'latest' };
    return { name: ref.slice(0, idx), tag: ref.slice(idx + 1) };
}
export class RegistryError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = 'RegistryError';
    }
}
export class RegistryClient {
    creds;
    constructor(creds) {
        this.creds = creds;
    }
    async request(route) {
        const url = new URL(route, this.creds.server).toString();
        const res = await fetch(url, {
            headers: { authorization: `Bearer ${this.creds.token}` },
        });
        if (!res.ok) {
            let detail = `${res.status} ${res.statusText}`;
            try {
                const body = (await res.json());
                if (body.error)
                    detail = `${detail} — ${body.error}`;
            }
            catch {
                /* non-JSON error body */
            }
            throw new RegistryError(res.status, `${route}: ${detail}`);
        }
        return (await res.json());
    }
    whoami() {
        return this.request('/v1/whoami');
    }
    resolveAgentTag(ref) {
        return this.request(`/v1/agents/${encodeURIComponent(ref.name)}/tags/${encodeURIComponent(ref.tag)}`);
    }
    async fetchAgentVersion(hash) {
        const cached = readCache('agents', hash);
        if (cached)
            return cached;
        const fetched = await this.request(`/v1/agents/versions/${encodeURIComponent(hash)}`);
        writeCache('agents', hash, fetched);
        return fetched;
    }
    async fetchDockerfileVersion(hash) {
        const cached = readCache('dockerfiles', hash);
        if (cached)
            return cached;
        const fetched = await this.request(`/v1/dockerfiles/versions/${encodeURIComponent(hash)}`);
        writeCache('dockerfiles', hash, fetched);
        return fetched;
    }
    async resolveAndFetchAgent(ref) {
        const parsed = parseAgentRef(ref);
        const { content_hash } = await this.resolveAgentTag(parsed);
        const version = await this.fetchAgentVersion(content_hash);
        return { hash: content_hash, version };
    }
}
//# sourceMappingURL=registry-client.js.map