import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
const TOKEN_FILE = path.join(os.homedir(), '.config', 'aer-art', 'token');
export function readSavedToken() {
    try {
        const token = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
        return token || null;
    }
    catch {
        return null;
    }
}
export function saveToken(token) {
    const dir = path.dirname(TOKEN_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 });
}
export function readClaudeCliToken() {
    try {
        const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
        const raw = fs.readFileSync(credPath, 'utf-8');
        const creds = JSON.parse(raw);
        const oauth = creds?.claudeAiOauth;
        if (!oauth?.accessToken)
            return null;
        if (oauth.expiresAt && Date.now() > oauth.expiresAt - 60_000)
            return null;
        return oauth.accessToken;
    }
    catch {
        return null;
    }
}
/**
 * Resolve an auth token from available sources.
 * Chain: _ART_OAUTH_TOKEN → .env ANTHROPIC_API_KEY → ~/.config/aer-art/token → ~/.claude/.credentials.json
 * Returns null if no token found (no interactive prompt).
 */
export function resolveAuthToken() {
    // 0. Token set by ensureAuth() in current process
    if (process.env._ART_OAUTH_TOKEN) {
        return process.env._ART_OAUTH_TOKEN;
    }
    // 1. Environment variable (direct API key)
    if (process.env.ANTHROPIC_API_KEY) {
        return process.env.ANTHROPIC_API_KEY;
    }
    // 2. Check .env in cwd
    const envFile = path.join(process.cwd(), '.env');
    try {
        const env = fs.readFileSync(envFile, 'utf-8');
        for (const line of env.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('ANTHROPIC_API_KEY=')) {
                const val = trimmed.slice('ANTHROPIC_API_KEY='.length).trim();
                if (val)
                    return val;
            }
        }
    }
    catch {
        /* no .env */
    }
    // 3. Saved token from previous art setup
    const saved = readSavedToken();
    if (saved)
        return saved;
    // 4. Claude CLI credentials
    const cliToken = readClaudeCliToken();
    if (cliToken)
        return cliToken;
    return null;
}
function maskToken(token) {
    if (token.length <= 12)
        return '***';
    return token.slice(0, 8) + '...' + token.slice(-4);
}
/**
 * Ensure authentication is available, prompting interactively if needed.
 * Sets process.env._ART_OAUTH_TOKEN when a token is found or provided.
 */
/**
 * Set the appropriate env vars so the credential proxy detects auth mode.
 * API keys → ANTHROPIC_API_KEY, OAuth tokens → ANTHROPIC_AUTH_TOKEN.
 */
function setAuthEnvVars(token) {
    if (token.startsWith('sk-ant-api') ||
        (!token.startsWith('sk-ant-oat') && !token.startsWith('eyJ'))) {
        // Looks like an API key
        process.env.ANTHROPIC_API_KEY = token;
    }
    else {
        // OAuth token (sk-ant-oat*) or JWT
        process.env.ANTHROPIC_AUTH_TOKEN = token;
    }
    process.env._ART_OAUTH_TOKEN = token;
}
/**
 * Ensure authentication is available, prompting interactively if needed.
 * Sets process.env._ART_OAUTH_TOKEN when a token is found or provided.
 * Also sets ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN for the credential proxy.
 */
export async function ensureAuth() {
    // 1. Check .env in project dir for a non-empty token
    const envFile = path.join(process.cwd(), '.env');
    try {
        const env = fs.readFileSync(envFile, 'utf-8');
        for (const line of env.split('\n')) {
            const trimmed = line.trim();
            // Check for API key in .env
            if (trimmed.startsWith('ANTHROPIC_API_KEY=')) {
                const val = trimmed.slice('ANTHROPIC_API_KEY='.length).trim();
                if (val) {
                    console.log(`Using API key from .env (${maskToken(val)})`);
                    setAuthEnvVars(val);
                    return;
                }
            }
            if ((trimmed.startsWith('CLAUDE_CODE_OAUTH_TOKEN=') ||
                trimmed.startsWith('ANTHROPIC_AUTH_TOKEN=')) &&
                trimmed.split('=', 2)[1]?.trim()) {
                const val = trimmed.split('=', 2)[1].trim();
                console.log(`Using token from .env (${maskToken(val)})`);
                setAuthEnvVars(val);
                return;
            }
        }
    }
    catch {
        /* no .env */
    }
    // 2. Check saved token from previous art setup
    const saved = readSavedToken();
    if (saved) {
        console.log(`Using saved token (${maskToken(saved)})`);
        setAuthEnvVars(saved);
        return;
    }
    // 3. Try Claude CLI credentials
    const cliToken = readClaudeCliToken();
    if (cliToken) {
        console.log(`Using Claude CLI token (${maskToken(cliToken)})`);
        setAuthEnvVars(cliToken);
        return;
    }
    // 4. No token found — ask user to provide one
    console.log('No Claude authentication found.\n\n' +
        'To get a token, run:\n\n' +
        '  claude setup-token\n\n' +
        'Then paste the token below.\n');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    const token = await new Promise((resolve) => rl.question('Token: ', resolve));
    rl.close();
    const trimmed = token.trim();
    if (!trimmed) {
        console.error('No token provided. Exiting.');
        process.exit(1);
    }
    saveToken(trimmed);
    setAuthEnvVars(trimmed);
    console.log(`Token saved (${maskToken(trimmed)})\n`);
}
//# sourceMappingURL=auth.js.map