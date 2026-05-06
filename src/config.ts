import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HOME_DIR = process.env.HOME || os.homedir();

// Package install root — derived from this file's location at runtime.
// dist/config.js → up one = package root. Source-mode (ts-node) lands at
// src/config.ts → up one = same package root. Used only for shipped assets
// like `container/build.sh`, `container/skills/`, `container/agent-runner/src/`.
const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

export function getPackageAssetPath(...subpath: string[]): string {
  return path.resolve(PACKAGE_ROOT, ...subpath);
}

export const ART_DIR_NAME = '__art__';

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'aer-art',
  'mount-allowlist.json',
);
export const IMAGE_REGISTRY_PATH = path.join(
  HOME_DIR,
  '.config',
  'aer-art',
  'images.json',
);
export const MCP_REGISTRY_PATH = path.join(
  HOME_DIR,
  '.config',
  'aer-art',
  'mcp-registry.json',
);
// Runtime data root — must be configured via setDataDir() before use.
// In CLI mode this is set to <projectDir>/__art__/.tmp by setupEngine().
let _DATA_DIR: string | null = null;

export function setDataDir(dir: string): void {
  _DATA_DIR = path.resolve(dir);
}

export function getDataDir(): string {
  if (_DATA_DIR === null) {
    throw new Error(
      'DATA_DIR not configured. Call setDataDir() before reading it.',
    );
  }
  return _DATA_DIR;
}

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'art-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
let _credentialProxyPort: number | null = null;
let _codexAuthProxyPort: number | null = null;
export function getCredentialProxyPort(): number {
  if (_credentialProxyPort !== null) return _credentialProxyPort;
  return parseInt(process.env.CREDENTIAL_PROXY_PORT || '3001', 10);
}
export function setCredentialProxyPort(port: number): void {
  _credentialProxyPort = port;
}
export function getCodexAuthProxyPort(): number {
  if (_codexAuthProxyPort !== null) return _codexAuthProxyPort;
  return parseInt(process.env.CODEX_AUTH_PROXY_PORT || '3002', 10);
}
export function setCodexAuthProxyPort(port: number): void {
  _codexAuthProxyPort = port;
}
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '2147483647',
  10,
); // ~24.8 days — effectively infinite

// Timezone — used by pipeline-runner for stage timestamps
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
