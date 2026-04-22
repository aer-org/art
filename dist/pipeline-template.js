/**
 * Pipeline template loader & validator.
 *
 * Templates are reusable sub-graphs that get dynamically inserted ("stitched")
 * into the running pipeline when a transition targets a template name. See
 * PLAN_spawn_only_transitions.md for the full model.
 *
 * File layout: <groupDir>/templates/<name>.json
 * File shape:  { entry?: string, stages: PipelineStage[] }
 *
 * Semantics (Option 1 — template owns downstream):
 *   - A template stage with `next: null` terminates the pipeline. There is no
 *     implicit re-wire to a fallback target outside the template.
 *   - `next` is scope-local: it must name a stage inside this template. To
 *     hand control off to another template, use `template: "<name>"` — that
 *     gets stitched at runtime. Cross-template node references are rejected.
 */
import fs from 'fs';
import path from 'path';
const TEMPLATE_DIR_NAME = 'templates';
const TEMPLATE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/**
 * Resolve the absolute path for a template given a groupDir (= __art__ dir).
 * Enforces containment — the resolved path must remain inside the templates
 * dir, rejecting traversal (`..`, absolute names).
 */
export function resolveTemplatePath(groupDir, name) {
    if (!TEMPLATE_NAME_PATTERN.test(name)) {
        throw new Error(`Template name "${name}" must match ${TEMPLATE_NAME_PATTERN}`);
    }
    const dir = path.join(groupDir, TEMPLATE_DIR_NAME);
    const resolved = path.resolve(dir, `${name}.json`);
    const rel = path.relative(dir, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`Template name "${name}" resolves outside templates dir`);
    }
    return resolved;
}
export function loadPipelineTemplate(groupDir, name) {
    const filepath = resolveTemplatePath(groupDir, name);
    if (!fs.existsSync(filepath)) {
        throw new Error(`Template "${name}" not found: ${filepath}`);
    }
    let raw;
    try {
        raw = fs.readFileSync(filepath, 'utf-8');
    }
    catch (err) {
        throw new Error(`Template "${name}": failed to read — ${err.message}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (err) {
        throw new Error(`Template "${name}": invalid JSON — ${err.message}`);
    }
    return validatePipelineTemplate(parsed, name);
}
/**
 * Validate a parsed template object and return a normalized PipelineTemplate.
 * Throws on any schema violation. Pure function — no I/O.
 */
export function validatePipelineTemplate(input, name) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error(`Template "${name}": root must be a JSON object`);
    }
    const obj = input;
    if (!Array.isArray(obj.stages) || obj.stages.length === 0) {
        throw new Error(`Template "${name}": "stages" must be a non-empty array`);
    }
    const stages = obj.stages;
    const stageNames = new Set();
    for (const stage of stages) {
        validateStageShape(stage, name);
        if (stageNames.has(stage.name)) {
            throw new Error(`Template "${name}": duplicate stage name "${stage.name}"`);
        }
        stageNames.add(stage.name);
    }
    // Second pass: scope-check transitions now that all stage names are known.
    for (const stage of stages) {
        for (const t of stage.transitions) {
            if (typeof t.next === 'string' && !stageNames.has(t.next)) {
                throw new Error(`Template "${name}": stage "${stage.name}" transition "${t.marker}" — "next" must reference a stage inside this template (got "${t.next}"; use "template" for cross-template handoffs)`);
            }
        }
    }
    let entry;
    if (obj.entry !== undefined) {
        if (typeof obj.entry !== 'string' || obj.entry.length === 0) {
            throw new Error(`Template "${name}": "entry" must be a non-empty string`);
        }
        if (!stageNames.has(obj.entry)) {
            throw new Error(`Template "${name}": "entry" references unknown stage "${obj.entry}"`);
        }
        entry = obj.entry;
    }
    else {
        entry = stages[0].name;
    }
    assertTemplateInternalAcyclic(stages, stageNames, name);
    return { name, entry, stages };
}
function validateStageShape(stage, templateName) {
    if (!stage || typeof stage !== 'object') {
        throw new Error(`Template "${templateName}": every stage must be a non-null object`);
    }
    if (typeof stage.name !== 'string' || stage.name.length === 0) {
        throw new Error(`Template "${templateName}": every stage requires a non-empty "name"`);
    }
    if (!Array.isArray(stage.transitions)) {
        throw new Error(`Template "${templateName}": stage "${stage.name}" missing "transitions" array`);
    }
    for (const t of stage.transitions) {
        validateTransitionShape(t, stage.name, templateName);
    }
    if (stage.kind !== undefined &&
        stage.kind !== 'agent' &&
        stage.kind !== 'command') {
        throw new Error(`Template "${templateName}": stage "${stage.name}" has invalid kind "${String(stage.kind)}" (must be "agent" or "command")`);
    }
    if (stage.fan_in !== undefined && stage.fan_in !== 'all') {
        throw new Error(`Template "${templateName}": stage "${stage.name}" has invalid fan_in "${String(stage.fan_in)}" (must be "all")`);
    }
}
function validateTransitionShape(t, stageName, templateName) {
    if (!t || typeof t !== 'object') {
        throw new Error(`Template "${templateName}": stage "${stageName}" has a non-object transition`);
    }
    if (typeof t.marker !== 'string' || t.marker.length === 0) {
        throw new Error(`Template "${templateName}": stage "${stageName}" has transition with empty marker`);
    }
    const tAny = t;
    if (tAny.retry !== undefined) {
        throw new Error(`Template "${templateName}": stage "${stageName}" transition "${t.marker}" — "retry" is no longer supported`);
    }
    if (tAny.next_dynamic !== undefined) {
        throw new Error(`Template "${templateName}": stage "${stageName}" transition "${t.marker}" — "next_dynamic" is no longer supported`);
    }
    if (t.next !== undefined && t.next !== null && typeof t.next !== 'string') {
        throw new Error(`Template "${templateName}": stage "${stageName}" transition "${t.marker}" — "next" must be a string or null (authored arrays are not allowed)`);
    }
    const hasNextString = typeof t.next === 'string';
    const hasTemplate = t.template !== undefined;
    if (hasNextString && hasTemplate) {
        throw new Error(`Template "${templateName}": stage "${stageName}" transition "${t.marker}" — must have either "next" or "template", not both`);
    }
    if (hasTemplate) {
        if (typeof t.template !== 'string' || t.template.length === 0) {
            throw new Error(`Template "${templateName}": stage "${stageName}" transition "${t.marker}" — "template" must be a non-empty string`);
        }
    }
    if (tAny.count !== undefined) {
        const c = tAny.count;
        if (typeof c !== 'number' || !Number.isInteger(c) || c < 1) {
            throw new Error(`Template "${templateName}": stage "${stageName}" transition "${t.marker}" — "count" must be a positive integer`);
        }
        if (!hasTemplate) {
            throw new Error(`Template "${templateName}": stage "${stageName}" transition "${t.marker}" — "count" requires "template"`);
        }
    }
}
/**
 * Cycle check restricted to transitions whose `next` is a template-internal
 * stage name. External references (base pipeline, other templates) are
 * out-of-scope here — they're validated at stitch-time against the full
 * merged graph.
 */
function assertTemplateInternalAcyclic(stages, stageNames, templateName) {
    const adj = new Map();
    for (const s of stages) {
        const outgoing = new Set();
        for (const t of s.transitions) {
            if (typeof t.next === 'string' && stageNames.has(t.next)) {
                outgoing.add(t.next);
            }
        }
        adj.set(s.name, outgoing);
    }
    const UNVISITED = 0;
    const ON_STACK = 1;
    const DONE = 2;
    const state = new Map();
    for (const s of stages)
        state.set(s.name, UNVISITED);
    const dfs = (node, stack) => {
        state.set(node, ON_STACK);
        stack.push(node);
        for (const nxt of adj.get(node) ?? []) {
            const c = state.get(nxt);
            if (c === ON_STACK) {
                const from = stack.indexOf(nxt);
                const cyclePath = [...stack.slice(from), nxt].join(' → ');
                throw new Error(`Template "${templateName}": cycle detected — ${cyclePath}`);
            }
            if (c === UNVISITED)
                dfs(nxt, stack);
        }
        stack.pop();
        state.set(node, DONE);
    };
    for (const s of stages) {
        if (state.get(s.name) === UNVISITED)
            dfs(s.name, []);
    }
}
//# sourceMappingURL=pipeline-template.js.map