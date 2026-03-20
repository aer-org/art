/**
 * Validation for project mount tree permissions.
 * Pure function — shared between frontend and backend.
 */
export function validateProjectMounts(mounts) {
    const errors = [];
    // Collect project root and all project:* entries
    const rootPolicy = mounts['project'];
    const subEntries = [];
    for (const [key, policy] of Object.entries(mounts)) {
        if (key.startsWith('project:')) {
            subEntries.push({ path: key.slice('project:'.length), policy });
        }
    }
    // If no sub-entries, nothing to validate
    if (subEntries.length === 0)
        return { valid: true, errors: [] };
    // Rule: if project root is disabled, no sub-entry can be enabled
    if (rootPolicy === null) {
        for (const entry of subEntries) {
            if (entry.policy === 'ro' || entry.policy === 'rw') {
                errors.push(`Cannot enable "project:${entry.path}" when project root is disabled`);
            }
        }
    }
    // Rule: if a parent path is disabled, children cannot be enabled
    for (const entry of subEntries) {
        if (entry.policy !== 'ro' && entry.policy !== 'rw')
            continue;
        // Walk up from this path checking ancestors
        const parts = entry.path.split('/');
        for (let i = 1; i < parts.length; i++) {
            const ancestorPath = parts.slice(0, i).join('/');
            const ancestorKey = `project:${ancestorPath}`;
            if (mounts[ancestorKey] === null) {
                errors.push(`Cannot enable "project:${entry.path}" when "project:${ancestorPath}" is disabled`);
                break;
            }
        }
    }
    return { valid: errors.length === 0, errors };
}
//# sourceMappingURL=mount-validation.js.map