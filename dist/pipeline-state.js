import fs from 'fs';
import path from 'path';
const PIPELINE_STATE_FILE = 'PIPELINE_STATE.json';
// scopeId constrains nested child-runner paths so parent and sibling runners
// don't collide on PIPELINE_STATE / sessions / IPC / logs. Short alphanumeric
// keeps the derived virtual sub-folder under the group-folder length cap.
const SCOPE_ID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;
export function assertValidScopeId(scopeId) {
    if (!SCOPE_ID_PATTERN.test(scopeId)) {
        throw new Error(`Invalid scopeId "${scopeId}" - must match ${SCOPE_ID_PATTERN}`);
    }
}
/**
 * Derive the state file name for a given pipeline tag and optional scopeId.
 * - no tag, no scope            -> 'PIPELINE_STATE.json' (backward compatible)
 * - tag only                    -> 'PIPELINE_STATE.<tag>.json'
 * - scope only                  -> 'PIPELINE_STATE.<scope>.json'
 * - scope + tag                 -> 'PIPELINE_STATE.<scope>.<tag>.json'
 */
function pipelineStateFileName(tag, scopeId) {
    const parts = [];
    if (scopeId)
        parts.push(scopeId);
    if (tag && tag !== 'PIPELINE')
        parts.push(tag);
    if (parts.length === 0)
        return PIPELINE_STATE_FILE;
    return `PIPELINE_STATE.${parts.join('.')}.json`;
}
/**
 * Derive a short tag from a custom pipeline file path.
 * e.g. '/abs/path/to/my-pipeline.json' -> 'my-pipeline'
 *      undefined (default PIPELINE.json) -> undefined
 */
export function pipelineTagFromPath(pipelinePath) {
    if (!pipelinePath)
        return undefined;
    const base = path.basename(pipelinePath, '.json');
    if (base === 'PIPELINE')
        return undefined;
    return base;
}
export function savePipelineState(stateDir, state, tag, scopeId) {
    fs.mkdirSync(stateDir, { recursive: true });
    const filepath = path.join(stateDir, pipelineStateFileName(tag, scopeId));
    const stateOut = { ...state, version: 3 };
    atomicWrite(filepath, JSON.stringify(stateOut, null, 2));
}
export function loadPipelineState(stateDir, tag, scopeId) {
    const filepath = path.join(stateDir, pipelineStateFileName(tag, scopeId));
    let raw;
    try {
        raw = fs.readFileSync(filepath, 'utf-8');
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return null;
        throw err;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (err) {
        throw new Error(`Pipeline state file ${filepath} is not valid JSON: ${err.message}`);
    }
    if (parsed.version !== 3 || parsed.pendingFanoutPayloads !== undefined) {
        throw new Error(`Pipeline state file ${filepath} is from an older pipeline-state version - delete it to reset (rm "${filepath}")`);
    }
    return parsed;
}
/**
 * Atomic write: write to .tmp then rename for crash safety.
 */
function atomicWrite(filepath, content) {
    const tmpPath = `${filepath}.tmp`;
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, filepath);
}
//# sourceMappingURL=pipeline-state.js.map