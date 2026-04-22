import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
vi.mock('./logger.js', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));
import { loadPipelineTemplate, resolveTemplatePath, validatePipelineTemplate, } from './pipeline-template.js';
const tmpRoots = [];
function makeTmpGroupDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-template-test-'));
    tmpRoots.push(dir);
    fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
    return dir;
}
function writeTemplate(groupDir, name, body) {
    fs.writeFileSync(path.join(groupDir, 'templates', `${name}.json`), JSON.stringify(body));
}
afterEach(() => {
    while (tmpRoots.length) {
        fs.rmSync(tmpRoots.pop(), { recursive: true, force: true });
    }
});
describe('resolveTemplatePath', () => {
    it('rejects names with path traversal', () => {
        expect(() => resolveTemplatePath('/tmp/group', '../evil')).toThrow(/match/);
    });
    it('rejects absolute-like names', () => {
        expect(() => resolveTemplatePath('/tmp/group', '/etc/passwd')).toThrow(/match/);
    });
    it('rejects names with slashes', () => {
        expect(() => resolveTemplatePath('/tmp/group', 'sub/name')).toThrow(/match/);
    });
    it('resolves a simple name', () => {
        const p = resolveTemplatePath('/tmp/group', 'revert');
        expect(p).toBe('/tmp/group/templates/revert.json');
    });
});
describe('validatePipelineTemplate', () => {
    it('accepts a minimal valid template', () => {
        const t = validatePipelineTemplate({
            stages: [
                {
                    name: 's1',
                    mounts: {},
                    transitions: [{ marker: 'OK', next: null }],
                },
            ],
        }, 'tpl');
        expect(t.entry).toBe('s1');
        expect(t.stages).toHaveLength(1);
    });
    it('defaults entry to first stage', () => {
        const t = validatePipelineTemplate({
            stages: [
                { name: 'a', mounts: {}, transitions: [{ marker: 'OK', next: 'b' }] },
                { name: 'b', mounts: {}, transitions: [{ marker: 'OK', next: null }] },
            ],
        }, 'tpl');
        expect(t.entry).toBe('a');
    });
    it('honors explicit entry', () => {
        const t = validatePipelineTemplate({
            entry: 'b',
            stages: [
                { name: 'a', mounts: {}, transitions: [{ marker: 'OK', next: null }] },
                { name: 'b', mounts: {}, transitions: [{ marker: 'OK', next: null }] },
            ],
        }, 'tpl');
        expect(t.entry).toBe('b');
    });
    it('rejects non-object root', () => {
        expect(() => validatePipelineTemplate(null, 'tpl')).toThrow(/object/);
        expect(() => validatePipelineTemplate([], 'tpl')).toThrow(/object/);
        expect(() => validatePipelineTemplate('string', 'tpl')).toThrow(/object/);
    });
    it('rejects empty stages', () => {
        expect(() => validatePipelineTemplate({ stages: [] }, 'tpl')).toThrow(/non-empty array/);
    });
    it('rejects duplicate stage names', () => {
        expect(() => validatePipelineTemplate({
            stages: [
                {
                    name: 'x',
                    mounts: {},
                    transitions: [{ marker: 'OK', next: null }],
                },
                {
                    name: 'x',
                    mounts: {},
                    transitions: [{ marker: 'OK', next: null }],
                },
            ],
        }, 'tpl')).toThrow(/duplicate/);
    });
    it('rejects unknown entry', () => {
        expect(() => validatePipelineTemplate({
            entry: 'nope',
            stages: [
                {
                    name: 's1',
                    mounts: {},
                    transitions: [{ marker: 'OK', next: null }],
                },
            ],
        }, 'tpl')).toThrow(/unknown stage/);
    });
    it('rejects authored array next', () => {
        expect(() => validatePipelineTemplate({
            stages: [
                {
                    name: 's1',
                    mounts: {},
                    transitions: [{ marker: 'OK', next: ['a', 'b'] }],
                },
            ],
        }, 'tpl')).toThrow(/string or null/);
    });
    it('rejects retry field', () => {
        expect(() => validatePipelineTemplate({
            stages: [
                {
                    name: 's1',
                    mounts: {},
                    transitions: [{ marker: 'OK', retry: true }],
                },
            ],
        }, 'tpl')).toThrow(/retry/);
    });
    it('rejects next_dynamic', () => {
        expect(() => validatePipelineTemplate({
            stages: [
                {
                    name: 's1',
                    mounts: {},
                    transitions: [
                        { marker: 'OK', next_dynamic: true, next: ['x'] },
                    ],
                },
            ],
        }, 'tpl')).toThrow(/next_dynamic/);
    });
    it('rejects fan_in dynamic', () => {
        expect(() => validatePipelineTemplate({
            stages: [
                {
                    name: 's1',
                    mounts: {},
                    fan_in: 'dynamic',
                    transitions: [{ marker: 'OK', next: null }],
                },
            ],
        }, 'tpl')).toThrow(/fan_in/);
    });
    it('rejects dynamic-fanout kind', () => {
        expect(() => validatePipelineTemplate({
            stages: [
                {
                    name: 's1',
                    kind: 'dynamic-fanout',
                    mounts: {},
                    transitions: [{ marker: 'OK', next: null }],
                },
            ],
        }, 'tpl')).toThrow(/invalid kind/);
    });
    it('rejects non-positive count', () => {
        expect(() => validatePipelineTemplate({
            stages: [
                {
                    name: 's1',
                    mounts: {},
                    transitions: [{ marker: 'OK', next: 'tpl2', count: 0 }],
                },
            ],
        }, 'tpl')).toThrow(/positive integer/);
    });
    it('accepts positive integer count', () => {
        expect(() => validatePipelineTemplate({
            stages: [
                {
                    name: 's1',
                    mounts: {},
                    transitions: [{ marker: 'OK', next: 'tpl2', count: 3 }],
                },
            ],
        }, 'tpl')).not.toThrow();
    });
    it('detects internal cycles', () => {
        expect(() => validatePipelineTemplate({
            stages: [
                { name: 'a', mounts: {}, transitions: [{ marker: 'x', next: 'b' }] },
                { name: 'b', mounts: {}, transitions: [{ marker: 'x', next: 'a' }] },
            ],
        }, 'tpl')).toThrow(/cycle/);
    });
    it('detects self-loop', () => {
        expect(() => validatePipelineTemplate({
            stages: [
                { name: 'a', mounts: {}, transitions: [{ marker: 'x', next: 'a' }] },
            ],
        }, 'tpl')).toThrow(/cycle/);
    });
    it('allows forward refs with diamond shape', () => {
        expect(() => validatePipelineTemplate({
            stages: [
                {
                    name: 'a',
                    mounts: {},
                    transitions: [
                        { marker: 'L', next: 'b' },
                        { marker: 'R', next: 'c' },
                    ],
                },
                { name: 'b', mounts: {}, transitions: [{ marker: 'x', next: 'd' }] },
                { name: 'c', mounts: {}, transitions: [{ marker: 'x', next: 'd' }] },
                { name: 'd', mounts: {}, transitions: [{ marker: 'x', next: null }] },
            ],
        }, 'tpl')).not.toThrow();
    });
    it('ignores external refs (deferred to stitch-time)', () => {
        // A template may reference an external target (base pipeline or another
        // template). Validity is checked at stitch-time; template-load must accept.
        expect(() => validatePipelineTemplate({
            stages: [
                {
                    name: 'a',
                    mounts: {},
                    transitions: [{ marker: 'OK', next: 'base-stage' }],
                },
            ],
        }, 'tpl')).not.toThrow();
    });
});
describe('loadPipelineTemplate', () => {
    it('loads a valid template from disk', () => {
        const group = makeTmpGroupDir();
        writeTemplate(group, 'revert', {
            stages: [
                { name: 'r1', mounts: {}, transitions: [{ marker: 'OK', next: null }] },
            ],
        });
        const t = loadPipelineTemplate(group, 'revert');
        expect(t.name).toBe('revert');
        expect(t.entry).toBe('r1');
    });
    it('throws on missing file', () => {
        const group = makeTmpGroupDir();
        expect(() => loadPipelineTemplate(group, 'missing')).toThrow(/not found/);
    });
    it('throws on invalid JSON', () => {
        const group = makeTmpGroupDir();
        fs.writeFileSync(path.join(group, 'templates', 'bad.json'), '{not json');
        expect(() => loadPipelineTemplate(group, 'bad')).toThrow(/invalid JSON/);
    });
    it('throws on schema violation', () => {
        const group = makeTmpGroupDir();
        writeTemplate(group, 'empty', { stages: [] });
        expect(() => loadPipelineTemplate(group, 'empty')).toThrow(/non-empty/);
    });
});
//# sourceMappingURL=pipeline-template.test.js.map