import fs from 'fs';
import os from 'os';
import path from 'path';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'aer-art');
const CACHE_DIR = path.join(os.homedir(), '.cache', 'aer-art');
const CREDENTIALS_PATH = path.join(CONFIG_DIR, 'credentials.json');

export const DEFAULT_REGISTRY_SERVER = 'https://aerclaw.com';

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
export function canonicalImageTag(
  imageName: string,
  contentHash: string,
): string {
  const short = contentHash.replace('sha256:', '').slice(0, 12);
  return `${imageName}:sha256-${short}`;
}

export interface WhoamiResponse {
  prefix: string;
  label: string | null;
  scope: 'read' | 'write';
  created_at: number;
  expires_at: number | null;
}

export function loadCredentials(): Credentials | null {
  if (!fs.existsSync(CREDENTIALS_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8')) as Credentials;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: Credentials): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), {
    mode: 0o600,
  });
  try {
    fs.chmodSync(CREDENTIALS_PATH, 0o600);
  } catch {
    /* best effort on unsupported platforms */
  }
}

export function deleteCredentials(): boolean {
  if (!fs.existsSync(CREDENTIALS_PATH)) return false;
  fs.unlinkSync(CREDENTIALS_PATH);
  return true;
}

export function credentialsPath(): string {
  return CREDENTIALS_PATH;
}

function cachePath(kind: 'agents' | 'dockerfiles', hash: string): string {
  const safe = hash.replace(/[^a-zA-Z0-9:_-]/g, '_');
  return path.join(CACHE_DIR, kind, `${safe}.json`);
}

function readCache<T>(kind: 'agents' | 'dockerfiles', hash: string): T | null {
  const p = cachePath(kind, hash);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeCache(
  kind: 'agents' | 'dockerfiles',
  hash: string,
  data: unknown,
): void {
  const p = cachePath(kind, hash);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
}

export interface AgentRef {
  name: string;
  tag: string;
}

export function parseAgentRef(ref: string): AgentRef {
  const idx = ref.lastIndexOf(':');
  if (idx === -1) return { name: ref, tag: 'latest' };
  return { name: ref.slice(0, idx), tag: ref.slice(idx + 1) };
}

export class RegistryError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}

export class RegistryClient {
  constructor(private creds: { server: string; token?: string }) {}

  private async request<T>(route: string): Promise<T> {
    const url = new URL(route, this.creds.server).toString();
    const headers: Record<string, string> = {};
    if (this.creds.token) {
      headers.authorization = `Bearer ${this.creds.token}`;
    }
    const res = await fetch(url, {
      headers,
    });
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) detail = `${detail} — ${body.error}`;
      } catch {
        /* non-JSON error body */
      }
      throw new RegistryError(res.status, `${route}: ${detail}`);
    }
    return (await res.json()) as T;
  }

  whoami(): Promise<WhoamiResponse> {
    return this.request<WhoamiResponse>('/v1/whoami');
  }

  resolveAgentTag(
    ref: AgentRef,
  ): Promise<{ version_id: number; content_hash: string }> {
    return this.request(
      `/v1/agents/${encodeURIComponent(ref.name)}/tags/${encodeURIComponent(ref.tag)}`,
    );
  }

  async fetchAgentVersion(hash: string): Promise<AgentVersion> {
    const cached = readCache<AgentVersion>('agents', hash);
    if (cached) return cached;
    const fetched = await this.request<AgentVersion>(
      `/v1/agents/versions/${encodeURIComponent(hash)}`,
    );
    writeCache('agents', hash, fetched);
    return fetched;
  }

  async fetchDockerfileVersion(hash: string): Promise<DockerfileVersion> {
    const cached = readCache<DockerfileVersion>('dockerfiles', hash);
    if (cached) return cached;
    const fetched = await this.request<DockerfileVersion>(
      `/v1/dockerfiles/versions/${encodeURIComponent(hash)}`,
    );
    writeCache('dockerfiles', hash, fetched);
    return fetched;
  }

  async resolveAndFetchAgent(
    ref: string,
  ): Promise<{ hash: string; version: AgentVersion }> {
    const parsed = parseAgentRef(ref);
    const { content_hash } = await this.resolveAgentTag(parsed);
    const version = await this.fetchAgentVersion(content_hash);
    return { hash: content_hash, version };
  }
}
