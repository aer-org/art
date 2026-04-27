import fs from 'fs';
import os from 'os';
import path from 'path';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'aer-art');
const REMOTES_PATH = path.join(CONFIG_DIR, 'remotes.json');
const CREDENTIALS_DIR = path.join(CONFIG_DIR, 'credentials');

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

export function loadRemotes(): RemotesConfig {
  if (!fs.existsSync(REMOTES_PATH)) return { remotes: {} };
  try {
    return JSON.parse(fs.readFileSync(REMOTES_PATH, 'utf8')) as RemotesConfig;
  } catch {
    return { remotes: {} };
  }
}

export function saveRemotes(config: RemotesConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(REMOTES_PATH, JSON.stringify(config, null, 2));
}

export function getDefaultRemote(): { name: string; remote: Remote } | null {
  const config = loadRemotes();
  const entries = Object.entries(config.remotes);
  if (entries.length === 0) return null;

  const defaultEntry = entries.find(([, r]) => r.default);
  if (defaultEntry) return { name: defaultEntry[0], remote: defaultEntry[1] };

  return { name: entries[0][0], remote: entries[0][1] };
}

export function getRemote(name: string): Remote | null {
  const config = loadRemotes();
  return config.remotes[name] ?? null;
}

export function resolveRemote(remoteName?: string): {
  name: string;
  remote: Remote;
} {
  if (remoteName) {
    const remote = getRemote(remoteName);
    if (!remote) {
      console.error(
        `Remote "${remoteName}" not found. Run "art remote list" to see configured remotes.`,
      );
      process.exit(1);
    }
    return { name: remoteName, remote };
  }

  const def = getDefaultRemote();
  if (!def) {
    console.error(
      'No remote configured — run "art remote add <name> <url>" first.',
    );
    process.exit(1);
  }
  return def;
}

function credentialPath(remoteName: string): string {
  return path.join(CREDENTIALS_DIR, `${remoteName}.json`);
}

export function loadRemoteCredentials(
  remoteName: string,
): RemoteCredentials | null {
  const p = credentialPath(remoteName);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as RemoteCredentials;
  } catch {
    return null;
  }
}

export function saveRemoteCredentials(
  remoteName: string,
  creds: RemoteCredentials,
): void {
  fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
  const p = credentialPath(remoteName);
  fs.writeFileSync(p, JSON.stringify(creds, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* best effort */
  }
}

export function deleteRemoteCredentials(remoteName: string): boolean {
  const p = credentialPath(remoteName);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

export function resolveRemoteWithAuth(remoteName?: string): {
  name: string;
  url: string;
  token: string;
} {
  const { name, remote } = resolveRemote(remoteName);
  const creds = loadRemoteCredentials(name);
  if (!creds) {
    console.error(
      `Not logged in to remote "${name}". Run "art login --remote ${name}" first.`,
    );
    process.exit(1);
  }
  return { name, url: remote.url, token: creds.token };
}
