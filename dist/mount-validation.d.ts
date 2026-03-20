/**
 * Validation for project mount tree permissions.
 * Pure function — shared between frontend and backend.
 */
export declare function validateProjectMounts(mounts: Record<string, 'ro' | 'rw' | null | undefined>): {
    valid: boolean;
    errors: string[];
};
//# sourceMappingURL=mount-validation.d.ts.map