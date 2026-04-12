/**
 * OAuth access-token refresher for Anthropic Claude Code credentials.
 *
 * Reads ~/.claude/.credentials.json (same store the Claude CLI uses), and when
 * the access token is near expiry performs the OAuth 2.0 refresh_token grant
 * against the Anthropic token endpoint, writing the new tokens back to the
 * same file atomically.
 *
 * Cross-process coordination uses proper-lockfile on the credentials file —
 * the same lock path the Claude CLI uses — so parallel `art run` invocations
 * and a host-side Claude CLI refresh cannot race.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { request as httpsRequest } from 'https';
import * as lockfile from 'proper-lockfile';

import { logger } from './logger.js';

const DEFAULT_CREDS_PATH = path.join(
  os.homedir(),
  '.claude',
  '.credentials.json',
);
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
// Claude Code CLI production client_id (public — not a secret).
// See /home/sihun/proj/claude_src/claude-code/src/constants/oauth.ts:99
const DEFAULT_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// Refresh this many ms before actual expiry. Matches Claude CLI's 5-min buffer.
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

interface ClaudeAiOauth {
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
  scopes: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

interface CredsFile {
  claudeAiOauth?: ClaudeAiOauth;
  [key: string]: unknown;
}

/**
 * Manages an OAuth access token with automatic refresh. One instance per
 * credentials-file target; safe to call `getAccessToken` concurrently.
 */
export class OAuthRefresher {
  private cache: ClaudeAiOauth | null = null;
  private inflight: Promise<string> | null = null;
  private readonly credsPath: string;
  private readonly clientId: string;

  constructor(opts: { credsPath?: string; clientId?: string } = {}) {
    this.credsPath = opts.credsPath ?? DEFAULT_CREDS_PATH;
    this.clientId =
      opts.clientId ??
      process.env.CLAUDE_CODE_OAUTH_CLIENT_ID ??
      DEFAULT_CLIENT_ID;
  }

  /** True if the credentials file looks refreshable. */
  static isAvailable(credsPath: string = DEFAULT_CREDS_PATH): boolean {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(credsPath, 'utf-8'),
      ) as CredsFile;
      return !!parsed.claudeAiOauth?.refreshToken;
    } catch {
      return false;
    }
  }

  /**
   * Return a valid access token, refreshing if it's within the expiry buffer
   * (or unconditionally if `force`). Deduplicates concurrent refreshes within
   * the process; coordinates across processes via proper-lockfile.
   */
  async getAccessToken(force = false): Promise<string> {
    if (!force && this.cache && !this.isExpired(this.cache)) {
      return this.cache.accessToken;
    }
    // Another process may have refreshed the file since we last read it.
    const disk = this.readCreds();
    if (!disk) throw new Error(`Credentials missing at ${this.credsPath}`);
    this.cache = disk;
    if (!force && !this.isExpired(disk)) return disk.accessToken;

    if (this.inflight) return this.inflight;
    this.inflight = this.refreshLocked(force).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private isExpired(creds: ClaudeAiOauth): boolean {
    return Date.now() > creds.expiresAt - EXPIRY_BUFFER_MS;
  }

  private readCreds(): ClaudeAiOauth | null {
    try {
      const raw = fs.readFileSync(this.credsPath, 'utf-8');
      return (JSON.parse(raw) as CredsFile).claudeAiOauth ?? null;
    } catch {
      return null;
    }
  }

  private writeCreds(updated: ClaudeAiOauth): void {
    let full: CredsFile;
    try {
      full = JSON.parse(fs.readFileSync(this.credsPath, 'utf-8')) as CredsFile;
    } catch {
      full = {};
    }
    full.claudeAiOauth = updated;
    const tmp = `${this.credsPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(full, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.credsPath);
  }

  private async refreshLocked(force: boolean): Promise<string> {
    const release = await lockfile.lock(this.credsPath, {
      retries: { retries: 5, factor: 1.5, minTimeout: 500, maxTimeout: 2000 },
      stale: 30_000,
      realpath: false,
    });
    try {
      // Double-check: another holder may have refreshed while we waited.
      // Skip the early-return when force=true (caller got a 401 or similar).
      const disk = this.readCreds();
      if (!disk) throw new Error(`Credentials vanished at ${this.credsPath}`);
      if (!force && !this.isExpired(disk)) {
        this.cache = disk;
        return disk.accessToken;
      }
      const next = await this.httpRefresh(disk);
      this.writeCreds(next);
      this.cache = next;
      logger.info(
        { expiresAt: new Date(next.expiresAt).toISOString() },
        'OAuth access token refreshed',
      );
      return next.accessToken;
    } finally {
      await release();
    }
  }

  protected httpRefresh(current: ClaudeAiOauth): Promise<ClaudeAiOauth> {
    const body = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: current.refreshToken,
      client_id: this.clientId,
      scope: (current.scopes ?? []).join(' '),
    });
    const url = new URL(TOKEN_URL);
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        {
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 15_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            if (res.statusCode !== 200) {
              reject(
                new Error(
                  `OAuth refresh failed (${res.statusCode}): ${text.slice(0, 300)}`,
                ),
              );
              return;
            }
            try {
              const data = JSON.parse(text) as {
                access_token: string;
                refresh_token?: string;
                expires_in: number;
                scope?: string;
              };
              resolve({
                accessToken: data.access_token,
                refreshToken: data.refresh_token ?? current.refreshToken,
                expiresAt: Date.now() + data.expires_in * 1000,
                scopes:
                  typeof data.scope === 'string'
                    ? data.scope.split(/\s+/).filter(Boolean)
                    : current.scopes,
                subscriptionType: current.subscriptionType,
                rateLimitTier: current.rateLimitTier,
              });
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('OAuth refresh timeout')));
      req.write(body);
      req.end();
    });
  }
}
