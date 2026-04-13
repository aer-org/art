import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
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

import { CodexExternalAuthManager } from './codex-external-auth.js';

interface AuthFile {
  tokens: {
    access_token: string;
    refresh_token: string;
    id_token: string;
    account_id?: string;
  };
}

function makeIdToken(accountId: string, plan = 'plus'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
    'base64url',
  );
  const payload = Buffer.from(
    JSON.stringify({
      auth: {
        chatgpt_account_id: accountId,
        chatgpt_plan_type: plan,
      },
    }),
  ).toString('base64url');
  return `${header}.${payload}.sig`;
}

function writeAuth(authPath: string, auth: AuthFile): void {
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2) + '\n', 'utf8');
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
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        id_token: makeIdToken('acct-1'),
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
    vi.mocked(global.fetch).mockImplementation(
      async () =>
        ({
          ok: true,
          json: async () => ({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            id_token: makeIdToken('acct-1', 'pro'),
          }),
        }) as Response,
    );

    const manager = new CodexExternalAuthManager({ authPath });
    const [first, second] = await Promise.all([
      manager.refreshExternalLogin(),
      manager.refreshExternalLogin(),
    ]);

    expect(first.accessToken).toBe('new-access');
    expect(second.accessToken).toBe('new-access');
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const persisted = JSON.parse(fs.readFileSync(authPath, 'utf8')) as AuthFile;
    expect(persisted.tokens.access_token).toBe('new-access');
    expect(persisted.tokens.refresh_token).toBe('new-refresh');
  });

  it('returns auth written by another process after lock acquisition', async () => {
    vi.mocked(lockfile.lock).mockImplementation(async () => {
      writeAuth(authPath, {
        tokens: {
          access_token: 'fresh-from-disk',
          refresh_token: 'fresh-refresh',
          id_token: makeIdToken('acct-2', 'team'),
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
});
