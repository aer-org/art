import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('proper-lockfile', () => ({
  lock: vi.fn(),
}));

import * as lockfile from 'proper-lockfile';

import { CodexExternalAuthManager } from '../../src/codex-external-auth.js';

interface AuthFile {
  tokens: {
    access_token: string;
    refresh_token: string;
    id_token: string;
    account_id?: string;
  };
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'none', typ: 'JWT' }),
  ).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

function makeIdToken(accountId: string, plan = 'plus', exp?: number): string {
  return makeJwt({
    ...(exp === undefined ? {} : { exp }),
    auth: {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: plan,
    },
  });
}

function makeAccessToken(exp?: number): string {
  return makeJwt({
    aud: 'codex',
    ...(exp === undefined ? {} : { exp }),
  });
}

function futureExp(seconds = 3600): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

function pastExp(seconds = 60): number {
  return Math.floor(Date.now() / 1000) - seconds;
}

function writeAuth(authPath: string, auth: AuthFile): void {
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2) + '\n', 'utf8');
}

function makeRefreshResponse(
  opts: {
    accessToken?: string;
    refreshToken?: string;
    idToken?: string;
    accountId?: string;
    plan?: string;
  } = {},
): Response {
  const accountId = opts.accountId ?? 'acct-1';
  const plan = opts.plan ?? 'pro';
  return {
    ok: true,
    json: async () => ({
      access_token: opts.accessToken ?? makeAccessToken(futureExp()),
      refresh_token: opts.refreshToken ?? 'new-refresh',
      id_token: opts.idToken ?? makeIdToken(accountId, plan, futureExp()),
    }),
  } as Response;
}

describe('CodexExternalAuthManager', () => {
  const realFetch = global.fetch;
  let tmpDir: string;
  let authPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-'));
    authPath = path.join(tmpDir, 'auth.json');
    writeAuth(authPath, {
      tokens: {
        access_token: makeAccessToken(futureExp()),
        refresh_token: 'old-refresh',
        id_token: makeIdToken('acct-1', 'plus', futureExp()),
      },
    });
    vi.mocked(lockfile.lock).mockReset();
    vi.mocked(lockfile.lock).mockResolvedValue(async () => {});
    global.fetch = vi.fn() as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('deduplicates concurrent refreshes within a process', async () => {
    const refreshedAccess = makeAccessToken(futureExp(7200));
    vi.mocked(global.fetch).mockImplementation(async () =>
      makeRefreshResponse({
        accessToken: refreshedAccess,
        accountId: 'acct-1',
        plan: 'pro',
      }),
    );

    const manager = new CodexExternalAuthManager({ authPath });
    const [first, second] = await Promise.all([
      manager.refreshExternalLogin(),
      manager.refreshExternalLogin(),
    ]);

    expect(first.accessToken).toBe(refreshedAccess);
    expect(second.accessToken).toBe(refreshedAccess);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const persisted = JSON.parse(fs.readFileSync(authPath, 'utf8')) as AuthFile;
    expect(persisted.tokens.access_token).toBe(refreshedAccess);
    expect(persisted.tokens.refresh_token).toBe('new-refresh');
  });

  it('returns auth written by another process after lock acquisition', async () => {
    vi.mocked(lockfile.lock).mockImplementation(async () => {
      writeAuth(authPath, {
        tokens: {
          access_token: 'fresh-from-disk',
          refresh_token: 'fresh-refresh',
          id_token: makeIdToken('acct-2', 'team', futureExp()),
        },
      });
      return async () => {};
    });

    const manager = new CodexExternalAuthManager({ authPath });
    const login = await manager.refreshExternalLogin();

    expect(login.accessToken).toBe('fresh-from-disk');
    expect(login.chatgptAccountId).toBe('acct-2');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not accept another process update when the written tokens are still expired', async () => {
    vi.mocked(lockfile.lock).mockImplementation(async () => {
      writeAuth(authPath, {
        tokens: {
          access_token: makeAccessToken(pastExp()),
          refresh_token: 'fresh-refresh',
          id_token: makeIdToken('acct-2', 'team', pastExp()),
        },
      });
      return async () => {};
    });
    vi.mocked(global.fetch).mockImplementation(async () =>
      makeRefreshResponse({ accountId: 'acct-2', plan: 'pro' }),
    );

    const manager = new CodexExternalAuthManager({ authPath });
    const login = await manager.refreshExternalLogin();

    expect(login.chatgptAccountId).toBe('acct-2');
    expect(login.chatgptPlanType).toBe('pro');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns current auth without refresh when login tokens are still fresh', async () => {
    const manager = new CodexExternalAuthManager({ authPath });
    const login = await manager.getFreshExternalLogin();

    expect(login.chatgptAccountId).toBe('acct-1');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refreshes login before returning an expired id token to Codex', async () => {
    writeAuth(authPath, {
      tokens: {
        access_token: makeAccessToken(futureExp()),
        refresh_token: 'old-refresh',
        id_token: makeIdToken('acct-1', 'plus', pastExp()),
      },
    });
    vi.mocked(global.fetch).mockImplementation(async () =>
      makeRefreshResponse({ accountId: 'acct-1', plan: 'pro' }),
    );

    const manager = new CodexExternalAuthManager({ authPath });
    const login = await manager.getFreshExternalLogin();

    expect(login.chatgptPlanType).toBe('pro');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
