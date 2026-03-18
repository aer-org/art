export type RuntimeKind = 'docker' | 'podman' | 'udocker';
export interface RuntimeCapabilities {
    canBuild: boolean;
    supportsAutoRemove: boolean;
    supportsNaming: boolean;
    supportsAddHost: boolean;
    supportsDevices: boolean;
    supportsDeviceCgroupRule: boolean;
    supportsPsFilter: boolean;
    supportsUser: boolean;
    supportsStdin: boolean;
}
export interface RuntimeConfig {
    kind: RuntimeKind;
    bin: string;
    capabilities: RuntimeCapabilities;
    hostGateway: string;
    bridgeInterface: string | null;
    selinux: boolean;
    rootless: boolean;
}
/**
 * Initialize and return the container runtime config.
 * Resolution order:
 * 1. CONTAINER_RUNTIME env var → use directly without confirmation
 * 2. Saved choice in ~/.config/aer-art/runtime.json
 * 3. Auto-detect + interactive confirmation (first run)
 *
 * Call this once at startup. Subsequent calls return the cached result.
 */
export declare function initRuntime(): Promise<RuntimeConfig>;
/**
 * Get the cached runtime config. Throws if initRuntime() hasn't been called.
 * Use this in synchronous code paths that run after startup.
 */
export declare function getRuntime(): RuntimeConfig;
/** Get runtime capabilities. */
export declare function getRuntimeCapabilities(): RuntimeCapabilities;
/** Get the runtime binary path/name. */
export declare function getRuntimeBin(): string;
/**
 * udocker can't handle slash-heavy registry names (ghcr.io/org/image).
 * Return the short local name (last path segment) for udocker, or the
 * original name for Docker/Podman.
 */
export declare function resolveLocalImageName(image: string): string;
/** Get the hostname containers use to reach the host. */
export declare function getHostGateway(): string;
/**
 * Address the credential proxy binds to.
 * Docker/Podman on Linux: bridge interface IP.
 * Docker Desktop (macOS/WSL): 127.0.0.1.
 * udocker: 127.0.0.1 (no network isolation).
 */
export declare function getProxyBindHost(): string;
/** @deprecated Use getRuntimeBin() */
export declare const CONTAINER_RUNTIME_BIN = "docker";
/** @deprecated Use getHostGateway() */
export declare const CONTAINER_HOST_GATEWAY = "host.docker.internal";
/** @deprecated Use getProxyBindHost() */
export declare const PROXY_BIND_HOST: string;
/** CLI args for the container to resolve the host gateway. */
export declare function hostGatewayArgs(): string[];
/** Returns CLI args for a readonly bind mount (with SELinux :z if needed). */
export declare function readonlyMountArgs(hostPath: string, containerPath: string): string[];
/** Returns CLI args for a writable bind mount (with SELinux :z if needed). */
export declare function writableMountArgs(hostPath: string, containerPath: string): string[];
/** Returns the shell command to stop a container by name. */
export declare function stopContainer(name: string): string;
/** Ensure the container runtime is reachable. */
export declare function ensureContainerRuntimeRunning(): void;
/** Kill orphaned AerArt containers from previous runs. */
export declare function cleanupOrphans(): void;
/** Reset cached runtime (for tests only). */
export declare function _resetRuntime(): void;
/** Set cached runtime directly (for tests only). */
export declare function _setRuntime(rt: RuntimeConfig): void;
//# sourceMappingURL=container-runtime.d.ts.map