/**
 * Container runtime abstraction for AerArt.
 * Supports Docker, Podman, and udocker with automatic detection and fallback.
 * All runtime-specific logic lives here so the rest of the codebase uses
 * capability checks instead of runtime-specific branches.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { logger } from './logger.js';
// ---------------------------------------------------------------------------
// Capabilities per runtime
// ---------------------------------------------------------------------------
const DOCKER_CAPABILITIES = {
    canBuild: true,
    supportsAutoRemove: true,
    supportsNaming: true,
    supportsAddHost: true,
    supportsDevices: true,
    supportsDeviceCgroupRule: true,
    supportsPsFilter: true,
    supportsUser: true,
    supportsStdin: true,
};
const PODMAN_CAPABILITIES = {
    canBuild: true,
    supportsAutoRemove: true,
    supportsNaming: true,
    supportsAddHost: true,
    supportsDevices: true,
    supportsDeviceCgroupRule: true,
    supportsPsFilter: true,
    supportsUser: true,
    supportsStdin: true,
};
const UDOCKER_CAPABILITIES = {
    canBuild: false,
    supportsAutoRemove: false,
    supportsNaming: false,
    supportsAddHost: false,
    supportsDevices: false,
    supportsDeviceCgroupRule: false,
    supportsPsFilter: false,
    supportsUser: true, // works in R1 mode; P1 handles it internally
    supportsStdin: false, // udocker accepts -i flag but doesn't connect stdin to execution engine
};
// ---------------------------------------------------------------------------
// Runtime config file path
// ---------------------------------------------------------------------------
const RUNTIME_CONFIG_PATH = path.join(os.homedir(), '.config', 'aer-art', 'runtime.json');
// ---------------------------------------------------------------------------
// Module-level state (lazy-initialized)
// ---------------------------------------------------------------------------
let cachedRuntime = null;
// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------
function commandExists(cmd) {
    try {
        execSync(`which ${cmd}`, { stdio: 'pipe', timeout: 5000 });
        return true;
    }
    catch {
        return false;
    }
}
function isDockerActuallyPodman() {
    try {
        const output = execSync('docker info', {
            stdio: ['pipe', 'pipe', 'pipe'],
            encoding: 'utf-8',
            timeout: 10000,
        });
        return output.toLowerCase().includes('podman');
    }
    catch {
        return false;
    }
}
function detectSELinux() {
    if (os.platform() !== 'linux')
        return false;
    try {
        const config = '/etc/selinux/config';
        if (!fs.existsSync(config))
            return false;
        const output = execSync('getenforce', {
            stdio: ['pipe', 'pipe', 'pipe'],
            encoding: 'utf-8',
            timeout: 3000,
        }).trim();
        return output !== 'Disabled';
    }
    catch {
        return false;
    }
}
function isPodmanRootless() {
    try {
        const output = execSync('podman info --format json', {
            stdio: ['pipe', 'pipe', 'pipe'],
            encoding: 'utf-8',
            timeout: 10000,
        });
        const info = JSON.parse(output);
        return info?.host?.security?.rootless === true;
    }
    catch {
        // Fallback: if running as non-root, likely rootless
        const uid = process.getuid?.();
        return uid != null && uid !== 0;
    }
}
function detectBridgeInterface(kind) {
    if (os.platform() !== 'linux')
        return null;
    const ifaces = os.networkInterfaces();
    if (kind === 'docker') {
        return ifaces['docker0'] ? 'docker0' : null;
    }
    if (kind === 'podman') {
        if (ifaces['podman0'])
            return 'podman0';
        if (ifaces['cni-podman0'])
            return 'cni-podman0';
        return null;
    }
    return null; // udocker has no bridge
}
function detectProxyBindHost(rt) {
    if (process.env.CREDENTIAL_PROXY_HOST) {
        return process.env.CREDENTIAL_PROXY_HOST;
    }
    // udocker: no network isolation, container uses host network directly
    if (rt.kind === 'udocker')
        return '127.0.0.1';
    // macOS: Docker Desktop VM routes host.docker.internal to loopback
    if (os.platform() === 'darwin')
        return '127.0.0.1';
    // WSL: Docker Desktop (same VM routing as macOS)
    if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop'))
        return '127.0.0.1';
    // Linux: bind to the bridge interface IP
    if (rt.bridgeInterface) {
        const ifaces = os.networkInterfaces();
        const iface = ifaces[rt.bridgeInterface];
        if (iface) {
            const ipv4 = iface.find((a) => a.family === 'IPv4');
            if (ipv4)
                return ipv4.address;
        }
    }
    return '0.0.0.0';
}
// ---------------------------------------------------------------------------
// Runtime construction
// ---------------------------------------------------------------------------
function buildRuntimeConfig(kind, bin) {
    const selinux = kind === 'podman' ? detectSELinux() : false;
    const rootless = kind === 'podman' ? isPodmanRootless() : false;
    const capabilities = kind === 'docker'
        ? DOCKER_CAPABILITIES
        : kind === 'podman'
            ? PODMAN_CAPABILITIES
            : UDOCKER_CAPABILITIES;
    const hostGateway = kind === 'docker'
        ? 'host.docker.internal'
        : kind === 'podman'
            ? 'host.containers.internal'
            : 'localhost';
    return {
        kind,
        bin,
        capabilities,
        hostGateway,
        bridgeInterface: detectBridgeInterface(kind),
        selinux,
        rootless,
    };
}
function loadSavedRuntime() {
    try {
        const raw = fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function saveRuntimeChoice(kind) {
    const dir = path.dirname(RUNTIME_CONFIG_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify({ runtime: kind, confirmedAt: new Date().toISOString() }, null, 2) + '\n');
}
// ---------------------------------------------------------------------------
// Interactive confirmation (first-run only)
// ---------------------------------------------------------------------------
async function askConfirmation(prompt) {
    // Non-interactive environments (CI, piped stdin): auto-accept
    if (!process.stdin.isTTY)
        return true;
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    const answer = await new Promise((resolve) => rl.question(prompt, resolve));
    rl.close();
    const trimmed = answer.trim().toLowerCase();
    return trimmed === '' || trimmed === 'y' || trimmed === 'yes';
}
function detectAvailableRuntimes() {
    const results = [];
    // Docker (check if it's actually podman-docker alias)
    if (commandExists('docker')) {
        if (isDockerActuallyPodman()) {
            results.push({
                kind: 'podman',
                bin: 'docker', // podman-docker alias
                label: 'podman (installed as docker alias)',
            });
        }
        else {
            results.push({ kind: 'docker', bin: 'docker', label: 'docker' });
        }
    }
    // Podman (native, skip if docker alias already detected it)
    if (commandExists('podman') && !results.some((r) => r.kind === 'podman')) {
        const rootless = isPodmanRootless();
        results.push({
            kind: 'podman',
            bin: 'podman',
            label: rootless ? 'podman (rootless)' : 'podman',
        });
    }
    // udocker
    if (commandExists('udocker')) {
        results.push({
            kind: 'udocker',
            bin: 'udocker',
            label: 'udocker (user-space)',
        });
    }
    return results;
}
function udockerWarnings() {
    return [
        '  \u26a0 Reduced isolation (PRoot mode \u2014 no kernel namespaces)',
        '  \u26a0 Device passthrough unavailable in default mode (use R1 for GPU)',
        "  \u26a0 Image building unavailable (use 'udocker pull' or 'udocker load')",
    ].join('\n');
}
async function detectAndConfirmRuntime() {
    const available = detectAvailableRuntimes();
    if (available.length === 0) {
        console.error('\n\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
        console.error('\u2551  FATAL: No container runtime found                              \u2551');
        console.error('\u2551                                                                \u2551');
        console.error('\u2551  Install one of the following:                                  \u2551');
        console.error('\u2551  1. Docker: https://docs.docker.com/get-docker/                \u2551');
        console.error('\u2551  2. Podman: https://podman.io/getting-started/installation     \u2551');
        console.error('\u2551  3. udocker: https://indigo-dc.github.io/udocker/installation  \u2551');
        console.error('\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d\n');
        throw new Error('No container runtime found');
    }
    for (const candidate of available) {
        let prompt = `Detected container runtime: ${candidate.label}\n`;
        if (candidate.kind === 'udocker') {
            prompt += udockerWarnings() + '\n';
        }
        prompt += `Continue with ${candidate.kind}? [Y/n] `;
        const accepted = await askConfirmation(prompt);
        if (accepted) {
            saveRuntimeChoice(candidate.kind);
            logger.info({ runtime: candidate.kind, bin: candidate.bin }, 'Container runtime confirmed and saved');
            return buildRuntimeConfig(candidate.kind, candidate.bin);
        }
    }
    // All rejected
    throw new Error('All available container runtimes were rejected');
}
// ---------------------------------------------------------------------------
// Public API: initialization
// ---------------------------------------------------------------------------
/**
 * Initialize and return the container runtime config.
 * Resolution order:
 * 1. CONTAINER_RUNTIME env var → use directly without confirmation
 * 2. Saved choice in ~/.config/aer-art/runtime.json
 * 3. Auto-detect + interactive confirmation (first run)
 *
 * Call this once at startup. Subsequent calls return the cached result.
 */
