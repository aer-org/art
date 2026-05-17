import { DEFAULT_REGISTRY_SERVER, loadCredentials } from './registry-client.js';
import { getDefaultRemote, loadRemoteCredentials } from './remote-config.js';

export interface RegistryReadAccess {
  server: string;
  token?: string;
  authenticated: boolean;
  source: string;
}

function normalizeServerUrl(url: string): string {
  try {
    return new URL(url).toString().replace(/\/$/, '');
  } catch {
    return url.replace(/\/+$/, '');
  }
}

export function resolveRegistryReadAccess(): RegistryReadAccess {
  const saved = loadCredentials();
  const remote = getDefaultRemote();
  if (remote) {
    const remoteCreds = loadRemoteCredentials(remote.name);
    if (remoteCreds) {
      return {
        server: remote.remote.url,
        token: remoteCreds.token,
        authenticated: true,
        source: `remote "${remote.name}" credentials`,
      };
    }

    if (
      saved &&
      normalizeServerUrl(saved.server) === normalizeServerUrl(remote.remote.url)
    ) {
      return {
        server: remote.remote.url,
        token: saved.token,
        authenticated: true,
        source: `saved credentials for remote "${remote.name}"`,
      };
    }

    return {
      server: remote.remote.url,
      authenticated: false,
      source: `remote "${remote.name}" anonymous access`,
    };
  }

  if (saved) {
    return {
      server: saved.server,
      token: saved.token,
      authenticated: true,
      source: 'saved credentials',
    };
  }

  return {
    server: DEFAULT_REGISTRY_SERVER,
    authenticated: false,
    source: 'default anonymous access',
  };
}
