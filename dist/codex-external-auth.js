import fs from 'fs';
import os from 'os';
import path from 'path';
const DEFAULT_CODEX_HOME = path.join(os.homedir(), '.codex');
const REFRESH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR = 'CODEX_REFRESH_TOKEN_URL_OVERRIDE';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
function resolveCodexHome() {
    const envHome = process.env.CODEX_HOME?.trim();
    return envHome ? path.resolve(envHome) : DEFAULT_CODEX_HOME;
}
function getAuthPath() {
    return path.join(resolveCodexHome(), 'auth.json');
}
function decodeJwtPayload(jwt) {
    const parts = jwt.split('.');
    if (parts.length !== 3 || !parts[1]) {
        throw new Error('Invalid JWT format');
    }
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload);
}
function parseIdTokenInfo(idToken) {
    const claims = decodeJwtPayload(idToken);
    return claims['https://api.openai.com/auth'] ?? claims.auth ?? {};
}
function loadHostAuth() {
    const authPath = getAuthPath();
    if (!fs.existsSync(authPath)) {
        throw new Error(`Codex auth not found at ${authPath}. Run Codex login on the host first.`);
    }
    return JSON.parse(fs.readFileSync(authPath, 'utf-8'));
}
function persistHostAuth(auth) {
    const authPath = getAuthPath();
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    fs.writeFileSync(authPath, JSON.stringify(auth, null, 2) + '\n', 'utf8');
    try {
        fs.chmodSync(authPath, 0o600);
    }
    catch {
        // best effort
    }
}
function toExternalLogin(auth) {
    const tokens = auth.tokens;
    if (!tokens?.access_token || !tokens.id_token) {
        throw new Error('Codex auth is missing access_token or id_token');
    }
    const idToken = parseIdTokenInfo(tokens.id_token);
    const accountId = idToken.chatgpt_account_id ?? tokens.account_id;
    if (!accountId) {
        throw new Error('Codex auth is missing chatgpt_account_id');
    }
    return {
        accessToken: tokens.access_token,
        chatgptAccountId: accountId,
        chatgptPlanType: idToken.chatgpt_plan_type ?? null,
    };
}
export class CodexExternalAuthManager {
    getExternalLogin() {
        return toExternalLogin(loadHostAuth());
    }
    async refreshExternalLogin() {
        const auth = loadHostAuth();
        const refreshToken = auth.tokens?.refresh_token;
        if (!refreshToken) {
            throw new Error('Codex auth is missing refresh_token');
        }
        const endpoint = process.env[REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR] ?? REFRESH_TOKEN_URL;
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: CLIENT_ID,
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
            }),
        });
        if (!response.ok) {
            const body = await response.text();
            throw new Error(`Failed to refresh Codex OAuth token: ${response.status} ${body}`);
        }
        const refreshed = (await response.json());
        if (!auth.tokens) {
            throw new Error('Codex auth tokens disappeared during refresh');
        }
        auth.tokens = {
            ...auth.tokens,
            id_token: refreshed.id_token ?? auth.tokens.id_token,
            access_token: refreshed.access_token ?? auth.tokens.access_token,
            refresh_token: refreshed.refresh_token ?? auth.tokens.refresh_token,
        };
        persistHostAuth(auth);
        return toExternalLogin(auth);
    }
}
//# sourceMappingURL=codex-external-auth.js.map