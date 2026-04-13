import fs from 'fs';
import os from 'os';
import path from 'path';
export const DEFAULT_CODEX_HOME = path.join(os.homedir(), '.codex');
function resolveCodexHome() {
    const envHome = process.env.CODEX_HOME?.trim();
    return envHome ? path.resolve(envHome) : DEFAULT_CODEX_HOME;
}
export function getHostCodexAuthPath() {
    return path.join(resolveCodexHome(), 'auth.json');
}
export function hasHostCodexAuth() {
    const authPath = getHostCodexAuthPath();
    if (!fs.existsSync(authPath))
        return false;
    try {
        const raw = fs.readFileSync(authPath, 'utf-8');
        const parsed = JSON.parse(raw);
        return !!(parsed.tokens?.access_token ||
            parsed.tokens?.refresh_token ||
            parsed.tokens?.id_token);
    }
    catch {
        return false;
    }
}
export function ensureCodexSessionAuth(sessionCodexHome) {
    const source = getHostCodexAuthPath();
    if (!fs.existsSync(source)) {
        throw new Error(`Codex auth not found at ${source}. Run Codex login on the host first.`);
    }
    fs.mkdirSync(sessionCodexHome, { recursive: true });
    const dest = path.join(sessionCodexHome, 'auth.json');
    fs.copyFileSync(source, dest);
    try {
        fs.chmodSync(dest, 0o600);
    }
    catch {
        // best effort
    }
}
//# sourceMappingURL=codex-auth.js.map