export async function initRuntime() {
    if (cachedRuntime)
        return cachedRuntime;
    // 1. Env var override — no confirmation needed
    const envRuntime = process.env.CONTAINER_RUNTIME;
    if (envRuntime && ['docker', 'podman', 'udocker'].includes(envRuntime)) {
        const bin = envRuntime === 'podman' && commandExists('podman')
            ? 'podman'
            : envRuntime === 'udocker' && commandExists('udocker')
                ? 'udocker'
                : envRuntime === 'docker' && commandExists('docker')
                    ? 'docker'
                    : envRuntime; // fallback to kind name as bin
        cachedRuntime = buildRuntimeConfig(envRuntime, bin);
        logger.info({ runtime: envRuntime, bin, source: 'env' }, 'Container runtime set via CONTAINER_RUNTIME env var');
        return cachedRuntime;
    }
    // 2. Saved choice
    const saved = loadSavedRuntime();
    if (saved) {
        const bin = saved.runtime === 'podman' && commandExists('podman')
            ? 'podman'
            : saved.runtime === 'podman' &&
                commandExists('docker') &&
                isDockerActuallyPodman()
                ? 'docker'
                : saved.runtime === 'udocker' && commandExists('udocker')
                    ? 'udocker'
                    : saved.runtime; // fallback
        // Verify the saved runtime still exists
        if (commandExists(bin)) {
            cachedRuntime = buildRuntimeConfig(saved.runtime, bin);
            logger.info({
                runtime: saved.runtime,
                bin,
                source: 'saved',
                confirmedAt: saved.confirmedAt,
            }, 'Container runtime loaded from saved config');
            return cachedRuntime;
        }
        // Saved runtime no longer available, fall through to detection
        logger.warn({ runtime: saved.runtime }, 'Saved container runtime no longer available, re-detecting');
    }
    // 3. Auto-detect + confirm
    cachedRuntime = await detectAndConfirmRuntime();
    return cachedRuntime;
}
/**
 * Get the cached runtime config. Throws if initRuntime() hasn't been called.
 * Use this in synchronous code paths that run after startup.
 */
