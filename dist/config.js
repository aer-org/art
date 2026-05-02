import os from 'os';
import path from 'path';
// Absolute paths needed for container mounts
let PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();
export const ART_DIR_NAME = '__art__';
// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'aer-art', 'mount-allowlist.json');
export const IMAGE_REGISTRY_PATH = path.join(HOME_DIR, '.config', 'aer-art', 'images.json');
export const MCP_REGISTRY_PATH = path.join(HOME_DIR, '.config', 'aer-art', 'mcp-registry.json');
export let STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export let GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export let DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
/**
 * Reconfigure path roots for art CLI mode.
 * engineRoot = AerArt install dir (for DB, store, groups)
 */
export function setEngineRoot(engineRoot) {
    PROJECT_ROOT = engineRoot;
    STORE_DIR = path.resolve(engineRoot, 'store');
    GROUPS_DIR = path.resolve(engineRoot, 'groups');
    DATA_DIR = path.resolve(engineRoot, 'data');
}
export function setDataDir(dir) {
    DATA_DIR = path.resolve(dir);
}
export function getProjectRoot() {
    return PROJECT_ROOT;
}
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || 'art-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760', 10); // 10MB default
let _credentialProxyPort = null;
let _codexAuthProxyPort = null;
export function getCredentialProxyPort() {
    if (_credentialProxyPort !== null)
        return _credentialProxyPort;
    return parseInt(process.env.CREDENTIAL_PROXY_PORT || '3001', 10);
}
export function setCredentialProxyPort(port) {
    _credentialProxyPort = port;
}
export function getCodexAuthProxyPort() {
    if (_codexAuthProxyPort !== null)
        return _codexAuthProxyPort;
    return parseInt(process.env.CODEX_AUTH_PROXY_PORT || '3002', 10);
}
export function setCodexAuthProxyPort(port) {
    _codexAuthProxyPort = port;
}
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '2147483647', 10); // ~24.8 days — effectively infinite
// Timezone — used by pipeline-runner for stage timestamps
export const TIMEZONE = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
//# sourceMappingURL=config.js.map