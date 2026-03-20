import { describe, it, expect } from 'vitest';
import { validateProjectMounts } from './mount-validation.js';
describe('validateProjectMounts', () => {
    it('returns valid for no project:* entries', () => {
        const result = validateProjectMounts({ project: 'ro', src: 'rw' });
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });
    it('allows sub-entries when root is enabled', () => {
        const result = validateProjectMounts({
            project: 'ro',
            'project:docs': 'rw',
            'project:scripts': null,
        });
        expect(result.valid).toBe(true);
    });
    it('errors when root is disabled but sub-entry is enabled', () => {
        const result = validateProjectMounts({
            project: null,
            'project:docs': 'rw',
        });
        expect(result.valid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('project:docs');
    });
    it('errors when parent is disabled but child is enabled', () => {
        const result = validateProjectMounts({
            project: 'ro',
            'project:src': null,
            'project:src/lib': 'rw',
        });
        expect(result.valid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('project:src/lib');
        expect(result.errors[0]).toContain('project:src');
    });
    it('allows disabling sub-entries when root is enabled', () => {
        const result = validateProjectMounts({
            project: 'rw',
            'project:secrets': null,
            'project:vendor': null,
        });
        expect(result.valid).toBe(true);
    });
    it('allows same permission as root (no-op but valid)', () => {
        const result = validateProjectMounts({
            project: 'ro',
            'project:docs': 'ro',
        });
        expect(result.valid).toBe(true);
    });
    it('errors for multiple violations', () => {
        const result = validateProjectMounts({
            project: null,
            'project:a': 'rw',
            'project:b': 'ro',
        });
        expect(result.valid).toBe(false);
        expect(result.errors).toHaveLength(2);
    });
    it('handles deeply nested paths', () => {
        const result = validateProjectMounts({
            project: 'ro',
            'project:a': null,
            'project:a/b/c/d': 'rw',
        });
        expect(result.valid).toBe(false);
        expect(result.errors[0]).toContain('project:a/b/c/d');
    });
});
//# sourceMappingURL=mount-validation.test.js.map