export function getRuntime() {
    if (!cachedRuntime) {
        throw new Error('Container runtime not initialized. Call initRuntime() at startup.');
    }
    return cachedRuntime;
}
/** Get runtime capabilities. */
export function getRuntimeCapabilities() {
    return getRuntime().capabilities;
}
/** Get the runtime binary path/name. */
export function getRuntimeBin() {
    return getRuntime().bin;
}
// ---------------------------------------------------------------------------
// Runtime-specific image & container lifecycle
// ---------------------------------------------------------------------------
const TAR_RELEASE_URL = 'https://github.com/aer-org/art/releases/download/container-latest/art-agent.tar.gz';
/**
 * Ensure the container image exists locally. If not, pull (Docker/Podman)
 * or download+load tar (udocker).
 * Returns the usable image name — for udocker this is the name from
 * `udocker load` output (full registry path), since `udocker tag` is broken.
 */
export function ensureImage(image) {
    const rt = getRuntime();
    if (rt.kind === 'udocker') {
        try {
            execSync(`${rt.bin} inspect ${image}`, {
                stdio: 'pipe',
                timeout: 10000,
            });
            return image;
        }
        catch {
            // not found — download and load
        }
        return downloadAndLoadUdockerImage(rt.bin);
    }
    // Docker / Podman — only check local existence (images are built locally)
    try {
        execSync(`${rt.bin} image inspect ${image}`, {
            stdio: 'pipe',
            timeout: 10000,
        });
        return image;
    }
    catch {
        throw new Error(`Image "${image}" not found locally. Build it with container/build.sh`);
    }
}
/**
 * Download the pre-built tar from GitHub Releases and load into udocker.
 * Returns the loaded image name (as reported by udocker load).
 */
