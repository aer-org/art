export const STITCH_SUBSTITUTION_FIELDS = [
    'prompt',
    'prompts',
    'prompt_append',
    'mounts',
    'hostMounts',
    'env',
    'image',
    'command',
    'successMarker',
    'errorMarker',
    'transitions',
];
// Reserved substitution keys that callers may not include in per-copy
// substitution maps — they are injected by stitch core and must not be
// overridden by payload-provided data.
export const RESERVED_SUBSTITUTION_KEYS = ['index', 'insertId'];
const SUBSTITUTION_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const BARRIER_MARKER = 'STAGE_COMPLETE';
const BARRIER_PROMPT = `You are a parallel-stitch barrier stage. All predecessor lanes have completed. Emit exactly [${BARRIER_MARKER}] and nothing else.`;
/* ----- Name helpers ----- */
export function renamedStage(origin, templateName, copyIndex, stageName) {
    return `${origin}__${templateName}${copyIndex}__${stageName}`;
}
export function barrierNameFor(origin, templateName) {
    return `${origin}__${templateName}__barrier`;
}
function insertIdFor(origin, templateName, copyIndex) {
    return copyIndex === undefined
        ? `${origin}__${templateName}`
        : `${origin}__${templateName}${copyIndex}`;
}
/* ----- Public API ----- */
export function stitchSingle(input) {
    const { config, originStage, originTransitionIdx, template } = input;
    assertOriginValid(config, originStage, originTransitionIdx);
    const copyIndex = 0;
    const insertId = insertIdFor(originStage, template.name, copyIndex);
    const subs = {
        insertId,
        index: copyIndex,
        ...(input.substitutions ?? {}),
    };
    const clonedStages = cloneTemplateCopy(template, originStage, copyIndex, subs);
    const entryName = renamedStage(originStage, template.name, copyIndex, template.entry);
    const updatedConfig = applyStitchToConfig(config, originStage, originTransitionIdx, clonedStages, entryName);
    assertNoNameCollision(updatedConfig);
    assertConfigAcyclic(updatedConfig);
    return { updatedConfig, insertedStages: clonedStages, entryName, insertId };
}
export function stitchParallel(input) {
    const { config, originStage, originTransitionIdx, template, count, perCopySubstitutions, } = input;
    if (!Number.isInteger(count) || count < 1) {
        throw new Error(`stitchParallel: count must be a positive integer, got ${count}`);
    }
    assertOriginValid(config, originStage, originTransitionIdx);
    const barrier = barrierNameFor(originStage, template.name);
    const aggregateInsertId = insertIdFor(originStage, template.name);
    const allStages = [];
    const entryNames = [];
    for (let i = 0; i < count; i++) {
        const copySubs = perCopySubstitutions?.[i] ?? {};
        const subs = {
            insertId: insertIdFor(originStage, template.name, i),
            index: i,
            ...copySubs,
        };
        const cloned = cloneTemplateCopy(template, originStage, i, subs, barrier);
        allStages.push(...cloned);
        entryNames.push(renamedStage(originStage, template.name, i, template.entry));
    }
    allStages.push(buildBarrierStage(barrier));
    const updatedConfig = applyStitchToConfig(config, originStage, originTransitionIdx, allStages, entryNames);
    assertNoNameCollision(updatedConfig);
    assertConfigAcyclic(updatedConfig);
    return {
        updatedConfig,
        insertedStages: allStages,
        entryNames,
        barrierName: barrier,
        insertId: aggregateInsertId,
    };
}
/* ----- Validators (exported for stitch-time checks and tests) ----- */
export function assertConfigAcyclic(config) {
    const stageNames = new Set(config.stages.map((s) => s.name));
    const adj = new Map();
    for (const s of config.stages) {
        const out = new Set();
        for (const t of s.transitions) {
            for (const target of transitionTargets(t)) {
                if (stageNames.has(target))
                    out.add(target);
            }
        }
        adj.set(s.name, out);
    }
    const UNVISITED = 0;
    const ON_STACK = 1;
    const DONE = 2;
    const state = new Map();
    for (const s of config.stages)
        state.set(s.name, UNVISITED);
    const dfs = (node, stack) => {
        state.set(node, ON_STACK);
        stack.push(node);
        for (const nxt of adj.get(node) ?? []) {
            const c = state.get(nxt);
            if (c === ON_STACK) {
                const from = stack.indexOf(nxt);
                const cyclePath = [...stack.slice(from), nxt].join(' → ');
                throw new Error(`Cycle detected in pipeline config: ${cyclePath}`);
            }
            if (c === UNVISITED)
                dfs(nxt, stack);
        }
        stack.pop();
        state.set(node, DONE);
    };
    for (const s of config.stages) {
        if (state.get(s.name) === UNVISITED)
            dfs(s.name, []);
    }
}
export function assertNoNameCollision(config) {
    const seen = new Set();
    for (const s of config.stages) {
        if (seen.has(s.name)) {
            throw new Error(`Duplicate stage name after stitch: "${s.name}"`);
        }
        seen.add(s.name);
    }
}
/* ----- Internals ----- */
function assertOriginValid(config, originStage, originTransitionIdx) {
    const origin = config.stages.find((s) => s.name === originStage);
    if (!origin) {
        throw new Error(`Origin stage "${originStage}" not found in config`);
    }
    if (originTransitionIdx < 0 ||
        originTransitionIdx >= origin.transitions.length) {
        throw new Error(`Origin transition index ${originTransitionIdx} out of range for stage "${originStage}" (has ${origin.transitions.length} transitions)`);
    }
}
function transitionTargets(t) {
    if (t.next == null)
        return [];
    return Array.isArray(t.next) ? t.next : [t.next];
}
function cloneTemplateCopy(template, origin, copyIndex, subs, convergenceTarget) {
    const rename = (n) => renamedStage(origin, template.name, copyIndex, n);
    return template.stages.map((stage) => {
        const renamed = {
            ...stage,
            name: rename(stage.name),
            transitions: stage.transitions.map((t) => rewireTransition(t, rename, convergenceTarget)),
        };
        const substituted = applySubstitutionsToStage(renamed, subs);
        assertNoUnresolvedPlaceholders(substituted, origin, template.name);
        return substituted;
    });
}
/**
 * After substitution runs, any remaining `{{X}}` in a substitution-eligible
 * field means the template referenced a placeholder the substitution map
 * didn't provide — either a template-author typo or a payload missing the
 * expected key. Fail at stitch time with a descriptive message instead of
 * letting the literal placeholder reach the agent's prompt.
 */
