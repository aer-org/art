import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}));

describe('remote-config', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.mkdirSync).mockReset();
  });

  async function loadModule() {
    return import('../../src/remote-config.js');
  }

  describe('loadRemotes', () => {
    it('returns empty config when file does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const { loadRemotes } = await loadModule();
      expect(loadRemotes()).toEqual({ remotes: {} });
    });

    it('parses valid config', async () => {
      const config = {
        remotes: {
          origin: { url: 'https://art.example.com', default: true },
        },
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));
      const { loadRemotes } = await loadModule();
      expect(loadRemotes()).toEqual(config);
    });
  });

  describe('saveRemotes', () => {
    it('writes JSON to config dir', async () => {
      const config = {
        remotes: {
          origin: { url: 'https://art.example.com', default: true },
        },
      };
      const { saveRemotes } = await loadModule();
      saveRemotes(config);
      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('remotes.json'),
        JSON.stringify(config, null, 2),
      );
    });
  });

  describe('getDefaultRemote', () => {
    it('returns null when no remotes configured', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const { getDefaultRemote } = await loadModule();
      expect(getDefaultRemote()).toBeNull();
    });

    it('returns the default remote', async () => {
      const config = {
        remotes: {
          staging: { url: 'https://staging.example.com' },
          origin: { url: 'https://art.example.com', default: true },
        },
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));
      const { getDefaultRemote } = await loadModule();
      const result = getDefaultRemote();
      expect(result?.name).toBe('origin');
      expect(result?.remote.url).toBe('https://art.example.com');
    });

    it('falls back to first remote when none marked default', async () => {
      const config = {
        remotes: {
          staging: { url: 'https://staging.example.com' },
        },
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));
      const { getDefaultRemote } = await loadModule();
      const result = getDefaultRemote();
      expect(result?.name).toBe('staging');
    });
  });

  describe('getRemote', () => {
    it('returns null for unknown remote', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const { getRemote } = await loadModule();
      expect(getRemote('nonexistent')).toBeNull();
    });

    it('returns the matching remote', async () => {
      const config = {
        remotes: {
          origin: { url: 'https://art.example.com' },
        },
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));
      const { getRemote } = await loadModule();
      expect(getRemote('origin')?.url).toBe('https://art.example.com');
    });
  });

  describe('remote credentials', () => {
    it('returns null when credential file does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const { loadRemoteCredentials } = await loadModule();
      expect(loadRemoteCredentials('origin')).toBeNull();
    });

    it('saves and loads credentials with restricted permissions', async () => {
      const creds = {
        token: 'art_rw_xxx',
        scope: 'write' as const,
        username: 'sihun',
        saved_at: '2026-04-27T00:00:00Z',
      };
      const { saveRemoteCredentials } = await loadModule();
      saveRemoteCredentials('origin', creds);

      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('origin.json'),
        JSON.stringify(creds, null, 2),
        { mode: 0o600 },
      );
    });

    it('deletes credentials', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const { deleteRemoteCredentials } = await loadModule();
      expect(deleteRemoteCredentials('origin')).toBe(true);
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('origin.json'),
      );
    });
  });
});
