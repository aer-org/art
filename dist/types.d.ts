export interface AdditionalMount {
    hostPath: string;
    containerPath?: string;
    readonly?: boolean;
}
/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/aer-art/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
    allowedRoots: AllowedRoot[];
    blockedPatterns: string[];
    nonMainReadOnly: boolean;
}
export interface AllowedRoot {
    path: string;
    allowReadWrite: boolean;
    description?: string;
}
export interface ContainerConfig {
    provider?: 'claude' | 'codex';
    image?: string;
    additionalMounts?: AdditionalMount[];
    additionalDevices?: string[];
    gpu?: boolean;
    runAsRoot?: boolean;
    privileged?: boolean;
    env?: Record<string, string>;
    timeout?: number;
    internalMounts?: Array<{
        hostPath: string;
        containerPath: string;
        readonly: boolean;
    }>;
}
export interface RegisteredGroup {
    name: string;
    folder: string;
    trigger: string;
    added_at: string;
    containerConfig?: ContainerConfig;
    requiresTrigger?: boolean;
    isMain?: boolean;
}
//# sourceMappingURL=types.d.ts.map