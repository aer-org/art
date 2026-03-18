import { AdditionalMount, MountAllowlist } from './types.js';
/**
 * Load the mount allowlist from the external config location.
 * Returns null if the file doesn't exist or is invalid.
 * Result is cached in memory for the lifetime of the process.
 */
export declare function loadMountAllowlist(): MountAllowlist | null;
export interface MountValidationResult {
    allowed: boolean;
    reason: string;
    realHostPath?: string;
    resolvedContainerPath?: string;
    effectiveReadonly?: boolean;
}
/**
 * Validate a single additional mount against the allowlist.
 * Returns validation result with reason.
 */
export declare function validateMount(mount: AdditionalMount, isMain: boolean): MountValidationResult;
/**
 * Validate all additional mounts for a group.
 * Returns array of validated mounts (only those that passed validation).
 * Logs warnings for rejected mounts.
 */
export declare function validateAdditionalMounts(mounts: AdditionalMount[], groupName: string, isMain: boolean): Array<{
    hostPath: string;
    containerPath: string;
    readonly: boolean;
}>;
/**
 * Generate a template allowlist file for users to customize
 */
export declare function generateAllowlistTemplate(): string;
//# sourceMappingURL=mount-security.d.ts.map