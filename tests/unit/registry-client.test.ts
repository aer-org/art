import { afterEach, describe, expect, it, vi } from 'vitest';

describe('RegistryClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('omits authorization header for anonymous reads', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version_id: 1, content_hash: 'sha256:abc' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { RegistryClient } = await import('../../src/registry-client.js');
    const client = new RegistryClient({ server: 'https://registry.example' });

    await client.resolveAgentTag({ name: 'demo-agent', tag: 'latest' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://registry.example/v1/agents/demo-agent/tags/latest',
      { headers: {} },
    );
  });

  it('sends bearer token when credentials are available', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version_id: 1, content_hash: 'sha256:abc' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { RegistryClient } = await import('../../src/registry-client.js');
    const client = new RegistryClient({
      server: 'https://registry.example',
      token: 'art_ro_token',
    });

    await client.resolveAgentTag({ name: 'demo-agent', tag: 'latest' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://registry.example/v1/agents/demo-agent/tags/latest',
      { headers: { authorization: 'Bearer art_ro_token' } },
    );
  });
});
