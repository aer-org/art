import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';

const TOKEN_FILE = path.join(os.homedir(), '.config', 'aer-art', 'token');

export function readSavedToken(): string | null {
  try {
    const token = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
    return token || null;
  } catch {
    return null;
  }
}

export function saveToken(token: string): void {
  const dir = path.dirname(TOKEN_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 });
}

export function readClaudeCliToken(): string | null {
  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const raw = fs.readFileSync(credPath, 'utf-8');
    const creds = JSON.parse(raw);
    const oauth = creds?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    if (oauth.expiresAt && Date.now() > oauth.expiresAt - 60_000) return null;
    return oauth.accessToken;
  } catch {
    return null;
  }
}

/**
 * Resolve an auth token from available sources.
 * Chain: _ART_OAUTH_TOKEN → .env ANTHROPIC_API_KEY → ~/.config/aer-art/token → ~/.claude/.credentials.json
 * Returns null if no token found (no interactive prompt).
 */
export function resolveAuthToken(): string | null {
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
        if (val) return val;
      }
    }
  } catch {
    /* no .env */
  }

  // 3. Saved token from previous art setup
  const saved = readSavedToken();
  if (saved) return saved;

  // 4. Claude CLI credentials
  const cliToken = readClaudeCliToken();
  if (cliToken) return cliToken;

  return null;
}

function maskToken(token: string): string {
  if (token.length <= 12) return '***';
  return token.slice(0, 8) + '...' + token.slice(-4);
}

async function validateToken(token: string): Promise<boolean> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': token,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20241022',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function promptForToken(): Promise<string> {
  console.log(
    'No valid Claude authentication found.\n\n' +
      'To get a token, run:\n\n' +
      '  claude setup-token\n\n' +
      'Then paste the token below.\n',
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const token = await new Promise<string>((resolve) =>
    rl.question('Token: ', resolve),
  );
  rl.close();

  const trimmed = token.trim();
  if (!trimmed) {
    console.error('No token provided. Exiting.');
    process.exit(1);
  }
  return trimmed;
}

/**
 * Ensure authentication is available, prompting interactively if needed.
 * Validates the token against the Anthropic API before accepting it.
 * Sets process.env._ART_OAUTH_TOKEN when a valid token is confirmed.
 */
export async function ensureAuth(): Promise<void> {
  // 1. Check .env in project dir for a non-empty token
  const envFile = path.join(process.cwd(), '.env');
  try {
    const env = fs.readFileSync(envFile, 'utf-8');
    for (const line of env.split('\n')) {
      const trimmed = line.trim();
      if (
        (trimmed.startsWith('CLAUDE_CODE_OAUTH_TOKEN=') ||
          trimmed.startsWith('ANTHROPIC_AUTH_TOKEN=')) &&
        trimmed.split('=', 2)[1]?.trim()
      ) {
        const val = trimmed.split('=', 2)[1]!.trim();
        console.log(`Using token from .env (${maskToken(val)})`);
        if (await validateToken(val)) return;
        console.log('Token from .env is invalid.\n');
      }
    }
  } catch {
    /* no .env */
  }

  // 2. Check saved token from previous art setup
  const saved = readSavedToken();
  if (saved) {
    console.log(`Using saved token (${maskToken(saved)})`);
    if (await validateToken(saved)) {
      process.env._ART_OAUTH_TOKEN = saved;
      return;
    }
    console.log('Saved token is invalid or expired.\n');
  }

  // 3. Try Claude CLI credentials
  const cliToken = readClaudeCliToken();
  if (cliToken) {
    console.log(`Using Claude CLI token (${maskToken(cliToken)})`);
    if (await validateToken(cliToken)) {
      process.env._ART_OAUTH_TOKEN = cliToken;
      return;
    }
    console.log('Claude CLI token is invalid or expired.\n');
  }

  // 4. No valid token found — prompt user
  const token = await promptForToken();
  if (await validateToken(token)) {
    saveToken(token);
    process.env._ART_OAUTH_TOKEN = token;
    console.log('Token saved to ~/.config/aer-art/token\n');
    return;
  }

  console.error('Provided token is invalid. Exiting.');
  process.exit(1);
}
