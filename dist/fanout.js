import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
const SUBSTITUTION_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
export const MAX_FANOUT_RECURSION_DEPTH = 2;
/**
 * Parse the payload emitted by the stage preceding a dynamic-fanout stage.
 * Must be a JSON array of flat objects whose values are string | number | boolean.
 */
export function parseFanoutPayload(payload, stageName) {
    let parsed;
    try {
        parsed = JSON.parse(payload);
    }
    catch (err) {
        throw new Error(`dynamic-fanout "${stageName}": payload is not valid JSON — ${err.message}`);
    }
    if (!Array.isArray(parsed)) {
        throw new Error(`dynamic-fanout "${stageName}": payload must be a JSON array, got ${typeof parsed}`);
    }
    const out = [];
    for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i];
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(`dynamic-fanout "${stageName}": payload[${i}] must be an object, got ${typeof item}`);
        }
        const normalized = {};
        for (const [key, value] of Object.entries(item)) {
            if (typeof value !== 'string' &&
                typeof value !== 'number' &&
                typeof value !== 'boolean') {
                throw new Error(`dynamic-fanout "${stageName}": payload[${i}].${key} must be string | number | boolean, got ${typeof value}`);
            }
            normalized[key] = value;
        }
        out.push(normalized);
    }
    return out;
}
/**
 * Load a child pipeline template from disk, relative to bundleDir.
 * Returns a freshly parsed PipelineConfig per call (no caching) so substitutions
 * of different inputs don't share object refs.
 */
export function loadFanoutTemplate(bundleDir, templatePath, stageName) {
    const resolved = path.isAbsolute(templatePath)
        ? templatePath
        : path.resolve(bundleDir, templatePath);
    // Containment check: resolved path must be inside bundleDir for non-absolute refs.
    if (!path.isAbsolute(templatePath)) {
        const rel = path.relative(bundleDir, resolved);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new Error(`dynamic-fanout "${stageName}": template path escapes bundleDir: ${templatePath}`);
        }
    }
    if (!fs.existsSync(resolved)) {
        throw new Error(`dynamic-fanout "${stageName}": template file not found: ${resolved}`);
    }
    let raw;
    try {
        raw = fs.readFileSync(resolved, 'utf-8');
    }
    catch (err) {
        throw new Error(`dynamic-fanout "${stageName}": failed reading template ${resolved} — ${err.message}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (err) {
        throw new Error(`dynamic-fanout "${stageName}": template is not valid JSON — ${err.message}`);
    }
    if (!Array.isArray(parsed.stages) || parsed.stages.length === 0) {
        throw new Error(`dynamic-fanout "${stageName}": template has no stages`);
    }
    return parsed;
}
/**
 * Apply flat {{key}} substitution to allowed fields of each stage in the template.
 * Only top-level PipelineStage fields listed in `allowedFields` are traversed.
 * Missing {{keys}} are left intact and a warning is logged — the agent will see them.
 */
export function applyFanoutSubstitutions(template, input, allowedFields, stageName) {
    const stages = template.stages.map((stage) => substituteStage(stage, input, allowedFields, stageName));
    return { ...template, stages };
}
function substituteStage(stage, input, allowedFields, parentStageName) {
    const out = { ...stage };
    for (const field of allowedFields) {
        if (!(field in out))
            continue;
        const value = out[field];
        out[field] = substituteValue(value, input, `${parentStageName}.${stage.name}.${field}`);
    }
    return out;
}
function substituteValue(value, input, path) {
    if (typeof value === 'string') {
        return substituteString(value, input, path);
    }
    if (Array.isArray(value)) {
        return value.map((v, i) => substituteValue(v, input, `${path}[${i}]`));
    }
    if (value !== null && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            const newKey = substituteString(k, input, `${path}.key(${k})`);
            out[newKey] = substituteValue(v, input, `${path}.${newKey}`);
        }
        return out;
    }
    return value;
}
function substituteString(text, input, where) {
    return text.replace(SUBSTITUTION_PATTERN, (match, key) => {
        if (!(key in input)) {
            logger.warn({ where, key }, 'dynamic-fanout substitution key not present in input — placeholder left intact');
            return match;
        }
        return String(input[key]);
    });
}
/**
 * Simple p-limit-style semaphore.
 * Invariant: at most `max` tasks run at the same time.
 */
export function withConcurrency(max, tasks) {
    if (!max || max >= tasks.length) {
        return Promise.all(tasks.map((t) => t()));
    }
    const results = new Array(tasks.length);
    let nextIndex = 0;
    const errors = [];
    const worker = async () => {
        while (true) {
            const idx = nextIndex++;
            if (idx >= tasks.length)
                return;
            try {
                results[idx] = await tasks[idx]();
            }
            catch (err) {
                errors.push(err);
            }
        }
    };
    const workers = Array.from({ length: max }, () => worker());
    return Promise.all(workers).then(() => {
        if (errors.length > 0)
            throw errors[0];
        return results;
    });
}
/**
 * Build a short scopeId for a fanout child, constrained to the scopeId pattern
 * enforced by PipelineRunner. Format: "f<6-hex>" (7 chars) — deterministic per
 * (parent scope, parent stage, index) pair so recovery/debug can correlate.
 */
export function deriveChildScopeId(parentScopeId, parentStage, index) {
    const seed = `${parentScopeId ?? ''}|${parentStage}|${index}`;
    const digest = crypto
        .createHash('sha256')
        .update(seed)
        .digest('hex')
        .slice(0, 6);
    return `f${digest}`;
}
/**
 * Count the nesting depth encoded in a scopeId chain. A top-level run has
 * undefined scopeId (depth 0). Each dynamic-fanout level appends one child
 * scope, so depth = number of fanout ancestors.
 *
 * Depth is tracked via the ART_FANOUT_DEPTH env variable on child runners.
 */
export function readFanoutDepth() {
    const raw = process.env.ART_FANOUT_DEPTH;
    if (!raw)
        return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}
export function assertFanoutDepthAllowed(stageName) {
    const current = readFanoutDepth();
    if (current >= MAX_FANOUT_RECURSION_DEPTH) {
        throw new Error(`dynamic-fanout "${stageName}": recursion depth ${current + 1} exceeds max ${MAX_FANOUT_RECURSION_DEPTH}`);
    }
    return current + 1;
}
//# sourceMappingURL=fanout.js.map