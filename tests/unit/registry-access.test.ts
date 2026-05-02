import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';

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

describe('registry read access', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
  });

  async function loadModule() {
    return import('../../src/registry-access.js');
  }

  it('uses default registry anonymously when nothing is configured', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const { resolveRegistryReadAccess } = await loadModule();

    expect(resolveRegistryReadAccess()).toEqual({
      server: 'https://aerclaw.com',
      authenticated: false,
      source: 'default anonymous access',
    });
  });

  it('uses the default remote anonymously when remote credentials are missing', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      String(p).endsWith('remotes.json'),
    );
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (String(p).endsWith('remotes.json')) {
        return JSON.stringify({
          remotes: {
            origin: { url: 'https://registry.example', default: true },
          },
        });
      }
      throw new Error(`Unexpected read: ${String(p)}`);
    });

    const { resolveRegistryReadAccess } = await loadModule();

    expect(resolveRegistryReadAccess()).toEqual({
      server: 'https://registry.example',
      authenticated: false,
      source: 'remote "origin" anonymous access',
    });
  });

  it('uses default remote credentials when present', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const path = String(p);
      return path.endsWith('remotes.json') || path.endsWith('origin.json');
    });
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith('remotes.json')) {
        return JSON.stringify({
          remotes: {
            origin: { url: 'https://registry.example', default: true },
          },
        });
      }
      if (path.endsWith('origin.json')) {
        return JSON.stringify({
          token: 'art_ro_token',
          scope: 'read',
          saved_at: '2026-05-02T00:00:00.000Z',
        });
      }
      throw new Error(`Unexpected read: ${path}`);
    });

    const { resolveRegistryReadAccess } = await loadModule();

    expect(resolveRegistryReadAccess()).toEqual({
      server: 'https://registry.example',
      token: 'art_ro_token',
      authenticated: true,
      source: 'remote "origin" credentials',
    });
  });

  it('uses saved credentials when no default remote exists', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      String(p).endsWith('credentials.json'),
    );
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        server: 'https://registry.example',
        token: 'art_rw_token',
        scope: 'write',
        saved_at: '2026-05-02T00:00:00.000Z',
      }),
    );

    const { resolveRegistryReadAccess } = await loadModule();

    expect(resolveRegistryReadAccess()).toEqual({
      server: 'https://registry.example',
      token: 'art_rw_token',
      authenticated: true,
      source: 'saved credentials',
    });
  });
});
