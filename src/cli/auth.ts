import fs from 'fs';
import https from 'https';
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

/**
 * Exchange an OAuth token for a temporary API key via Anthropic's OAuth endpoint.
 */
function exchangeOAuthToken(token: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/api/oauth/claude_cli/create_api_key',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed.api_key || parsed.key || null);
            } catch {
              resolve(null);
            }
          } else {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

/**
 * Validate a token by making a minimal API call to Anthropic.
 * API keys hit /v1/messages directly.
 * OAuth tokens are first exchanged for a temp API key, then validated.
 */
function validateToken(token: string): Promise<boolean> {
  const isApiKey =
    token.startsWith('sk-ant-api') ||
    (!token.startsWith('sk-ant-oat') && !token.startsWith('eyJ'));

  if (isApiKey) {
    return validateWithApiKey(token);
  }

  // OAuth flow: exchange first, then validate the temp key
  return exchangeOAuthToken(token).then((tempKey) => {
    if (!tempKey) {
      console.error('  ✗ OAuth 토큰 교환 실패 (만료되었거나 유효하지 않음)');
      return false;
    }
    return validateWithApiKey(tempKey);
  });
}

function validateWithApiKey(apiKey: string): Promise<boolean> {
  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
  });

  return new Promise<boolean>((resolve) => {
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': apiKey,
        },
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            console.log('  ✓ API 토큰 유효');
            resolve(true);
          } else {
            try {
              const err = JSON.parse(data);
              console.error(
                `  ✗ API 응답 ${res.statusCode}: ${err.error?.message || data.slice(0, 120)}`,
              );
            } catch {
              console.error(`  ✗ API 응답 ${res.statusCode}`);
            }
            resolve(false);
          }
        });
      },
    );
    req.on('error', (err) => {
      console.error(`  ✗ API 연결 실패: ${err.message}`);
      resolve(false);
    });
    req.on('timeout', () => {
      req.destroy();
      console.error('  ✗ API 요청 타임아웃');
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

function maskToken(token: string): string {
  if (token.length <= 12) return '***';
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
function setAuthEnvVars(token: string): void {
  if (
    token.startsWith('sk-ant-api') ||
    (!token.startsWith('sk-ant-oat') && !token.startsWith('eyJ'))
  ) {
    // Looks like an API key
    process.env.ANTHROPIC_API_KEY = token;
  } else {
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
export async function ensureAuth(): Promise<void> {
  let token: string | null = null;
  let source = '';

  // 1. Check .env in project dir for a non-empty token
  const envFile = path.join(process.cwd(), '.env');
  try {
    const env = fs.readFileSync(envFile, 'utf-8');
    for (const line of env.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('ANTHROPIC_API_KEY=')) {
        const val = trimmed.slice('ANTHROPIC_API_KEY='.length).trim();
        if (val) {
          token = val;
          source = 'API key from .env';
          break;
        }
      }
      if (
        (trimmed.startsWith('CLAUDE_CODE_OAUTH_TOKEN=') ||
          trimmed.startsWith('ANTHROPIC_AUTH_TOKEN=')) &&
        trimmed.split('=', 2)[1]?.trim()
      ) {
        token = trimmed.split('=', 2)[1]!.trim();
        source = 'token from .env';
        break;
      }
    }
  } catch {
    /* no .env */
  }

  // 2. Check saved token from previous art setup
  if (!token) {
    const saved = readSavedToken();
    if (saved) {
      token = saved;
      source = 'saved token';
    }
  }

  // 3. Try Claude CLI credentials
  if (!token) {
    const cliToken = readClaudeCliToken();
    if (cliToken) {
      token = cliToken;
      source = 'Claude CLI token';
    }
  }

  // 4. No token found — ask user to provide one
  if (!token) {
    console.log(
      'No Claude authentication found.\n\n' +
        'To get a token, run:\n\n' +
        '  claude setup-token\n\n' +
        'Then paste the token below.\n',
    );

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await new Promise<string>((resolve) =>
      rl.question('Token: ', resolve),
    );
    rl.close();

    const trimmed = answer.trim();
    if (!trimmed) {
      console.error('No token provided. Exiting.');
      process.exit(1);
    }

    saveToken(trimmed);
    token = trimmed;
    source = 'manual input';
  }

  console.log(`Using ${source} (${maskToken(token)})`);

  // Validate token with a live API call
  console.log('토큰 검증 중...');
  if (!(await validateToken(token))) {
    console.error(
      '  ✗ 토큰이 유효하지 않거나 만료되었습니다.\n' +
        '  `claude setup-token` 으로 새 토큰을 발급받으세요.',
    );
    process.exit(1);
  }

  setAuthEnvVars(token);
}