export function downloadAndLoadUdockerImage(bin) {
    console.log('Downloading container image tar...');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-setup-'));
    const tarPath = path.join(tmpDir, 'art-agent.tar.gz');
    try {
        execSync(`curl -fSL -o ${tarPath} ${TAR_RELEASE_URL}`, {
            stdio: ['pipe', 'inherit', 'inherit'],
            timeout: 600000,
        });
        const loadOutput = execSync(`${bin} load -i ${tarPath}`, {
            encoding: 'utf-8',
            timeout: 600000,
        });
        // Extract loaded image name from udocker output: e.g. "['ghcr.io/org/img:tag']"
        const match = loadOutput.match(/\['([^']+)'\]/);
        const loadedName = match?.[1] ?? 'art-agent:latest';
        console.log(`Container image loaded: ${loadedName}\n`);
        return loadedName;
    }
    catch {
        console.error(`Failed to download or load image tar.\n` +
            `Download manually from: ${TAR_RELEASE_URL}\n` +
            `Then run: ${bin} load -i art-agent.tar.gz`);
        process.exit(1);
    }
    finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}
/**
 * Remove an image from the local runtime.
 */
export function removeImage(image) {
    const rt = getRuntime();
    try {
        execSync(`${rt.bin} rmi ${image}`, { stdio: 'pipe', timeout: 10000 });
    }
    catch {
        // image didn't exist or already removed
    }
}
/**
 * Pre-run container setup. For udocker: create named container + configure
 * Fakechroot (F1) execution mode. No-op for Docker/Podman.
 */
export function prepareContainer(image, name) {
    const rt = getRuntime();
    if (rt.kind !== 'udocker')
        return;
    execSync(`${rt.bin} create --name=${name} ${image}`, {
        stdio: 'pipe',
        timeout: 30000,
    });
    execSync(`${rt.bin} setup --execmode=F1 ${name}`, {
        stdio: 'pipe',
        timeout: 30000,
    });
    logger.debug({ name }, 'udocker container created with F1 mode');
}
/**
 * Post-run container cleanup. For udocker: remove named container.
 * No-op for Docker/Podman (--rm handles it).
 */
export function cleanupContainer(name) {
    const rt = getRuntime();
    if (rt.kind !== 'udocker')
        return;
    try {
        execSync(`${rt.bin} rm ${name}`, { stdio: 'pipe', timeout: 10000 });
        logger.debug({ name }, 'udocker container removed');
    }
    catch {
        logger.warn({ name }, 'Failed to remove udocker container');
    }
}
/** Get the hostname containers use to reach the host. */
export function getHostGateway() {
    return getRuntime().hostGateway;
}
/**
 * Address the credential proxy binds to.
 * Docker/Podman on Linux: bridge interface IP.
 * Docker Desktop (macOS/WSL): 127.0.0.1.
 * udocker: 127.0.0.1 (no network isolation).
 */
