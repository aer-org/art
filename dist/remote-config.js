import fs from 'fs';
import os from 'os';
import path from 'path';
const CONFIG_DIR = path.join(os.homedir(), '.config', 'aer-art');
const REMOTES_PATH = path.join(CONFIG_DIR, 'remotes.json');
const CREDENTIALS_DIR = path.join(CONFIG_DIR, 'credentials');
export function loadRemotes() {
    if (!fs.existsSync(REMOTES_PATH))
        return { remotes: {} };
    try {
        return JSON.parse(fs.readFileSync(REMOTES_PATH, 'utf8'));
    }
    catch {
        return { remotes: {} };
    }
}
export function saveRemotes(config) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(REMOTES_PATH, JSON.stringify(config, null, 2));
}
export function getDefaultRemote() {
    const config = loadRemotes();
    const entries = Object.entries(config.remotes);
    if (entries.length === 0)
        return null;
    const defaultEntry = entries.find(([, r]) => r.default);
    if (defaultEntry)
        return { name: defaultEntry[0], remote: defaultEntry[1] };
    return { name: entries[0][0], remote: entries[0][1] };
}
export function getRemote(name) {
    const config = loadRemotes();
    return config.remotes[name] ?? null;
}
export function resolveRemote(remoteName) {
    if (remoteName) {
        const remote = getRemote(remoteName);
        if (!remote) {
            console.error(`Remote "${remoteName}" not found. Run "art remote list" to see configured remotes.`);
            process.exit(1);
        }
        return { name: remoteName, remote };
    }
    const def = getDefaultRemote();
    if (!def) {
        console.error('No remote configured — run "art remote add <name> <url>" first.');
        process.exit(1);
    }
    return def;
}
function credentialPath(remoteName) {
    return path.join(CREDENTIALS_DIR, `${remoteName}.json`);
}
export function loadRemoteCredentials(remoteName) {
    const p = credentialPath(remoteName);
    if (!fs.existsSync(p))
        return null;
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    catch {
        return null;
    }
}
export function saveRemoteCredentials(remoteName, creds) {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
    const p = credentialPath(remoteName);
    fs.writeFileSync(p, JSON.stringify(creds, null, 2), { mode: 0o600 });
    try {
        fs.chmodSync(p, 0o600);
    }
    catch {
        /* best effort */
    }
}
export function deleteRemoteCredentials(remoteName) {
    const p = credentialPath(remoteName);
    if (!fs.existsSync(p))
        return false;
    fs.unlinkSync(p);
    return true;
}
export function resolveRemoteWithAuth(remoteName) {
    const { name, remote } = resolveRemote(remoteName);
    const creds = loadRemoteCredentials(name);
    if (!creds) {
        console.error(`Not logged in to remote "${name}". Run "art login --remote ${name}" first.`);
        process.exit(1);
    }
    return { name, url: remote.url, token: creds.token };
}
//# sourceMappingURL=remote-config.js.map