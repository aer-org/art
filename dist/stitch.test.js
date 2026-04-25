import { describe, it, expect, vi } from 'vitest';
vi.mock('./logger.js', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));
import { assertConfigAcyclic, assertNoNameCollision, barrierNameFor, renamedStage, stitchParallel, stitchSingle, } from './stitch.js';
/* Helpers */
function baseConfig() {
    return {
        stages: [
            {
                name: 'start',
                mounts: {},
                transitions: [{ marker: 'OK', next: 'review' }],
            },
            {
                name: 'review',
                mounts: {},
                transitions: [
                    { marker: 'STAGE_KEEP', template: 'continue-tpl' },
                    { marker: 'STAGE_RESET', template: 'revert-tpl' },
                ],
            },
            {
                name: 'finalize',
                mounts: {},
                transitions: [{ marker: 'OK', next: null }],
            },
        ],
        entryStage: 'start',
    };
}
function revertTemplate() {
    return {
        name: 'revert-tpl',
        entry: 'checkout',
        stages: [
            {
                name: 'checkout',
                mounts: {},
                transitions: [{ marker: 'OK', next: 'rebuild' }],
            },
            {
                name: 'rebuild',
                mounts: {},
                transitions: [{ marker: 'OK', next: null }],
            },
        ],
    };
}
function substTemplate() {
    return {
        name: 'subst-tpl',
        entry: 's',
        stages: [
            {
                name: 's',
                mounts: { 'scope-{{insertId}}': 'rw' },
                prompt: 'hello {{insertId}} idx={{index}}',
                env: { SCOPE: '{{insertId}}', IDX: '{{index}}' },
                transitions: [{ marker: 'OK', next: null }],
            },
        ],
    };
}
describe('stitchSingle', () => {
    it('inserts a template and rewires the host transition', () => {
        const config = baseConfig();
        const tpl = revertTemplate();
        const result = stitchSingle({
            config,
            originStage: 'review',
            originTransitionIdx: 1, // STAGE_RESET
            template: tpl,
        });
        expect(result.entryName).toBe('review__revert-tpl0__checkout');
        const review = result.updatedConfig.stages.find((s) => s.name === 'review');
        expect(review.transitions[1].next).toBe('review__revert-tpl0__checkout');
        // Host transition's `template` is cleared after stitching (consumed).
        expect(review.transitions[1].template).toBeUndefined();
        // untouched transitions preserved
        expect(review.transitions[0].template).toBe('continue-tpl');
        // inserted stages appended
        const stageNames = result.updatedConfig.stages.map((s) => s.name);
        expect(stageNames).toContain('review__revert-tpl0__checkout');
        expect(stageNames).toContain('review__revert-tpl0__rebuild');
    });
    it('rewrites template-internal transitions to renamed names', () => {
        const config = baseConfig();
        const tpl = revertTemplate();
        const result = stitchSingle({
            config,
            originStage: 'review',
            originTransitionIdx: 1,
            template: tpl,
        });
        const checkout = result.updatedConfig.stages.find((s) => s.name === 'review__revert-tpl0__checkout');
        expect(checkout.transitions[0].next).toBe('review__revert-tpl0__rebuild');
        const rebuild = result.updatedConfig.stages.find((s) => s.name === 'review__revert-tpl0__rebuild');
        // null-next stays null in single stitch (Option 1: template terminates)
        expect(rebuild.transitions[0].next).toBeNull();
    });
    it('applies substitutions to allowed fields', () => {
        const tpl = substTemplate();
        const result = stitchSingle({
            config: baseConfig(),
            originStage: 'review',
            originTransitionIdx: 1,
            template: tpl,
            substitutions: { custom: 'hi' },
        });
        const s = result.updatedConfig.stages.find((st) => st.name === 'review__subst-tpl0__s');
        expect(s.prompt).toBe('hello review__subst-tpl0 idx=0');
        expect(s.env).toEqual({ SCOPE: 'review__subst-tpl0', IDX: '0' });
        expect(s.mounts).toHaveProperty('scope-review__subst-tpl0', 'rw');
    });
    it('applies substitutions inside transition fields', () => {
        const tpl = {
            name: 'trans-subst',
            entry: 'a',
            stages: [
                {
                    name: 'a',
                    mounts: {},
                    transitions: [
                        {
                            marker: 'OK',
                            next: null,
                            prompt: 'done for {{id}} ({{kind}})',
                        },
                    ],
                },
            ],
        };
        const result = stitchSingle({
            config: baseConfig(),
            originStage: 'review',
            originTransitionIdx: 1,
            template: tpl,
            substitutions: { id: 'foo', kind: 'stimulus' },
        });
        const a = result.updatedConfig.stages.find((s) => s.name === 'review__trans-subst0__a');
        expect(a.transitions[0].prompt).toBe('done for foo (stimulus)');
    });
    it('drops count field from the host transition', () => {
        const config = baseConfig();
        config.stages[1].transitions[1].count = 3;
        const result = stitchSingle({
            config,
            originStage: 'review',
            originTransitionIdx: 1,
            template: revertTemplate(),
        });
        const review = result.updatedConfig.stages.find((s) => s.name === 'review');
        expect(review.transitions[1].count).toBeUndefined();
    });
    it('throws on unknown origin stage', () => {
        expect(() => stitchSingle({
            config: baseConfig(),
            originStage: 'does-not-exist',
            originTransitionIdx: 0,
            template: revertTemplate(),
        })).toThrow(/not found/);
    });
    it('throws on out-of-range transition idx', () => {
        expect(() => stitchSingle({
            config: baseConfig(),
            originStage: 'review',
            originTransitionIdx: 99,
            template: revertTemplate(),
        })).toThrow(/out of range/);
    });
    it('rejects name collisions', () => {
        const config = baseConfig();
        // Pre-insert a stage with the exact name stitch would generate
        config.stages.push({
            name: 'review__revert-tpl0__checkout',
            mounts: {},
            transitions: [{ marker: 'OK', next: null }],
        });
        expect(() => stitchSingle({
            config,
            originStage: 'review',
            originTransitionIdx: 1,
            template: revertTemplate(),
        })).toThrow(/Duplicate/);
    });
});
describe('stitchParallel', () => {
    it('clones the template N times and synthesizes a barrier', () => {
        const config = baseConfig();
        const tpl = revertTemplate();
        const result = stitchParallel({
            config,
            originStage: 'review',
            originTransitionIdx: 1,
            template: tpl,
            count: 3,
        });
        expect(result.entryNames).toEqual([
            'review__revert-tpl0__checkout',
            'review__revert-tpl1__checkout',
            'review__revert-tpl2__checkout',
        ]);
        expect(result.barrierName).toBe(barrierNameFor('review', 'revert-tpl'));
        const barrier = result.updatedConfig.stages.find((s) => s.name === result.barrierName);
        expect(barrier.fan_in).toBe('all');
        expect(barrier.transitions[0].next).toBeNull();
        expect(barrier.kind).toBe('command');
        expect(barrier.command).toContain('[STAGE_COMPLETE]');
        expect(barrier.successMarker).toBe('[STAGE_COMPLETE]');
        // Host transition becomes multi-target
        const review = result.updatedConfig.stages.find((s) => s.name === 'review');
        expect(review.transitions[1].next).toEqual(result.entryNames);
    });
    it('rewires lane tail (null-next) to barrier', () => {
        const config = baseConfig();
        const tpl = revertTemplate();
        const result = stitchParallel({
            config,
            originStage: 'review',
            originTransitionIdx: 1,
            template: tpl,
            count: 2,
        });
        for (let i = 0; i < 2; i++) {
            const lastStage = result.updatedConfig.stages.find((s) => s.name === `review__revert-tpl${i}__rebuild`);
            expect(lastStage.transitions[0].next).toBe(result.barrierName);
        }
    });
    it('applies per-copy substitutions', () => {
        const tpl = substTemplate();
        const result = stitchParallel({
            config: baseConfig(),
            originStage: 'review',
            originTransitionIdx: 1,
            template: tpl,
            count: 2,
            perCopySubstitutions: [{ label: 'A' }, { label: 'B' }],
        });
        const s0 = result.updatedConfig.stages.find((st) => st.name === 'review__subst-tpl0__s');
        const s1 = result.updatedConfig.stages.find((st) => st.name === 'review__subst-tpl1__s');
        expect(s0.prompt).toContain('idx=0');
        expect(s1.prompt).toContain('idx=1');
        expect(s0.env?.SCOPE).toBe('review__subst-tpl0');
        expect(s1.env?.SCOPE).toBe('review__subst-tpl1');
    });
    it('rejects count=0', () => {
        expect(() => stitchParallel({
            config: baseConfig(),
            originStage: 'review',
            originTransitionIdx: 1,
            template: revertTemplate(),
            count: 0,
        })).toThrow(/positive integer/);
    });
    it('accepts count=1 (single via parallel path)', () => {
        const result = stitchParallel({
            config: baseConfig(),
            originStage: 'review',
            originTransitionIdx: 1,
            template: revertTemplate(),
            count: 1,
        });
        expect(result.entryNames).toEqual(['review__revert-tpl0__checkout']);
        expect(result.updatedConfig.stages.find((s) => s.name === result.barrierName)).toBeTruthy();
    });
});
describe('assertConfigAcyclic', () => {
    it('accepts a DAG', () => {
        expect(() => assertConfigAcyclic(baseConfig())).not.toThrow();
    });
    it('detects a cycle', () => {
        const cfg = {
            stages: [
                { name: 'a', mounts: {}, transitions: [{ marker: 'x', next: 'b' }] },
                { name: 'b', mounts: {}, transitions: [{ marker: 'x', next: 'a' }] },
            ],
        };
        expect(() => assertConfigAcyclic(cfg)).toThrow(/Cycle/);
    });
    it('detects self-loop', () => {
        const cfg = {
            stages: [
                { name: 'a', mounts: {}, transitions: [{ marker: 'x', next: 'a' }] },
            ],
        };
        expect(() => assertConfigAcyclic(cfg)).toThrow(/Cycle/);
    });
});
describe('assertNoNameCollision', () => {
    it('accepts unique names', () => {
        expect(() => assertNoNameCollision(baseConfig())).not.toThrow();
    });
    it('flags duplicates', () => {
        const cfg = {
            stages: [
                { name: 'a', mounts: {}, transitions: [] },
                { name: 'a', mounts: {}, transitions: [] },
            ],
        };
        expect(() => assertNoNameCollision(cfg)).toThrow(/Duplicate/);
    });
});
describe('renamedStage', () => {
    it('composes origin, template name, index, and stage name', () => {
        expect(renamedStage('review', 'revert-tpl', 2, 'checkout')).toBe('review__revert-tpl2__checkout');
    });
});
describe('unresolved placeholder detection', () => {
    it('throws when a template uses a placeholder not in the subs map', () => {
        const tpl = {
            name: 'typo-tpl',
            entry: 'a',
            stages: [
                {
                    name: 'a',
                    prompt: 'handle {{id}} of {{tpye}}', // "tpye" typo — not provided
                    mounts: {},
                    transitions: [{ marker: 'OK', next: null }],
                },
            ],
        };
        expect(() => stitchSingle({
            config: baseConfig(),
            originStage: 'review',
            originTransitionIdx: 1,
            template: tpl,
            substitutions: { id: 'alpha' },
        })).toThrow(/Unresolved placeholder.*\{\{tpye\}\}.*field "prompt"/);
    });
    it('throws when a placeholder is in a mount key', () => {
        const tpl = {
            name: 'mount-tpl',
            entry: 'a',
            stages: [
                {
                    name: 'a',
                    mounts: { 'scope-{{missing}}': 'rw' },
                    transitions: [{ marker: 'OK', next: null }],
                },
            ],
        };
        expect(() => stitchSingle({
            config: baseConfig(),
            originStage: 'review',
            originTransitionIdx: 1,
            template: tpl,
        })).toThrow(/Unresolved placeholder.*\{\{missing\}\}.*field "mounts"/);
    });
    it('throws when a placeholder is in a transition prompt', () => {
        const tpl = {
            name: 'trans-tpl',
            entry: 'a',
            stages: [
                {
                    name: 'a',
                    mounts: {},
                    transitions: [
                        {
                            marker: 'OK',
                            next: null,
                            prompt: 'done for {{kind}}',
                        },
                    ],
                },
            ],
        };
        expect(() => stitchSingle({
            config: baseConfig(),
            originStage: 'review',
            originTransitionIdx: 1,
            template: tpl,
            substitutions: { id: 'alpha' }, // kind missing
        })).toThrow(/Unresolved placeholder.*\{\{kind\}\}.*field "transitions"/);
    });
    it('throws at stitchParallel time too (lane with missing key)', () => {
        const tpl = {
            name: 'par-tpl',
            entry: 'a',
            stages: [
                {
                    name: 'a',
                    prompt: 'lane for {{id}} kind={{kind}}',
                    mounts: {},
                    transitions: [{ marker: 'OK', next: null }],
                },
            ],
        };
        expect(() => stitchParallel({
            config: baseConfig(),
            originStage: 'review',
            originTransitionIdx: 1,
            template: tpl,
            count: 2,
            perCopySubstitutions: [
                { id: 'alpha', kind: 'fast' },
                { id: 'beta' }, // missing kind
            ],
        })).toThrow(/Unresolved placeholder.*\{\{kind\}\}/);
    });
    it('does not throw when every placeholder is satisfied', () => {
        const tpl = {
            name: 'ok-tpl',
            entry: 'a',
            stages: [
                {
                    name: 'a',
                    prompt: '{{id}} / {{insertId}} / {{index}}',
                    mounts: { '{{id}}-dir': 'rw' },
                    transitions: [{ marker: 'OK', next: null, prompt: 'for {{id}}' }],
                },
            ],
        };
        expect(() => stitchSingle({
            config: baseConfig(),
            originStage: 'review',
            originTransitionIdx: 1,
            template: tpl,
            substitutions: { id: 'alpha' },
        })).not.toThrow();
    });
});
//# sourceMappingURL=stitch.test.js.map