export function getProxyBindHost() {
    return detectProxyBindHost(getRuntime());
}
// ---------------------------------------------------------------------------
// Runtime-aware utility functions
// ---------------------------------------------------------------------------
/** CLI args for the container to resolve the host gateway. */
export function hostGatewayArgs() {
    const rt = cachedRuntime;
    if (!rt) {
        // Legacy fallback before initRuntime() is called
        if (os.platform() === 'linux') {
            return ['--add-host=host.docker.internal:host-gateway'];
        }
        return [];
    }
    if (!rt.capabilities.supportsAddHost)
        return [];
    if (rt.kind === 'docker' && os.platform() === 'linux') {
        return ['--add-host=host.docker.internal:host-gateway'];
    }
    if (rt.kind === 'podman' && os.platform() === 'linux') {
        return ['--add-host=host.containers.internal:host-gateway'];
    }
    return [];
}
/** Returns CLI args for a readonly bind mount (with SELinux :z if needed). */
export function readonlyMountArgs(hostPath, containerPath) {
    const rt = cachedRuntime;
    const suffix = rt?.selinux ? ':ro,z' : ':ro';
    return ['-v', `${hostPath}:${containerPath}${suffix}`];
}
/** Returns CLI args for a writable bind mount (with SELinux :z if needed). */
export function writableMountArgs(hostPath, containerPath) {
    const rt = cachedRuntime;
    const suffix = rt?.selinux ? ':z' : '';
    return ['-v', `${hostPath}:${containerPath}${suffix}`];
}
/** Returns the shell command to stop a container by name. */
export function stopContainer(name) {
    const bin = cachedRuntime?.bin ?? 'docker';
    return `${bin} stop ${name}`;
}
/** Ensure the container runtime is reachable. */
export function ensureContainerRuntimeRunning() {
    const rt = getRuntime();
    if (rt.kind === 'udocker') {
        // udocker has no daemon — just verify the binary works
        try {
            execSync(`${rt.bin} version`, { stdio: 'pipe', timeout: 10000 });
            logger.debug('udocker is available');
        }
        catch (err) {
            logger.error({ err }, 'udocker not functional');
            throw new Error('Container runtime (udocker) is not functional');
        }
        return;
    }
    try {
        execSync(`${rt.bin} info`, { stdio: 'pipe', timeout: 10000 });
        logger.debug('Container runtime already running');
    }
    catch (err) {
        logger.error({ err }, 'Failed to reach container runtime');
        console.error('\n\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
        console.error(`\u2551  FATAL: ${rt.kind} failed to start                                ${rt.kind === 'docker' ? '  ' : ''}\u2551`);
        console.error('\u2551                                                                \u2551');
        console.error(`\u2551  Run: ${rt.bin} info                                             ${' '.repeat(Math.max(0, 6 - rt.bin.length))}\u2551`);
        console.error('\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d\n');
        throw new Error('Container runtime is required but failed to start');
    }
}
/** Kill orphaned AerArt containers from previous runs. */
export function cleanupOrphans() {
    const rt = getRuntime();
    if (!rt.capabilities.supportsPsFilter) {
        logger.debug({ runtime: rt.kind }, 'Runtime does not support ps --filter, skipping orphan cleanup');
        return;
    }
    try {
        const output = execSync(`${rt.bin} ps --filter name=aer-art- --format '{{.Names}}'`, { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' });
        const orphans = output.trim().split('\n').filter(Boolean);
        for (const name of orphans) {
            try {
                execSync(stopContainer(name), { stdio: 'pipe' });
            }
            catch {
                /* already stopped */
            }
        }
        if (orphans.length > 0) {
            logger.info({ count: orphans.length, names: orphans }, 'Stopped orphaned containers');
        }
    }
    catch (err) {
        logger.warn({ err }, 'Failed to clean up orphaned containers');
    }
}
/** Clean up containers for a specific run ID (label-based). */
export function cleanupRunContainers(runId) {
    const rt = getRuntime();
    if (!rt.capabilities.supportsPsFilter)
        return;
    try {
        const output = execSync(`${rt.bin} ps --filter label=art-run-id=${runId} --format '{{.Names}}'`, { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' });
        const containers = output.trim().split('\n').filter(Boolean);
        for (const name of containers) {
            try {
                execSync(stopContainer(name), { stdio: 'pipe' });
            }
            catch {
                /* already stopped */
            }
        }
        if (containers.length > 0) {
            logger.info({ count: containers.length, runId }, 'Cleaned up orphaned run containers');
        }
    }
    catch (err) {
        logger.warn({ err, runId }, 'Failed to clean up run containers');
    }
}
// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
/** Reset cached runtime (for tests only). */
export function _resetRuntime() {
    cachedRuntime = null;
}
/** Set cached runtime directly (for tests only). */
export function _setRuntime(rt) {
    cachedRuntime = rt;
}
//# sourceMappingURL=container-runtime.js.map