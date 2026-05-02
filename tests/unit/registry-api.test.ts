import { afterEach, describe, expect, it, vi } from 'vitest';

describe('RegistryApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('checks dockerfiles without authorization when no token is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ name: 'python', latest_hash: 'sha256:abc' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { RegistryApi } = await import('../../src/registry-api.js');
    const api = new RegistryApi('https://registry.example');

    await api.checkDockerfile('python');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://registry.example/v1/dockerfiles/python',
      {
        method: 'GET',
        headers: { 'content-type': 'application/json' },
      },
    );
  });

  it('checks dockerfiles with authorization when a token is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ name: 'python', latest_hash: 'sha256:abc' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { RegistryApi } = await import('../../src/registry-api.js');
    const api = new RegistryApi('https://registry.example', 'art_ro_token');

    await api.checkDockerfile('python');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://registry.example/v1/dockerfiles/python',
      {
        method: 'GET',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer art_ro_token',
        },
      },
    );
  });
});
