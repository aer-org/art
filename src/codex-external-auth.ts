import fs from 'fs';
import os from 'os';
import path from 'path';
import * as lockfile from 'proper-lockfile';

import { CodexExternalLogin } from './codex-app-server-client.js';
import { logger } from './logger.js';

const DEFAULT_CODEX_HOME = path.join(os.homedir(), '.codex');
const REFRESH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR = 'CODEX_REFRESH_TOKEN_URL_OVERRIDE';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

interface CodexIdTokenInfo {
  chatgpt_account_id?: string;
  chatgpt_plan_type?: string;
}

interface CodexTokenData {
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id?: string;
}

interface CodexAuthDotJson {
  tokens?: CodexTokenData;
}

interface RefreshResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
}

function resolveCodexHome(): string {
  const envHome = process.env.CODEX_HOME?.trim();
  return envHome ? path.resolve(envHome) : DEFAULT_CODEX_HOME;
}

function getAuthPath(): string {
  return path.join(resolveCodexHome(), 'auth.json');
}

function decodeJwtPayload<T>(jwt: string): T {
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[1]) {
    throw new Error('Invalid JWT format');
  }
  const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
  return JSON.parse(payload) as T;
}

function parseIdTokenInfo(idToken: string): CodexIdTokenInfo {
  const claims = decodeJwtPayload<{
    auth?: CodexIdTokenInfo;
    'https://api.openai.com/auth'?: CodexIdTokenInfo;
  }>(idToken);
  return claims['https://api.openai.com/auth'] ?? claims.auth ?? {};
}

function loadHostAuth(authPath: string): CodexAuthDotJson {
  if (!fs.existsSync(authPath)) {
    throw new Error(
      `Codex auth not found at ${authPath}. Run Codex login on the host first.`,
    );
  }
  return JSON.parse(fs.readFileSync(authPath, 'utf-8')) as CodexAuthDotJson;
}

function persistHostAuth(authPath: string, auth: CodexAuthDotJson): void {
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  const tmpPath = `${authPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(auth, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(tmpPath, authPath);
  try {
    fs.chmodSync(authPath, 0o600);
  } catch {
    // best effort
  }
}

function toExternalLogin(auth: CodexAuthDotJson): CodexExternalLogin {
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
  private inflight: Promise<CodexExternalLogin> | null = null;
  private readonly authPath: string;

  constructor(opts: { authPath?: string } = {}) {
    this.authPath = opts.authPath ?? getAuthPath();
  }

  getExternalLogin(): CodexExternalLogin {
    return toExternalLogin(loadHostAuth(this.authPath));
  }

  async refreshExternalLogin(): Promise<CodexExternalLogin> {
    const before = loadHostAuth(this.authPath);
    if (this.inflight) return this.inflight;

    this.inflight = this.refreshLocked(before).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refreshLocked(
    before: CodexAuthDotJson,
  ): Promise<CodexExternalLogin> {
    const release = await lockfile.lock(this.authPath, {
      retries: { retries: 5, factor: 1.5, minTimeout: 500, maxTimeout: 2000 },
      stale: 30_000,
      realpath: false,
    });
    try {
      const auth = loadHostAuth(this.authPath);
      if (
        auth.tokens?.access_token &&
        auth.tokens?.access_token !== before.tokens?.access_token
      ) {
        return toExternalLogin(auth);
      }

      if (
        auth.tokens?.refresh_token &&
        auth.tokens?.refresh_token !== before.tokens?.refresh_token
      ) {
        return toExternalLogin(auth);
      }

      if (
        auth.tokens?.id_token &&
        auth.tokens?.id_token !== before.tokens?.id_token
      ) {
        return toExternalLogin(auth);
      }

      return this.refreshViaHttp(auth);
    } finally {
      await release();
    }
  }

  private async refreshViaHttp(
    auth: CodexAuthDotJson,
  ): Promise<CodexExternalLogin> {
    const refreshToken = auth.tokens?.refresh_token;
    if (!refreshToken) {
      throw new Error('Codex auth is missing refresh_token');
    }

    const endpoint =
      process.env[REFRESH_TOKEN_URL_OVERRIDE_ENV_VAR] ?? REFRESH_TOKEN_URL;
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
      throw new Error(
        `Failed to refresh Codex OAuth token: ${response.status} ${body}`,
      );
    }

    const refreshed = (await response.json()) as RefreshResponse;
    if (!auth.tokens) {
      throw new Error('Codex auth tokens disappeared during refresh');
    }

    auth.tokens = {
      ...auth.tokens,
      id_token: refreshed.id_token ?? auth.tokens.id_token,
      access_token: refreshed.access_token ?? auth.tokens.access_token,
      refresh_token: refreshed.refresh_token ?? auth.tokens.refresh_token,
    };
    persistHostAuth(this.authPath, auth);
    const login = toExternalLogin(auth);
    logger.info(
      { authPath: this.authPath, accountId: login.chatgptAccountId },
      'Codex OAuth token refreshed',
    );
    return login;
  }
}