function assertNoUnresolvedPlaceholders(stage, origin, templateName) {
    for (const field of STITCH_SUBSTITUTION_FIELDS) {
        const value = stage[field];
        if (value === undefined)
            continue;
        const unresolved = collectPlaceholders(value);
        if (unresolved.size > 0) {
            const keys = [...unresolved].map((k) => `{{${k}}}`).join(', ');
            throw new Error(`Unresolved placeholder(s) ${keys} in stitched stage "${stage.name}" field "${field}" (origin: "${origin}", template: "${templateName}"). The substitution map did not provide values for these keys.`);
        }
    }
}
function collectPlaceholders(value) {
    const found = new Set();
    walkPlaceholders(value, found);
    return found;
}
function walkPlaceholders(value, acc) {
    if (typeof value === 'string') {
        for (const m of value.matchAll(SUBSTITUTION_PATTERN)) {
            acc.add(m[1]);
        }
        return;
    }
    if (Array.isArray(value)) {
        for (const v of value)
            walkPlaceholders(v, acc);
        return;
    }
    if (value !== null && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            walkPlaceholders(k, acc);
            walkPlaceholders(v, acc);
        }
    }
}
function rewireTransition(t, rename, convergenceTarget) {
    // Only called while cloning template stages. Templates reject authored
    // array `next` at load, and barrier fan-out arrays are injected by
    // applyStitchToConfig — neither ever reaches this function. The template
    // validator also guarantees any string `next` is template-internal.
    const out = { ...t };
    if (typeof t.next === 'string') {
        out.next = rename(t.next);
    }
    else {
        // t.next is null/undefined — convergence target (parallel) or terminal
        out.next = convergenceTarget ?? null;
    }
    // `template` passes through unchanged — resolved at runtime when the
    // stitched stage fires its transition.
    return out;
}
function applyStitchToConfig(config, originStage, originTransitionIdx, newStages, newHostNext) {
    const updatedStages = config.stages.map((s) => {
        if (s.name !== originStage)
            return s;
        const transitions = s.transitions.map((t, idx) => {
            if (idx !== originTransitionIdx)
                return t;
            const copy = { ...t, next: newHostNext };
            delete copy.count; // count is consumed by the stitch
            delete copy.template; // template has been stitched — next now points at entry/barrier stages
            return copy;
        });
        return { ...s, transitions };
    });
    return { ...config, stages: [...updatedStages, ...newStages] };
}
function applySubstitutionsToStage(stage, subs) {
    const out = { ...stage };
    const rec = out;
    for (const field of STITCH_SUBSTITUTION_FIELDS) {
        if (!(field in rec))
            continue;
        rec[field] = substituteValue(rec[field], subs);
    }
    return out;
}
function substituteValue(value, subs) {
    if (typeof value === 'string')
        return substituteString(value, subs);
    if (Array.isArray(value))
        return value.map((v) => substituteValue(v, subs));
    if (value !== null && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            const newKey = substituteString(k, subs);
            out[newKey] = substituteValue(v, subs);
        }
        return out;
    }
    return value;
}
function substituteString(text, subs) {
    return text.replace(SUBSTITUTION_PATTERN, (match, key) => {
        if (!(key in subs))
            return match;
        return String(subs[key]);
    });
}
function buildBarrierStage(name) {
    // Synthetic barrier runs as a trivial agent stage — it waits on fan_in: "all"
    // and its only job is to emit STAGE_COMPLETE once every lane has reported.
    // Using agent-mode avoids requiring any particular image to be pulled.
    return {
        name,
        prompt: BARRIER_PROMPT,
        mounts: {},
        fan_in: 'all',
        transitions: [{ marker: BARRIER_MARKER, next: null }],
    };
}
//# sourceMappingURL=stitch.js.map