import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    chmodSync: vi.fn(),
  },
}));

describe('remote CLI', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.mkdirSync).mockReset();
  });

  async function loadModule() {
    return import('../../../src/remote-config.js');
  }

  it('loadRemotes returns empty when no file', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { loadRemotes } = await loadModule();
    expect(loadRemotes()).toEqual({ remotes: {} });
  });

  it('saveRemotes writes JSON', async () => {
    const { saveRemotes } = await loadModule();
    const config = {
      remotes: {
        origin: { url: 'https://art.example.com', default: true as const },
      },
    };
    saveRemotes(config);
    expect(fs.mkdirSync).toHaveBeenCalled();
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('remotes.json'),
      JSON.stringify(config, null, 2),
    );
  });

  it('getDefaultRemote returns the default entry', async () => {
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
  });

  it('getDefaultRemote falls back to first entry', async () => {
    const config = {
      remotes: { staging: { url: 'https://staging.example.com' } },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));
    const { getDefaultRemote } = await loadModule();
    expect(getDefaultRemote()?.name).toBe('staging');
  });

  it('getRemote returns null for missing remote', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { getRemote } = await loadModule();
    expect(getRemote('nonexistent')).toBeNull();
  });

  it('saveRemoteCredentials writes with restricted permissions', async () => {
    const { saveRemoteCredentials } = await loadModule();
    saveRemoteCredentials('origin', {
      token: 'art_rw_xxx',
      scope: 'write',
      saved_at: '2026-04-27T00:00:00Z',
    });
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('origin.json'),
      expect.any(String),
      { mode: 0o600 },
    );
  });

  it('deleteRemoteCredentials removes file', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const { deleteRemoteCredentials } = await loadModule();
    expect(deleteRemoteCredentials('origin')).toBe(true);
    expect(fs.unlinkSync).toHaveBeenCalled();
  });
});
