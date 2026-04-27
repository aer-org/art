/**
 * Host-Side Pipeline FSM with Multi-Container Isolation
 *
 * When a group has PIPELINE.json, this runner spawns separate containers
 * per stage with different mount policies. The host FSM routes work via IPC
 * and each container maintains its session across retries.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import { spawn, execSync } from 'child_process';
import { CONTAINER_IMAGE, DATA_DIR } from './config.js';
import { buildContainerArgs, prefixLogLines, runContainerAgent, } from './container-runner.js';
import { getRuntime } from './container-runtime.js';
import { getImageForStage } from './image-registry.js';
import { validateAdditionalMounts } from './mount-security.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { generateRunId, writeRunManifest, } from './run-manifest.js';
import { formatStageMcpAccessSummary, loadMcpRegistry, resolveStageMcpServers, } from './mcp-registry.js';
import { resolveAgentRefs } from './agent-ref.js';
import { resolveStagePrompt } from './prompt-store.js';
import { loadPipelineTemplate } from './pipeline-template.js';
import { assertConfigAcyclic, assertNoNameCollision, stitchParallel, stitchSingle, RESERVED_SUBSTITUTION_KEYS, } from './stitch.js';
function resolveProvider() {
    return process.env.ART_AGENT_PROVIDER === 'codex' ? 'codex' : 'claude';
}
/**
 * Resolve the effective stage kind — explicit `kind` wins, otherwise infer
 * from presence of `command`.
 */
export function resolveStageKind(stage) {
    if (stage.kind)
        return stage.kind;
    return stage.command ? 'command' : 'agent';
}
function transitionOutcome(transition) {
    if (transition.outcome)
        return transition.outcome;
    if (transition.afterTimeout)
        return 'error';
    return transition.marker?.includes('ERROR') ? 'error' : 'success';
}
function transitionDisplayName(transition) {
    if (transition.afterTimeout)
        return 'afterTimeout';
    return transition.marker ?? 'transition';
}
function primaryTransition(stage) {
    return stage.transitions.find((t) => !t.afterTimeout) ?? stage.transitions[0];
}
/**
 * Pure helper: given a matched transition and the payload captured from the
 * agent's marker, return the StitchDirective that performStitch should use.
 * Throws with a descriptive message on any invalid payload shape.
 *
 * Callers must pass `payload` only when the transition has `countFrom:
 * "payload"`; otherwise the argument is ignored. The caller catches thrown
 * errors and surfaces them as STAGE_ERROR outcomes.
 */
export function resolveStitchInputs(t, payload) {
    // Static count path — unchanged from pre-payload behavior.
    if (t.countFrom === undefined) {
        if (t.count !== undefined && t.count > 1) {
            return { mode: 'parallel', count: t.count };
        }
        return { mode: 'single' };
    }
    // Dynamic (payload-driven) path.
    if (payload === null || payload.length === 0) {
        throw new Error('countFrom: "payload" requires the agent to emit a fenced ---PAYLOAD_START---...---PAYLOAD_END--- block after the marker');
    }
    let parsed;
    try {
        parsed = JSON.parse(payload);
    }
    catch (err) {
        throw new Error(`Payload is not valid JSON: ${err.message}`);
    }
    if (!Array.isArray(parsed)) {
        throw new Error('Payload must be a JSON array');
    }
    if (parsed.length === 0) {
        throw new Error('Payload array must be non-empty');
    }
    const wantSubs = t.substitutionsFrom === 'payload';
    const perCopySubs = [];
    for (let i = 0; i < parsed.length; i++) {
        const el = parsed[i];
        if (el === null || typeof el !== 'object' || Array.isArray(el)) {
            throw new Error(`Payload element [${i}] must be a flat JSON object (got ${el === null ? 'null' : Array.isArray(el) ? 'array' : typeof el})`);
        }
        const subs = {};
        for (const [key, value] of Object.entries(el)) {
            if (RESERVED_SUBSTITUTION_KEYS.includes(key)) {
                throw new Error(`Payload element [${i}] uses reserved key "${key}" (reserved: ${RESERVED_SUBSTITUTION_KEYS.join(', ')})`);
            }
            if (typeof value !== 'string' &&
                typeof value !== 'number' &&
                typeof value !== 'boolean') {
                throw new Error(`Payload element [${i}] field "${key}" must be string/number/boolean (got ${typeof value})`);
            }
            subs[key] = value;
        }
        perCopySubs.push(subs);
    }
    if (perCopySubs.length === 1) {
        return {
            mode: 'single',
            subs: wantSubs ? perCopySubs[0] : undefined,
        };
    }
    return {
        mode: 'parallel',
        count: perCopySubs.length,
        perCopySubs: wantSubs ? perCopySubs : undefined,
    };
}
// --- Exclusive stage lock ---
// Stages with the same `exclusive` key share a mutex.
// Only one container runs at a time per key (e.g. "vivado" for bitstream + board_upload).
class ExclusiveLock {
    locked = false;
    queue = [];
    async acquire() {
        if (!this.locked) {
            this.locked = true;
            return;
        }
        return new Promise((resolve) => {
            this.queue.push(resolve);
        });
    }
    release() {
        if (this.queue.length > 0) {
            const next = this.queue.shift();
            next();
        }
        else {
            this.locked = false;
        }
    }
}
const exclusiveLocks = new Map();
function getExclusiveLock(key) {
    let lock = exclusiveLocks.get(key);
    if (!lock) {
        lock = new ExclusiveLock();
        exclusiveLocks.set(key, lock);
    }
    return lock;
}
const PIPELINE_STATE_FILE = 'PIPELINE_STATE.json';
// scopeId constrains nested child-runner paths so parent and sibling runners
// don't collide on PIPELINE_STATE / sessions / IPC / logs. Short alphanumeric
// keeps the derived virtual sub-folder under the group-folder length cap.
const SCOPE_ID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;
export function assertValidScopeId(scopeId) {
    if (!SCOPE_ID_PATTERN.test(scopeId)) {
        throw new Error(`Invalid scopeId "${scopeId}" — must match ${SCOPE_ID_PATTERN}`);
    }
}
/**
 * Derive the state file name for a given pipeline tag and optional scopeId.
 * - no tag, no scope            → 'PIPELINE_STATE.json' (backward compatible)
 * - tag only                    → 'PIPELINE_STATE.<tag>.json'
 * - scope only                  → 'PIPELINE_STATE.<scope>.json'
 * - scope + tag                 → 'PIPELINE_STATE.<scope>.<tag>.json'
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
 * e.g. '/abs/path/to/my-pipeline.json' → 'my-pipeline'
 *      undefined (default PIPELINE.json) → undefined
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
        throw new Error(`Pipeline state file ${filepath} is from an older pipeline-state version — delete it to reset (rm "${filepath}")`);
    }
    return parsed;
}
/**
 * Parse stage markers dynamically from the stage's transitions array.
 *
 * Supported forms (first match wins across transitions):
 *   [MARKER]                                          — no payload
 *   [MARKER: short inline payload]                    — single-line payload
 *   [MARKER]
 *   ---PAYLOAD_START---
 *   free-form multi-line payload (any chars incl. ])
 *   ---PAYLOAD_END---                                 — fenced payload
 *
 * The fenced form is preferred for anything non-trivial. Payload must not
 * contain the literal sentinel `---PAYLOAD_END---` (non-greedy match stops
 * at the first occurrence).
 *
 * Defensive unwrap: if a fenced payload body is *solely* an inline form of
 * the same marker (`[MARKER]` or `[MARKER: value]`), the inner value (or
 * null) is returned. This protects against agents double-wrapping the
 * marker — emitting inline syntax inside the fence — which would otherwise
 * leak literal brackets into downstream dispatchers.
 */
export function parseStageMarkers(resultTexts, transitions) {
    const combined = resultTexts.join('\n');
    for (const transition of transitions) {
        if (transition.afterTimeout || !transition.marker)
            continue;
        const markerName = escapeRegExp(transition.marker);
        // Fenced payload: [MARKER] followed by ---PAYLOAD_START---...---PAYLOAD_END---
        const fencedRegex = new RegExp(`\\[${markerName}\\][ \\t]*\\r?\\n[ \\t]*---PAYLOAD_START---[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*---PAYLOAD_END---`);
        const fencedMatch = fencedRegex.exec(combined);
        if (fencedMatch) {
            const payload = fencedMatch[1];
            const unwrapRegex = new RegExp(`^\\[${markerName}(?::\\s*(.+?))?\\]$`);
            const unwrap = unwrapRegex.exec(payload.trim());
            if (unwrap) {
                return { matched: transition, payload: unwrap[1] ?? null };
            }
            return { matched: transition, payload };
        }
        // Inline / no payload: [MARKER] or [MARKER: payload]
        const regex = new RegExp(`\\[${markerName}(?::\\s*(.+?))?\\]`);
        const match = regex.exec(combined);
        if (match) {
            return { matched: transition, payload: match[1] ?? null };
        }
    }
    return { matched: null, payload: null };
}
function readUserInput(promptText) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise((resolve) => {
        rl.question(promptText, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function createDeferred() {
    let resolve;
    const promise = new Promise((r) => {
        resolve = r;
    });
    return { promise, resolve };
}
/**
 * Atomic write: write to .tmp then rename for crash safety.
 */
function atomicWrite(filepath, content) {
    const tmpPath = `${filepath}.tmp`;
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, filepath);
}
/**
 * Send a message to a stage container via IPC input directory.
 */
function sendToStage(handle, text) {
    const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`;
    const filepath = path.join(handle.ipcInputDir, filename);
    atomicWrite(filepath, JSON.stringify({ type: 'message', text }));
    logger.debug({ stage: handle.name, textLen: text.length }, 'Sent IPC message to stage container');
}
/**
 * Send _close sentinel to a stage container.
 */
function closeStage(handle) {
    try {
        fs.writeFileSync(path.join(handle.ipcInputDir, '_close'), '');
    }
    catch {
        // Container may already be gone
    }
}
export class PipelineRunner {
    group;
    chatJid;
    config;
    notify;
    onProcess;
    groupDir;
    stateDir;
    bundleDir;
    runId;
    pipelineTag;
    scopeId;
    manifest;
    aborted = false;
    activeHandles = new Map();
    stageSessionIds = new Map();
    joinSettlements = new Map();
    activations = new Map();
    completions = new Map();
    baseStageCount = 0;
    constructor(group, chatJid, pipelineConfig, notify, onProcess, groupDir, runId, pipelineTag, scopeId, bundleDir) {
        this.group = group;
        this.chatJid = chatJid;
        this.config = pipelineConfig;
        this.baseStageCount = pipelineConfig.stages.length;
        this.notify = notify;
        this.onProcess = onProcess;
        this.groupDir = groupDir ?? resolveGroupFolderPath(this.group.folder);
        this.stateDir = path.join(this.groupDir, '.state');
        this.bundleDir = bundleDir ?? this.groupDir;
        this.runId = runId ?? generateRunId();
        this.pipelineTag = pipelineTag;
        if (scopeId !== undefined)
            assertValidScopeId(scopeId);
        this.scopeId = scopeId;
        this.manifest = {
            runId: this.runId,
            pid: process.pid,
            startTime: new Date().toISOString(),
            status: 'running',
            stages: [],
        };
    }
    /**
     * Compute the virtual sub-group folder for a stage container.
     * When scopeId is set, embed it so sibling runners that spawn the same
     * stage name get distinct IPC / sessions / conversations paths.
     */
    stageSubFolder(stageName) {
        return this.scopeId
            ? `${this.group.folder}__${this.scopeId}__pipeline_${stageName}`
            : `${this.group.folder}__pipeline_${stageName}`;
    }
    /**
     * Sub-paths must be relative, non-empty, and cannot contain ".." segments
     * or start with a leading slash. Keeps the mount confined under its parent.
     */
    isValidSubPath(subPath) {
        if (!subPath)
            return false;
        if (subPath.startsWith('/'))
            return false;
        const segments = subPath.split('/');
        if (segments.some((s) => s === '' || s === '..' || s === '.'))
            return false;
        return true;
    }
    getRunId() {
        return this.runId;
    }
    serializeJoinSettlements() {
        return Object.fromEntries([...this.joinSettlements.entries()].map(([joinStage, settlements]) => [
            joinStage,
            Object.fromEntries(settlements),
        ]));
    }
    restoreJoinSettlements(raw) {
        this.joinSettlements = new Map(Object.entries(raw ?? {}).map(([joinStage, settlements]) => [
            joinStage,
            new Map(Object.entries(settlements)),
        ]));
    }
    saveRunnerState(state) {
        savePipelineState(this.stateDir, {
            ...state,
            activations: Object.fromEntries(this.activations),
            completions: Object.fromEntries(this.completions),
            insertedStages: this.config.stages.slice(this.baseStageCount),
            joinSettlements: this.serializeJoinSettlements(),
        }, this.pipelineTag, this.scopeId);
    }
    copyIndexForJoinArrival(joinStage, finishedStage) {
        const join = joinStage.join;
        if (!join)
            return null;
        const prefixes = join.copyPrefixes ?? [];
        const index = prefixes.findIndex((prefix) => finishedStage.startsWith(prefix));
        if (index >= 0)
            return index;
        if (join.expectedCopies === 1)
            return 0;
        return null;
    }
    recordJoinSettlement(joinStageName, finishedStage, outcome) {
        if (!outcome)
            return;
        const joinStage = this.config.stages.find((s) => s.name === joinStageName);
        if (!joinStage?.join)
            return;
        const copyIndex = this.copyIndexForJoinArrival(joinStage, finishedStage);
        if (copyIndex === null) {
            logger.warn({ joinStage: joinStageName, finishedStage }, 'Join arrival did not match any copy prefix');
            return;
        }
        let settlements = this.joinSettlements.get(joinStageName);
        if (!settlements) {
            settlements = new Map();
            this.joinSettlements.set(joinStageName, settlements);
        }
        const key = String(copyIndex);
        if (settlements.has(key))
            return;
        settlements.set(key, outcome);
    }
    isJoinReady(stageName) {
        const stage = this.config.stages.find((s) => s.name === stageName);
        if (!stage?.join)
            return true;
        const settled = this.joinSettlements.get(stageName);
        return (settled?.size ?? 0) >= stage.join.expectedCopies;
    }
    evaluateJoinOutcome(stage) {
        const join = stage.join;
        if (!join)
            return 'success';
        const settlements = this.joinSettlements.get(stage.name);
        const values = [...(settlements?.values() ?? [])];
        const successCount = values.filter((value) => value === 'success').length;
        switch (join.policy) {
            case 'all_success':
                return successCount === join.expectedCopies ? 'success' : 'error';
            case 'any_success':
                return successCount > 0 ? 'success' : 'error';
            case 'all_settled':
                return 'success';
        }
    }
    async abort() {
        this.aborted = true;
        const handles = [...this.activeHandles.values()];
        await Promise.all(handles.map((h) => this.closeAndWait(h)));
    }
    /** Send a visually prominent banner to TUI for stage transitions */
    async notifyBanner(text) {
        if (process.env.ART_TUI_MODE) {
            const line = '─'.repeat(50);
            await this.notify(`\n\x1b[36m${line}\x1b[0m\n\x1b[1;36m${text}\x1b[0m\n\x1b[36m${line}\x1b[0m`);
        }
        else {
            await this.notify(text);
        }
    }
    /**
     * Build all internal mounts for a stage: group mounts + project mount +
     * __art__ shadow + project:* sub-path overrides.
     * Shared by both agent mode and command mode.
     */
    buildStageMounts(stageConfig) {
        const mounts = [];
        // Reserved keys that conflict with /workspace/* system paths
        const RESERVED_KEYS = new Set([
            'project',
            'ipc',
            'global',
            'extra',
            'conversations',
        ]);
        const emptyDir = path.join(DATA_DIR, 'empty');
        fs.mkdirSync(emptyDir, { recursive: true });
        // Stage mounts (e.g. "src": "rw" → /workspace/src)
        for (const [key, policy] of Object.entries(stageConfig.mounts)) {
            if (key.includes(':'))
                continue; // sub-path keys handled below
            if (!policy)
                continue;
            if (RESERVED_KEYS.has(key)) {
                logger.warn({ key }, `mount key "${key}" conflicts with reserved /workspace/${key} — skipped`);
                continue;
            }
            const hostDir = path.join(this.groupDir, key);
            fs.mkdirSync(hostDir, { recursive: true });
            mounts.push({
                hostPath: hostDir,
                containerPath: `/workspace/${key}`,
                readonly: policy === 'ro',
            });
        }
        // Project mount (parent of __art__/)
        const projectPolicy = stageConfig.mounts['project'];
        const effectivePolicy = projectPolicy === undefined ? 'ro' : projectPolicy;
        const artDirName = path.basename(this.groupDir);
        if (effectivePolicy) {
            mounts.push({
                hostPath: path.dirname(this.groupDir),
                containerPath: '/workspace/project',
                readonly: effectivePolicy === 'ro',
            });
            // Shadow __art__/ with empty dir
            mounts.push({
                hostPath: emptyDir,
                containerPath: `/workspace/project/${artDirName}`,
                readonly: true,
            });
        }
        // Sub-path overrides. Syntax: "<key>:<subpath>" with value ro | rw | null.
        // File-level bind mounts are not supported (Docker tracks inodes, git
        // operations replace files with new inodes, making the bind mount stale).
        for (const [key, subPolicy] of Object.entries(stageConfig.mounts)) {
            if (!key.includes(':'))
                continue;
            const sepIdx = key.indexOf(':');
            const parentKey = key.slice(0, sepIdx);
            const subPath = key.slice(sepIdx + 1);
            if (!this.isValidSubPath(subPath)) {
                logger.warn({ key, subPath }, 'Invalid sub-path — skipped');
                continue;
            }
            if (RESERVED_KEYS.has(parentKey) && parentKey !== 'project') {
                logger.warn({ parentKey, subPath }, `sub-mount parent "${parentKey}" conflicts with reserved /workspace/${parentKey} — skipped`);
                continue;
            }
            let hostBase;
            let containerBase;
            let parentEffective;
            if (parentKey === 'project') {
                if (!effectivePolicy)
                    continue;
                if (subPath === artDirName || subPath.startsWith(artDirName + '/'))
                    continue;
                hostBase = path.dirname(this.groupDir);
                containerBase = '/workspace/project';
                parentEffective = effectivePolicy;
            }
            else {
                hostBase = path.join(this.groupDir, parentKey);
                containerBase = `/workspace/${parentKey}`;
                const pp = stageConfig.mounts[parentKey];
                parentEffective = pp === 'ro' || pp === 'rw' ? pp : undefined;
            }
            const subHostPath = path.join(hostBase, subPath);
            const isFile = fs.existsSync(subHostPath) && fs.statSync(subHostPath).isFile();
            if (isFile) {
                logger.warn({ key, subPath }, 'File-level sub-mount ignored (only directories supported)');
                continue;
            }
            const containerSubPath = `${containerBase}/${subPath}`;
            if (subPolicy === null) {
                // Only meaningful when parent is mounted — shadow that subtree.
                if (parentEffective) {
                    mounts.push({
                        hostPath: emptyDir,
                        containerPath: containerSubPath,
                        readonly: true,
                    });
                }
                continue;
            }
            if (!subPolicy)
                continue;
            if (parentEffective && subPolicy === parentEffective)
                continue;
            // Direct or override mount. Create the host dir so the child can
            // populate it even when the parent is absent.
            fs.mkdirSync(subHostPath, { recursive: true });
            mounts.push({
                hostPath: subHostPath,
                containerPath: containerSubPath,
                readonly: subPolicy === 'ro',
            });
        }
        // Host path mounts (validated against external allowlist)
        if (stageConfig.hostMounts && stageConfig.hostMounts.length > 0) {
            const validated = validateAdditionalMounts(stageConfig.hostMounts, `pipeline-${stageConfig.name}`, this.group.isMain ?? false);
            mounts.push(...validated);
        }
        // Conversations archive directory (agent-runner writes transcripts here)
        const subFolder = this.stageSubFolder(stageConfig.name);
        const convDir = path.join(resolveGroupFolderPath(subFolder), 'conversations');
        fs.mkdirSync(convDir, { recursive: true });
        mounts.push({
            hostPath: convDir,
            containerPath: '/workspace/conversations',
            readonly: false,
        });
        return mounts;
    }
    /**
     * Spawn a stage container as a virtual sub-group.
     * The container starts with an initial prompt and enters the IPC wait loop.
     */
    spawnStageContainer(stageConfig, initialPrompt, logStream, ephemeralSystemPrompt) {
        const subFolder = this.stageSubFolder(stageConfig.name);
        // Build internal mounts (group + project + sub-path overrides)
        const internalMounts = this.buildStageMounts(stageConfig);
        // Resolve container image from registry (agent mode only)
        let resolvedImage;
        if (!stageConfig.command) {
            resolvedImage = getImageForStage(stageConfig.image, false);
        }
        const resolvedExternalMcpServers = stageConfig.command
            ? []
            : resolveStageMcpServers(stageConfig.mcpAccess, {
                hostGateway: getRuntime().hostGateway,
            });
        // Parent's additional mounts stay in additionalMounts (security-validated).
        // Filter out any that conflict with stage-level hostMounts (stage wins).
        const parentMounts = this.group.containerConfig?.additionalMounts || [];
        const stageExtraPaths = new Set(internalMounts
            .filter((m) => m.containerPath.startsWith('/workspace/extra/'))
            .map((m) => m.containerPath));
        const filteredParentMounts = parentMounts.filter((m) => {
            const cp = `/workspace/extra/${m.containerPath || path.basename(m.hostPath)}`;
            return !stageExtraPaths.has(cp);
        });
        const virtualGroup = {
            name: `pipeline-${stageConfig.name}`,
            folder: subFolder, // Flat folder for IPC/sessions
            trigger: '',
            added_at: new Date().toISOString(),
            containerConfig: {
                provider: this.group.containerConfig?.provider || resolveProvider(),
                image: resolvedImage,
                additionalMounts: filteredParentMounts,
                additionalDevices: stageConfig.devices || [],
                gpu: stageConfig.gpu === true,
                runAsRoot: stageConfig.runAsRoot === true,
                privileged: stageConfig.privileged === true,
                env: stageConfig.env,
                externalMcpServers: resolvedExternalMcpServers,
                internalMounts,
            },
        };
        const ipcInputDir = path.join(resolveGroupIpcPath(subFolder), 'input');
        fs.mkdirSync(ipcInputDir, { recursive: true });
        // Clean stale _close sentinel
        try {
            fs.unlinkSync(path.join(ipcInputDir, '_close'));
        }
        catch {
            /* ignore */
        }
        const handle = {
            name: stageConfig.name,
            config: stageConfig,
            ipcInputDir,
            containerPromise: null,
            pendingResult: createDeferred(),
            resultTexts: [],
        };
        // Create onOutput callback that resolves the pending deferred
        const onOutput = async (output) => {
            logger.info({
                stage: stageConfig.name,
                hasResult: !!output.result,
                hasPending: !!handle.pendingResult,
                textsLen: handle.resultTexts.length,
            }, 'onOutput called');
            // result=null means query ended (agent entering IPC wait).
            // If we have accumulated text with no marker, resolve as no-match
            // so the FSM can send a retry prompt via IPC.
            if (!output.result) {
                if (handle.pendingResult && handle.resultTexts.length > 0) {
                    handle.pendingResult.resolve({ matched: null, payload: null });
                    handle.pendingResult = null;
                    handle.resultTexts = [];
                }
                return;
            }
            handle.resultTexts.push(output.result);
            // Stream agent output to user
            if (stageConfig.chat) {
                // Chatting stage: show full output so user can read the agent's response
                await this.notify(output.result);
            }
            else if (process.env.ART_TUI_MODE) {
                const lines = output.result.split('\n');
                const summary = lines.length > 3
                    ? lines.slice(0, 3).join('\n') +
                        `\n... (${lines.length - 3} more lines)`
                    : output.result;
                await this.notify(`[${stageConfig.name}] ${summary}`);
            }
            const markers = parseStageMarkers(handle.resultTexts, stageConfig.transitions);
            logger.info({ stage: stageConfig.name, matched: markers.matched?.marker ?? null }, 'parseStageMarkers result');
            if (markers.matched) {
                if (handle.pendingResult) {
                    logger.info({ stage: stageConfig.name, marker: markers.matched.marker }, 'Resolving pendingResult');
                    handle.pendingResult.resolve(markers);
                    handle.pendingResult = null;
                }
                else {
                    logger.warn({ stage: stageConfig.name, marker: markers.matched.marker }, 'Marker matched but no pendingResult!');
                }
                handle.resultTexts = [];
            }
            else if (handle.pendingResult) {
                // Result came but no marker — resolve immediately as no-match
                // so the FSM sends a retry prompt with transition instructions via IPC.
                logger.warn({ stage: stageConfig.name }, 'Result without marker, resolving as no-match for retry');
                handle.pendingResult.resolve({ matched: null, payload: null });
                handle.pendingResult = null;
                handle.resultTexts = [];
            }
        };
        if (stageConfig.command) {
            // Command mode: run shell command, no agent
            handle.containerPromise = this.runStageCommand(stageConfig, handle, logStream);
        }
        else {
            // Agent mode: spawn the container (don't await — it runs in background)
            // Resume previous session if available (preserves context across loop iterations)
            handle.containerPromise = runContainerAgent(virtualGroup, {
                prompt: initialPrompt,
                sessionId: stageConfig.resumeSession !== false
                    ? this.stageSessionIds.get(stageConfig.name)
                    : undefined,
                provider: virtualGroup.containerConfig?.provider,
                groupFolder: subFolder,
                chatJid: this.chatJid,
                isMain: false,
                assistantName: `pipeline-${stageConfig.name}`,
                runId: this.runId,
                ephemeralSystemPrompt,
                externalMcpServers: resolvedExternalMcpServers,
            }, (proc, containerName) => this.onProcess(proc, containerName), onOutput, logStream);
        }
        // Handle container exit
        handle.containerPromise
            .then((result) => {
            logger.info({ stage: stageConfig.name, status: result.status }, 'Pipeline stage container exited');
            // If there's a pending result, resolve with a fallback
            if (handle.pendingResult) {
                const markers = parseStageMarkers(handle.resultTexts, stageConfig.transitions);
                handle.pendingResult.resolve(markers.matched
                    ? markers
                    : {
                        matched: {
                            marker: '_CONTAINER_EXIT',
                            prompt: 'Container exited unexpectedly',
                        },
                        payload: 'Container exited unexpectedly',
                    });
                handle.pendingResult = null;
            }
        })
            .catch((err) => {
            logger.error({ stage: stageConfig.name, err }, 'Pipeline stage container error');
            if (handle.pendingResult) {
                handle.pendingResult.resolve({
                    matched: {
                        marker: '_CONTAINER_ERROR',
                        prompt: 'Container error',
                    },
                    payload: `Container error: ${err instanceof Error ? err.message : String(err)}`,
                });
                handle.pendingResult = null;
            }
        });
        return handle;
    }
    /**
     * Run a command-mode stage: spawn container with sh -c, collect stdout,
     * parse markers from output.
     */
    runStageCommand(stageConfig, handle, logStream) {
        const rt = getRuntime();
        const internalMounts = this.buildStageMounts(stageConfig);
        const safeName = stageConfig.name.replace(/[^a-zA-Z0-9-]/g, '-');
        const containerName = `aer-art-cmd-${safeName}-${Date.now()}`;
        const image = stageConfig.image || CONTAINER_IMAGE;
        const devices = stageConfig.devices || [];
        const gpu = stageConfig.gpu === true;
        const runAsRoot = stageConfig.runAsRoot === true;
        const privileged = stageConfig.privileged === true;
        const containerArgs = buildContainerArgs(internalMounts, containerName, devices, gpu, runAsRoot, image, 'sh', this.runId, privileged, stageConfig.env);
        containerArgs.push('-c', stageConfig.command);
        logger.info({ stage: stageConfig.name, image, command: stageConfig.command }, 'Running command-mode stage');
        if (logStream) {
            logStream.write(`\n=== Command Stage: ${stageConfig.name} ===\n` +
                `Started: ${new Date().toISOString()}\n` +
                `Image: ${image}\n` +
                `Command: ${stageConfig.command}\n\n`);
        }
        return new Promise((resolve) => {
            const container = spawn(rt.bin, containerArgs, {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            this.onProcess(container, containerName);
            let stdout = '';
            let stderr = '';
            let cmdLogRemainder = '';
            let cmdLogStderrRemainder = '';
            let cmdNotifyRemainder = '';
            // Streaming marker detection: resolve pendingResult as soon as a marker
            // is found in stdout, without waiting for process exit.
            let markerResolved = false;
            const completeTransition = stageConfig.transitions.find((t) => !t.afterTimeout && t.marker === 'STAGE_COMPLETE');
            const errorTransition = stageConfig.transitions.find((t) => !t.afterTimeout && t.marker === 'STAGE_ERROR');
            const timeoutTransition = stageConfig.transitions.find((t) => t.afterTimeout);
            const resolveTransition = (transition, fallback, payload, isSuccess, shouldTerminateProcess = false) => {
                if (markerResolved || !handle.pendingResult)
                    return;
                markerResolved = true;
                // On success, scan stdout for a fenced marker payload to forward to
                // the next stage. Command stages don't emit payload structurally, but
                // fenced `[MARKER] ... ---PAYLOAD_START--- ... ---PAYLOAD_END---`
                // blocks in stdout are picked up so a command stage can feed a
                // downstream dynamic-fanout.
                let effectivePayload = payload;
                if (isSuccess &&
                    transition &&
                    !transition.afterTimeout &&
                    effectivePayload === null) {
                    const parsed = parseStageMarkers([stdout], [transition]);
                    if (parsed.matched && parsed.payload !== null) {
                        effectivePayload = parsed.payload;
                    }
                }
                handle.pendingResult.resolve({
                    matched: transition ?? fallback,
                    payload: effectivePayload,
                });
                handle.pendingResult = null;
                if (shouldTerminateProcess) {
                    container.kill('SIGTERM');
                }
            };
            container.stdout.on('data', (data) => {
                const chunk = data.toString();
                stdout += chunk;
                if (logStream) {
                    const { prefixed, remainder } = prefixLogLines(chunk, stageConfig.name, cmdLogRemainder);
                    cmdLogRemainder = remainder;
                    if (prefixed)
                        logStream.write(prefixed);
                }
                // Stream output to TUI
                if (process.env.ART_TUI_MODE) {
                    const { prefixed, remainder } = prefixLogLines(chunk, stageConfig.name, cmdNotifyRemainder);
                    cmdNotifyRemainder = remainder;
                    const trimmed = prefixed.trimEnd();
                    if (trimmed) {
                        this.notify(trimmed).catch(() => { });
                    }
                }
                // Streaming marker detection
                if (!markerResolved) {
                    if (stageConfig.successMarker &&
                        stdout.includes(stageConfig.successMarker)) {
                        resolveTransition(completeTransition, { marker: 'STAGE_COMPLETE', next: null }, null, true);
                    }
                    else if (stageConfig.errorMarker &&
                        stdout.includes(stageConfig.errorMarker)) {
                        resolveTransition(errorTransition, { marker: 'STAGE_ERROR', next: null, outcome: 'error' }, `errorMarker detected: ${stageConfig.errorMarker}`, false, true);
                    }
                }
            });
            container.stderr.on('data', (data) => {
                const chunk = data.toString();
                stderr += chunk;
                if (logStream) {
                    const { prefixed, remainder } = prefixLogLines(chunk, `${stageConfig.name}:stderr`, cmdLogStderrRemainder);
                    cmdLogStderrRemainder = remainder;
                    if (prefixed)
                        logStream.write(prefixed);
                }
            });
            const configTimeout = stageConfig.timeout ?? this.group.containerConfig?.timeout ?? 14400000; // 4 hour default for commands
            let timedOut = false;
            const timeout = setTimeout(() => {
                timedOut = true;
                container.kill('SIGTERM');
                setTimeout(() => container.kill('SIGKILL'), 15000);
            }, configTimeout);
            container.on('close', (code) => {
                clearTimeout(timeout);
                if (logStream) {
                    if (cmdLogRemainder)
                        logStream.write(`[${stageConfig.name}] ${cmdLogRemainder}\n`);
                    if (cmdLogStderrRemainder)
                        logStream.write(`[${stageConfig.name}:stderr] ${cmdLogStderrRemainder}\n`);
                    logStream.write(`\n=== Command Stage ${stageConfig.name} exited: code=${code} ===\n`);
                }
                if (process.env.ART_TUI_MODE && cmdNotifyRemainder) {
                    this.notify(`[${stageConfig.name}] ${cmdNotifyRemainder}`).catch(() => { });
                }
                // If marker already resolved during streaming, just finalize the container promise
                if (markerResolved) {
                    resolve({
                        status: code === 0 ? 'success' : 'error',
                        result: stdout,
                        error: code !== 0 ? `Command exited with code ${code}` : undefined,
                    });
                    return;
                }
                if (timedOut) {
                    resolveTransition(timeoutTransition ?? errorTransition, timeoutTransition
                        ? { afterTimeout: true, next: null, outcome: 'error' }
                        : { marker: 'STAGE_ERROR', next: null, outcome: 'error' }, `Command timed out after ${configTimeout}ms`, false);
                    resolve({
                        status: 'error',
                        result: null,
                        error: `Command timed out after ${configTimeout}ms`,
                    });
                    return;
                }
                // Fallback: no streaming marker matched, use successMarker check or exit code
                const isSuccess = stageConfig.successMarker
                    ? stdout.includes(stageConfig.successMarker)
                    : code === 0;
                resolveTransition(isSuccess ? completeTransition : errorTransition, isSuccess
                    ? { marker: 'STAGE_COMPLETE', next: null }
                    : { marker: 'STAGE_ERROR', next: null, outcome: 'error' }, isSuccess
                    ? null
                    : code !== 0
                        ? `Exit code ${code}: ${stderr.slice(-500)}`
                        : `successMarker not found in output`, isSuccess);
                resolve({
                    status: code === 0 ? 'success' : 'error',
                    result: stdout,
                    error: code !== 0 ? `Command exited with code ${code}` : undefined,
                });
            });
            container.on('error', (err) => {
                clearTimeout(timeout);
                resolveTransition(errorTransition, { marker: 'STAGE_ERROR', next: null, outcome: 'error' }, err.message, false);
                resolve({
                    status: 'error',
                    result: null,
                    error: `Command container spawn error: ${err.message}`,
                });
            });
        });
    }
    /**
     * Close a stage container and wait for it to exit (with timeout).
     */
    async closeAndWait(handle) {
        closeStage(handle);
        const settled = await Promise.race([
            handle.containerPromise.then(() => 'done'),
            new Promise((r) => setTimeout(() => r('timeout'), 5000)),
        ]);
        if (settled === 'timeout') {
            logger.warn({ stage: handle.name }, 'Stage did not exit in 5s, force-stopping');
            try {
                const { cleanupRunContainers } = await import('./container-runtime.js');
                cleanupRunContainers(this.runId);
            }
            catch {
                /* best effort */
            }
        }
    }
    /**
     * Build commonRules dynamically from a stage's transitions.
     */
    buildCommonRules(stageConfig) {
        const markerLines = stageConfig.transitions
            .filter((t) => !t.afterTimeout && t.marker)
            .map((t) => {
            const desc = t.prompt || t.marker;
            return `- ${desc} → [${t.marker}]`;
        });
        const modeRule = stageConfig.chat
            ? '- You are in an interactive conversation with the user. Ask questions and respond conversationally.\n- When the conversation goal is achieved, emit the completion marker.'
            : '- Do NOT ask questions. Always assume "yes" and proceed autonomously.\n- Do not stop until this stage is complete or you hit a blocking error.';
        const externalMcpLines = (() => {
            if (!stageConfig.mcpAccess || stageConfig.mcpAccess.length === 0) {
                return '- External MCP access for this stage: none.';
            }
            const servers = resolveStageMcpServers(stageConfig.mcpAccess, {
                hostGateway: getRuntime().hostGateway,
            });
            return [
                '- External MCP access is limited to the following servers/tools:',
                ...formatStageMcpAccessSummary(servers),
            ].join('\n');
        })();
        return `
RULES:
${modeRule}
- Read files before editing. Use tools freely.
- Project source is available read-only at /workspace/project/.
- Stage working directories are mounted under /workspace/ (plan/, src/, tb/, build/, sim/, etc.). Always read and write files at these paths.
${externalMcpLines}

STAGE MARKERS — use the correct one:
${markerLines.join('\n')}

PAYLOAD FORMATS:
- Short, single-line payload: [MARKER: payload text]
- Long or multi-line payload (preferred for anything non-trivial), emit the bare marker on its own line followed by a fenced block:
    [MARKER]
    ---PAYLOAD_START---
    free-form content, any characters or line count allowed
    ---PAYLOAD_END---
  Do NOT include the literal string "---PAYLOAD_END---" inside the payload.`;
    }
    /**
     * Validate plan, initialize git if needed, write manifest, create log stream.
     * Returns null on validation failure.
     */
    async initRun() {
        const planPath = path.join(this.bundleDir, 'plan', 'PLAN.md');
        const planContent = fs.existsSync(planPath)
            ? fs.readFileSync(planPath, 'utf-8')
            : '';
        // Ensure project directory is a git repo (containers need it for branching/committing)
        const projectRoot = path.dirname(this.groupDir);
        const dotGit = path.join(projectRoot, '.git');
        if (!fs.existsSync(dotGit)) {
            logger.info({ projectRoot }, 'Project is not a git repo, initializing');
            const gitEnv = {
                ...process.env,
                GIT_AUTHOR_NAME: 'AerArt',
                GIT_AUTHOR_EMAIL: 'art-agent@local',
                GIT_COMMITTER_NAME: 'AerArt',
                GIT_COMMITTER_EMAIL: 'art-agent@local',
            };
            execSync('git init -b main', { cwd: projectRoot, stdio: 'pipe' });
            execSync('git commit --allow-empty -m "art: initial baseline"', {
                cwd: projectRoot,
                stdio: 'pipe',
                env: gitEnv,
            });
        }
        // Write initial manifest
        writeRunManifest(this.stateDir, this.manifest);
        logger.info({
            group: this.group.name,
            runId: this.runId,
            planLen: planContent.length,
            stageCount: this.config.stages.length,
        }, 'Pipeline starting');
        const stageNames = this.config.stages.map((s) => s.name).join(' → ');
        await this.notifyBanner(`🚀 Pipeline starting. Stages: ${stageNames}`);
        // Pipeline-wide log file
        const logsDir = this.scopeId
            ? path.join(this.stateDir, 'logs', this.scopeId)
            : path.join(this.stateDir, 'logs');
        fs.mkdirSync(logsDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const pipelineLogFile = path.join(logsDir, `pipeline-${ts}.log`);
        this.manifest.logFile = this.scopeId
            ? `logs/${this.scopeId}/pipeline-${ts}.log`
            : `logs/pipeline-${ts}.log`;
        writeRunManifest(this.stateDir, this.manifest);
        const pipelineLogStream = fs.createWriteStream(pipelineLogFile);
        pipelineLogStream.write(`=== Pipeline Log ===\n` +
            `Started: ${new Date().toISOString()}\n` +
            `Group: ${this.group.name}\n` +
            `Stages: ${stageNames}\n\n`);
        // Build stage config lookup
        const stagesByName = new Map();
        for (const s of this.config.stages) {
            stagesByName.set(s.name, s);
        }
        const planSuffix = planContent ? `\n\n## Plan\n\n${planContent}` : '';
        return { planContent: planSuffix, stagesByName, pipelineLogStream };
    }
    /**
     * Normalize transition.next to an array of target names (empty for pipeline end).
     */
    static nextTargets(next) {
        if (next == null)
            return [];
        return Array.isArray(next) ? next : [next];
    }
    /**
     * Build predecessor map: for each stage, which stages have non-retry
     * transitions pointing to it?
     */
    buildPredecessorMap() {
        const predecessors = new Map();
        for (const s of this.config.stages) {
            // Only the first transition (primary/success path) contributes to the
            // predecessor map. Error/fallback transitions listed after the primary
            // one do not gate fan-in.
            const primary = primaryTransition(s);
            if (!primary)
                continue;
            for (const target of PipelineRunner.nextTargets(primary.next)) {
                let set = predecessors.get(target);
                if (!set) {
                    set = new Set();
                    predecessors.set(target, set);
                }
                set.add(s.name);
            }
        }
        return predecessors;
    }
    /**
     * Check if a stage's fan-in gate is satisfied:
     * all predecessors must appear in completedStages.
     */
    /**
     * Execute a stitch operation, mutating this.config to include the inserted
     * stages and returning the new host transition target (single name or an
     * array for parallel stitch).
     */
    performStitch(stageConfig, transitionIdx, templateName, downstreamNext, joinPolicy, directive) {
        if (transitionIdx < 0) {
            throw new Error(`Host transition for "${stageConfig.name}" not found in stage config`);
        }
        const template = loadPipelineTemplate(this.bundleDir, templateName);
        if (directive.mode === 'parallel') {
            const r = stitchParallel({
                config: this.config,
                originStage: stageConfig.name,
                originTransitionIdx: transitionIdx,
                template,
                downstreamNext,
                joinPolicy,
                count: directive.count,
                perCopySubstitutions: directive.perCopySubs,
            });
            this.config = r.updatedConfig;
            logger.info({
                origin: stageConfig.name,
                template: templateName,
                insertId: r.insertId,
                count: directive.count,
                subs: directive.perCopySubs !== undefined,
            }, 'Stitch (parallel) applied');
            return { insertedStages: r.insertedStages, newNext: r.entryNames };
        }
        const r = stitchSingle({
            config: this.config,
            originStage: stageConfig.name,
            originTransitionIdx: transitionIdx,
            template,
            downstreamNext,
            joinPolicy,
            substitutions: directive.subs,
        });
        this.config = r.updatedConfig;
        logger.info({
            origin: stageConfig.name,
            template: templateName,
            insertId: r.insertId,
            subs: directive.subs !== undefined,
        }, 'Stitch (single) applied');
        return { insertedStages: r.insertedStages, newNext: r.entryName };
    }
    static fanInReady(stageName, predecessors, completedStages) {
        const preds = predecessors.get(stageName);
        if (!preds || preds.size <= 1)
            return true;
        const completed = new Set(completedStages);
        for (const pred of preds) {
            if (!completed.has(pred))
                return false;
        }
        return true;
    }
    /**
     * Determine entry stage and resume from previous state if applicable.
     * Restores activations/completions/joinSettlements into instance fields.
     */
    async resolveEntryStage(stagesByName) {
        // Determine entry stage: explicit > heuristic (prefer nodes with outgoing edges) > stages[0]
        const resolveEntry = () => {
            if (this.config.entryStage && stagesByName.has(this.config.entryStage)) {
                return this.config.entryStage;
            }
            const hasIncoming = new Set();
            const hasOutgoing = new Set();
            for (const s of this.config.stages) {
                for (const t of s.transitions) {
                    const targets = PipelineRunner.nextTargets(t.next);
                    if (targets.length > 0) {
                        hasOutgoing.add(s.name);
                        for (const target of targets)
                            hasIncoming.add(target);
                    }
                }
            }
            const preferred = this.config.stages.find((s) => !hasIncoming.has(s.name) && hasOutgoing.has(s.name));
            if (preferred)
                return preferred.name;
            const fallback = this.config.stages.find((s) => !hasIncoming.has(s.name));
            if (fallback)
                return fallback.name;
            return this.config.stages[0].name;
        };
        // Resume from last completed stage if pipeline was interrupted
        const existingState = loadPipelineState(this.stateDir, this.pipelineTag, this.scopeId);
        if (existingState &&
            existingState.status !== 'success' &&
            existingState.completedStages.length > 0) {
            const completedStages = [...existingState.completedStages];
            // Resume from currentStage directly — it captures exactly what was
            // running at interruption, handling cyclic and fan-out cases correctly.
            let initialStages;
            if (existingState.currentStage) {
                const current = Array.isArray(existingState.currentStage)
                    ? existingState.currentStage
                    : [existingState.currentStage];
                initialStages = current
                    .flatMap((name) => {
                    if (!stagesByName.has(name))
                        return [];
                    if (!completedStages.includes(name))
                        return [name];
                    const stage = stagesByName.get(name);
                    const primary = primaryTransition(stage);
                    return primary ? PipelineRunner.nextTargets(primary.next) : [];
                })
                    .filter((s, index, items) => items.indexOf(s) === index)
                    .filter((s) => stagesByName.has(s));
            }
            else {
                // Pipeline finished with error (currentStage: null). Find the last
                // stage that errored and retry from it rather than restarting the
                // whole pipeline.
                const completedSet = new Set(completedStages);
                const unfinished = this.config.stages
                    .filter((s) => !completedSet.has(s.name))
                    .map((s) => s.name);
                initialStages = unfinished.length > 0 ? [unfinished[0]] : [];
            }
            if (initialStages.length === 0) {
                initialStages = [resolveEntry()];
            }
            await this.notifyBanner(`🔄 Resuming from ${initialStages.join(', ')} (previously completed: ${existingState.completedStages.join(' → ')})`);
            // Restore activation/completion counts from persisted state
            this.activations = new Map(Object.entries(existingState.activations ?? {}));
            this.completions = new Map(Object.entries(existingState.completions ?? {}));
            this.restoreJoinSettlements(existingState.joinSettlements);
            // Restore dynamically-inserted stages (from earlier stitch operations)
            if (existingState.insertedStages &&
                existingState.insertedStages.length > 0) {
                this.config = {
                    ...this.config,
                    stages: [...this.config.stages, ...existingState.insertedStages],
                };
                assertNoNameCollision(this.config);
                // baseStageCount already reflects the pre-resume count; don't update
            }
            return { initialStages, completedStages };
        }
        this.restoreJoinSettlements(undefined);
        this.activations = new Map();
        this.completions = new Map();
        return {
            initialStages: [resolveEntry()],
            completedStages: [],
        };
    }
    /**
     * Handle stage result: no-match → retry prompt, retry → re-send,
     * transition → close container and advance FSM.
     */
    async handleStageResult(result, ctx) {
        const { matched, payload } = result;
        const { handle, stageConfig, currentStageName, turnCount, stageStartTime, completedStages, commonRules, planContent, stagesByName, } = ctx;
        if (!matched) {
            if (stageConfig.chat) {
                // Chatting stage: read user input and send to container
                const userInput = await readUserInput('\n> ');
                handle.pendingResult = createDeferred();
                sendToStage(handle, userInput);
                return {
                    stageResolved: false,
                    nextStageName: null,
                    nextInitialPrompt: null,
                    stageOutcome: null,
                    lastResult: null,
                };
            }
            // No markers found — retry (autonomous mode)
            logger.warn({ stage: currentStageName, turn: turnCount }, 'No stage markers found');
            handle.pendingResult = createDeferred();
            sendToStage(handle, `No stage markers found in the previous response. Continue working and emit the appropriate marker when done.\n\n${stageConfig.prompt}\n${commonRules}`);
            return {
                stageResolved: false,
                nextStageName: null,
                nextInitialPrompt: null,
                stageOutcome: null,
                lastResult: null,
            };
        }
        const matchedLabel = transitionDisplayName(matched);
        // Synthetic container exit/error — container is dead, must respawn in place.
        if (matched.marker?.startsWith('_CONTAINER')) {
            const errorDesc = payload || matched.marker;
            await this.notify(`⚠️ [Turn ${turnCount}] ${currentStageName} error: ${errorDesc}`);
            if (ctx.containerRespawnCount >= ctx.maxContainerRespawns) {
                await this.notify(`❌ [Turn ${turnCount}] ${currentStageName} container respawn limit exceeded (${ctx.maxContainerRespawns}) — stage failed`);
                return {
                    stageResolved: true,
                    nextStageName: null,
                    nextInitialPrompt: null,
                    stageOutcome: 'error',
                    lastResult: 'error',
                };
            }
            await this.notify(`🔄 [Turn ${turnCount}] ${currentStageName} container respawn (${ctx.containerRespawnCount + 1}/${ctx.maxContainerRespawns})...`);
            return {
                stageResolved: true,
                nextStageName: currentStageName,
                nextInitialPrompt: `The container exited abnormally in the previous attempt: ${errorDesc}\n\nPlease retry.\n\n${stageConfig.prompt}\n${commonRules}${planContent}`,
                stageOutcome: null,
                lastResult: null,
            };
        }
        // Regular transition — move to next stage or end pipeline. When
        // `template` is set, stitch the template into the graph in place and
        // route to its entry/join flow. Otherwise `next` is either a scope-local
        // stage name, null (pipeline end), or a runtime-injected string[] from
        // stitch fan-out.
        let targetName = matched.next ?? null;
        if (matched.template) {
            try {
                const directive = resolveStitchInputs(matched, payload);
                const transitionIdx = stageConfig.transitions.indexOf(matched);
                const downstreamNext = Array.isArray(matched.next)
                    ? (() => {
                        throw new Error('Template transitions cannot carry authored multi-target "next" arrays');
                    })()
                    : (matched.next ?? null);
                const stitched = this.performStitch(stageConfig, transitionIdx, matched.template, downstreamNext, matched.joinPolicy ?? 'all_success', directive);
                for (const s of stitched.insertedStages) {
                    stagesByName.set(s.name, s);
                }
                targetName = stitched.newNext;
                await this.notifyBanner(`🧵 Stitched template "${matched.template}" after ${currentStageName} — inserted ${stitched.insertedStages.length} stage(s)`);
            }
            catch (err) {
                logger.error({ stage: currentStageName, template: matched.template, err }, 'Stitch failed');
                await this.notifyBanner(`❌ ${currentStageName}: stitch of "${matched.template}" failed — ${err.message}`);
                return {
                    stageResolved: true,
                    nextStageName: null,
                    nextInitialPrompt: null,
                    stageOutcome: 'error',
                    lastResult: 'error',
                };
            }
        }
        const targetDisplay = Array.isArray(targetName)
            ? targetName.join(', ')
            : targetName;
        const stageOutcome = transitionOutcome(matched);
        const isErrorTransition = stageOutcome === 'error';
        if (isErrorTransition) {
            await this.notifyBanner(targetDisplay
                ? `⚠️ Warning: ${payload || matchedLabel}\n🔄 Returning to ${targetDisplay}`
                : `⚠️ Warning: ${payload || matchedLabel}`);
        }
        else {
            await this.notifyBanner(targetDisplay
                ? `✅ ${currentStageName} → ${targetDisplay} (${matchedLabel})`
                : `✅ ${currentStageName} completed! (${matchedLabel})`);
        }
        // Track completed stage
        completedStages.push(currentStageName);
        this.manifest.stages.push({
            name: currentStageName,
            status: isErrorTransition ? 'error' : 'success',
            duration: Date.now() - stageStartTime,
        });
        writeRunManifest(this.stateDir, this.manifest);
        this.saveRunnerState({
            currentStage: targetName,
            completedStages,
            lastUpdated: new Date().toISOString(),
            status: 'running',
        });
        // Close the container first, then retrieve session ID
        await this.closeAndWait(handle);
        const containerResult = await handle.containerPromise;
        if (containerResult.newSessionId) {
            this.stageSessionIds.set(currentStageName, containerResult.newSessionId);
        }
        this.activeHandles.delete(currentStageName);
        // Payload forwarding for single-target transitions.
        //   - Target has a resumed session (re-entry) → send payload via ephemeral
        //     system-prompt append so it does NOT persist in the transcript.
        //   - Target is entering fresh → bundle payload into the initial user
        //     prompt like before (no session to pollute).
        let nextInitialPrompt = null;
        let nextEphemeralSystemPrompt = null;
        const targets = PipelineRunner.nextTargets(targetName);
        if (targets.length === 1 && payload) {
            const targetConfig = stagesByName.get(targets[0]);
            const targetRules = targetConfig
                ? this.buildCommonRules(targetConfig)
                : commonRules;
            const isResumedTarget = targetConfig?.resumeSession !== false &&
                this.stageSessionIds.has(targets[0]);
            if (isResumedTarget) {
                nextEphemeralSystemPrompt = `Forwarded from previous stage (${currentStageName}):\n\n${payload}`;
            }
            else {
                nextInitialPrompt = `Forwarded from previous stage (${currentStageName}):\n\n${payload}\n\n${targetConfig?.prompt || ''}\n${targetRules}${planContent}`;
            }
        }
        return {
            stageResolved: true,
            nextStageName: targetName,
            nextInitialPrompt,
            nextEphemeralSystemPrompt,
            stageOutcome,
            // Terminal transition: error-classified transitions (including
            // `afterTimeout`) end the pipeline with 'error'; success-classified
            // transitions end it with 'success'. Non-terminal transitions leave
            // the result undetermined until a later stage decides.
            lastResult: targets.length === 0 ? stageOutcome : null,
        };
    }
    /**
     * Save final pipeline state, close manifest and log stream.
     */
    async finalizeRun(completedStages, lastResult, pipelineLogStream) {
        this.saveRunnerState({
            currentStage: null,
            completedStages,
            lastUpdated: new Date().toISOString(),
            status: lastResult,
        });
        this.manifest.endTime = new Date().toISOString();
        this.manifest.status = lastResult;
        writeRunManifest(this.stateDir, this.manifest);
        pipelineLogStream.write(`\n=== Pipeline ${lastResult === 'success' ? 'completed' : 'failed'}: ${new Date().toISOString()} ===\n`);
        pipelineLogStream.end();
        await this.notifyBanner(lastResult === 'success'
            ? '🏁 Pipeline completed!'
            : '❌ Pipeline terminated with errors.');
    }
    async runJoinStage(stageConfig, completedStages) {
        if (!stageConfig.join) {
            throw new Error(`Stage "${stageConfig.name}" is not a join stage`);
        }
        const stageStartTime = Date.now();
        const stageOutcome = this.evaluateJoinOutcome(stageConfig);
        const nextStages = stageOutcome === 'success'
            ? (stageConfig.transitions[0]?.next ?? null)
            : null;
        const targetDisplay = Array.isArray(nextStages)
            ? nextStages.join(', ')
            : nextStages;
        await this.notifyBanner(stageOutcome === 'success'
            ? targetDisplay
                ? `✅ ${stageConfig.name} → ${targetDisplay} (join:${stageConfig.join.policy})`
                : `✅ ${stageConfig.name} completed! (join:${stageConfig.join.policy})`
            : `❌ ${stageConfig.name} blocked downstream transition (join:${stageConfig.join.policy})`);
        completedStages.push(stageConfig.name);
        this.manifest.stages.push({
            name: stageConfig.name,
            status: stageOutcome,
            duration: Date.now() - stageStartTime,
        });
        writeRunManifest(this.stateDir, this.manifest);
        this.saveRunnerState({
            currentStage: nextStages,
            completedStages,
            lastUpdated: new Date().toISOString(),
            status: 'running',
        });
        return {
            nextStages,
            nextInitialPrompt: null,
            nextEphemeralSystemPrompt: null,
            stageOutcome,
            result: PipelineRunner.nextTargets(nextStages).length === 0
                ? stageOutcome
                : null,
        };
    }
    /**
     * Run a single stage to completion (spawn → turn loop → close).
     * Self-contained: handles retries and container respawns internally.
     */
    async runSingleStage(stageName, stagesByName, completedStages, planContent, pipelineLogStream, initialPromptOverride, ephemeralSystemPromptOverride) {
        const stageConfig = stagesByName.get(stageName);
        if (!stageConfig) {
            logger.error({ stage: stageName }, 'Stage config not found');
            return {
                stageName,
                nextStages: null,
                nextInitialPrompt: null,
                nextEphemeralSystemPrompt: null,
                stageOutcome: 'error',
                result: 'error',
            };
        }
        if (stageConfig.join) {
            const joined = await this.runJoinStage(stageConfig, completedStages);
            return {
                stageName,
                ...joined,
            };
        }
        // Exclusive lock: wait for shared resource
        let exclusiveLock = null;
        if (stageConfig.exclusive) {
            exclusiveLock = getExclusiveLock(stageConfig.exclusive);
            logger.info({ stage: stageName, key: stageConfig.exclusive }, 'Waiting for exclusive lock');
            await this.notify(`🔒 ${stageName}: waiting (${stageConfig.exclusive} lock)...`);
            await exclusiveLock.acquire();
            logger.info({ stage: stageName, key: stageConfig.exclusive }, 'Exclusive lock acquired');
        }
        let nextStages = null;
        let stageOutcome = null;
        let stageResult = null;
        let outNextInitialPrompt = null;
        let outNextEphemeralSystemPrompt = null;
        try {
            const commonRules = this.buildCommonRules(stageConfig);
            let nextInitialPrompt = initialPromptOverride ?? null;
            // Ephemeral system-prompt append consumed only by the next spawn in this stage.
            // Used when re-entering a resumed stage with a handoff payload from a predecessor.
            let nextEphemeralSystemPrompt = ephemeralSystemPromptOverride ?? null;
            let containerRespawnCount = 0;
            const MAX_CONTAINER_RESPAWNS = 3;
            let turnCount = 0;
            let currentStage = stageName;
            while (currentStage === stageName) {
                if (this.aborted) {
                    stageOutcome = 'error';
                    stageResult = 'error';
                    break;
                }
                const resolvedStagePrompt = resolveStagePrompt(stageConfig);
                const initialPrompt = nextInitialPrompt ||
                    `${resolvedStagePrompt.text}\n${commonRules}${planContent}`;
                nextInitialPrompt = null;
                const ephemeralForSpawn = nextEphemeralSystemPrompt ?? undefined;
                nextEphemeralSystemPrompt = null;
                const stageStartTime = Date.now();
                const handle = this.spawnStageContainer(stageConfig, initialPrompt, pipelineLogStream, ephemeralForSpawn);
                this.activeHandles.set(stageName, handle);
                logger.info({
                    stage: stageName,
                    promptIds: resolvedStagePrompt.promptIds,
                    promptHash: resolvedStagePrompt.promptHash,
                }, 'Stage container spawned (on-demand)');
                logger.info({ stage: stageName }, 'Entering stage');
                await this.notifyBanner(`📌 Stage: ${stageName} starting`);
                let isFirstTurn = true;
                let stageResolved = false;
                while (!stageResolved) {
                    turnCount++;
                    if (!handle.pendingResult) {
                        handle.pendingResult = createDeferred();
                    }
                    if (!isFirstTurn) {
                        const prompt = `${resolvedStagePrompt.text}\n${commonRules}${planContent}`;
                        sendToStage(handle, prompt);
                    }
                    isFirstTurn = false;
                    logger.debug({ stage: stageName, turn: turnCount }, 'Waiting for stage result');
                    await this.notify(`🔧 [Turn ${turnCount}] ${stageName} in progress...`);
                    const result = await handle.pendingResult.promise;
                    handle.pendingResult = null;
                    logger.info({ stage: stageName, turn: turnCount, result }, 'Stage result received');
                    const outcome = await this.handleStageResult(result, {
                        handle,
                        stageConfig,
                        currentStageName: stageName,
                        turnCount,
                        stageStartTime,
                        completedStages,
                        commonRules,
                        planContent,
                        stagesByName,
                        containerRespawnCount,
                        maxContainerRespawns: MAX_CONTAINER_RESPAWNS,
                    });
                    stageResolved = outcome.stageResolved;
                    if (outcome.stageResolved) {
                        if (outcome.nextStageName === stageName) {
                            // Container respawn — loop again with same stage
                            containerRespawnCount++;
                            nextInitialPrompt = outcome.nextInitialPrompt;
                            nextEphemeralSystemPrompt =
                                outcome.nextEphemeralSystemPrompt ?? null;
                            currentStage = stageName; // stay in outer while
                        }
                        else {
                            // Advance to next stage(s) or end
                            nextStages = outcome.nextStageName;
                            outNextInitialPrompt = outcome.nextInitialPrompt;
                            outNextEphemeralSystemPrompt =
                                outcome.nextEphemeralSystemPrompt ?? null;
                            stageOutcome = outcome.stageOutcome;
                            currentStage = null; // exit outer while
                            if (outcome.lastResult) {
                                stageResult = outcome.lastResult;
                            }
                        }
                    }
                }
            }
        }
        finally {
            this.activeHandles.delete(stageName);
            if (exclusiveLock) {
                exclusiveLock.release();
                logger.info({ stage: stageName, key: stageConfig.exclusive }, 'Exclusive lock released');
            }
        }
        return {
            stageName,
            nextStages,
            nextInitialPrompt: outNextInitialPrompt,
            nextEphemeralSystemPrompt: outNextEphemeralSystemPrompt,
            stageOutcome,
            result: stageResult,
        };
    }
    /**
     * Main FSM loop with fan-out/fan-in support.
     * Spawns stage containers on-demand, runs parallel stages concurrently,
     * and gates fan-in stages until all predecessors complete.
     */
    async run() {
        const init = await this.initRun();
        if (!init)
            return 'error';
        const { planContent, stagesByName, pipelineLogStream } = init;
        const { initialStages, completedStages } = await this.resolveEntryStage(stagesByName);
        // Track activations for initial stages
        for (const name of initialStages) {
            this.activations.set(name, (this.activations.get(name) ?? 0) + 1);
        }
        this.saveRunnerState({
            currentStage: initialStages.length === 1 ? initialStages[0] : initialStages,
            completedStages,
            lastUpdated: new Date().toISOString(),
            status: 'running',
        });
        // `predecessors` is recomputed per-call below — stitch may add stages at
        // runtime, so a snapshot taken at run-start would miss join-adjacent
        // stage edges from later stitches.
        // Each entry: { name, initialPrompt, ephemeralSystemPrompt }
        // — set when payload forwarding applies (initialPrompt for fresh entries,
        //   ephemeralSystemPrompt for re-entry into a resumed stage).
        let pendingStages = initialStages.map((name) => ({ name }));
        const waitingForFanIn = new Set();
        let lastResult = 'success';
        const resultQueue = [];
        let notifyResolve = null;
        const running = new Set();
        const runningNames = new Set();
        const waitForResult = () => {
            if (resultQueue.length > 0)
                return Promise.resolve();
            return new Promise((r) => {
                notifyResolve = r;
            });
        };
        const signalResult = () => {
            if (notifyResolve) {
                const r = notifyResolve;
                notifyResolve = null;
                r();
            }
        };
        const launchStage = (entry) => {
            runningNames.add(entry.name);
            const p = this.runSingleStage(entry.name, stagesByName, completedStages, planContent, pipelineLogStream, entry.initialPrompt, entry.ephemeralSystemPrompt)
                .then((result) => {
                resultQueue.push(result);
                running.delete(p);
                runningNames.delete(result.stageName);
                signalResult();
            })
                .catch((err) => {
                logger.error({ stage: entry.name, err }, 'Stage threw unexpectedly');
                resultQueue.push({
                    stageName: entry.name,
                    nextStages: null,
                    nextInitialPrompt: null,
                    nextEphemeralSystemPrompt: null,
                    stageOutcome: 'error',
                    result: 'error',
                });
                running.delete(p);
                runningNames.delete(entry.name);
                signalResult();
            });
            running.add(p);
        };
        // Helper: check readiness for a gated stage. Runtime-generated join stages
        // use persisted settlement accounting; authored fan_in stages still use
        // predecessor-based gating.
        const isStageReady = (stageName) => {
            const stage = stagesByName.get(stageName);
            if (stage?.join) {
                return this.isJoinReady(stageName);
            }
            const predecessors = this.buildPredecessorMap();
            return PipelineRunner.fanInReady(stageName, predecessors, completedStages);
        };
        // Helper: launch a stage, deferring chat stages if pool is busy
        const tryLaunch = (entry) => {
            const cfg = stagesByName.get(entry.name);
            if (cfg?.chat && running.size > 0) {
                // Chat stages need exclusive stdin — defer until pool drains
                pendingStages.push(entry);
                return;
            }
            launchStage(entry);
        };
        // Launch initial stages (gate fan-in/join stages that aren't ready yet)
        for (const entry of pendingStages) {
            if (isStageReady(entry.name)) {
                tryLaunch(entry);
            }
            else {
                waitingForFanIn.add(entry.name);
            }
        }
        pendingStages = [];
        while (running.size > 0 ||
            waitingForFanIn.size > 0 ||
            pendingStages.length > 0) {
            if (this.aborted)
                break;
            // Launch any deferred pending stages (e.g. chat stages waiting for pool to drain)
            if (pendingStages.length > 0 && running.size === 0) {
                const deferred = [...pendingStages];
                pendingStages = [];
                for (const entry of deferred) {
                    tryLaunch(entry);
                }
            }
            // Stuck detection: nothing running, nothing queued, only fan-in waiting
            if (running.size === 0 &&
                resultQueue.length === 0 &&
                pendingStages.length === 0) {
                if (waitingForFanIn.size > 0) {
                    logger.warn({ waiting: [...waitingForFanIn] }, 'Fan-in stages stuck — predecessors did not complete');
                    lastResult = 'error';
                }
                break;
            }
            // Save current active stages
            const activeNames = [...runningNames];
            this.saveRunnerState({
                currentStage: activeNames.length === 1 ? activeNames[0] : activeNames,
                completedStages,
                lastUpdated: new Date().toISOString(),
                status: 'running',
            });
            // Wait for at least one stage to complete
            await waitForResult();
            // Drain all available results and launch ready successors immediately
            while (resultQueue.length > 0) {
                const { stageName: finishedStage, nextStages, nextInitialPrompt, nextEphemeralSystemPrompt, stageOutcome, result, } = resultQueue.shift();
                if (result === 'error')
                    lastResult = 'error';
                // Track completion for dynamic fan-in
                this.completions.set(finishedStage, (this.completions.get(finishedStage) ?? 0) + 1);
                const targets = PipelineRunner.nextTargets(nextStages);
                for (const target of targets) {
                    const targetConfig = stagesByName.get(target);
                    if (targetConfig?.join) {
                        this.recordJoinSettlement(target, finishedStage, stageOutcome);
                    }
                    // Skip if already running, queued, or waiting for fan-in
                    if (runningNames.has(target) ||
                        pendingStages.some((s) => s.name === target) ||
                        waitingForFanIn.has(target)) {
                        continue;
                    }
                    // Track activation for dynamic fan-in (only when actually queued, not deduped)
                    this.activations.set(target, (this.activations.get(target) ?? 0) + 1);
                    if (isStageReady(target)) {
                        tryLaunch({
                            name: target,
                            initialPrompt: targets.length === 1 ? nextInitialPrompt : null,
                            ephemeralSystemPrompt: targets.length === 1 ? nextEphemeralSystemPrompt : null,
                        });
                    }
                    else {
                        waitingForFanIn.add(target);
                    }
                }
            }
            // Re-check fan-in gates — a newly completed stage may have unblocked waiters
            for (const w of [...waitingForFanIn]) {
                if (isStageReady(w)) {
                    waitingForFanIn.delete(w);
                    tryLaunch({ name: w });
                }
            }
        }
        await this.finalizeRun(completedStages, lastResult, pipelineLogStream);
        return lastResult;
    }
}
/**
 * Load and validate a pipeline config.
 * @param pipelinePath - Absolute path to a pipeline JSON file. When provided,
 *   groupFolder/groupDir are ignored and the file is loaded directly.
 * Bundle-relative assets (agents/, templates/) resolve from the directory
 * containing the pipeline file (bundleDir).
 * Returns null if the file doesn't exist.
 */
export function loadPipelineConfig(groupFolder, groupDir, pipelinePath) {
    const dir = groupDir ?? resolveGroupFolderPath(groupFolder);
    if (!pipelinePath) {
        pipelinePath = path.join(dir, 'PIPELINE.json');
    }
    const bundleDir = path.dirname(pipelinePath);
    if (!fs.existsSync(pipelinePath)) {
        return null;
    }
    try {
        const raw = fs.readFileSync(pipelinePath, 'utf-8');
        const config = JSON.parse(raw);
        let mcpRegistry;
        // Resolve agent refs (agents/*.md) relative to bundle dir
        if (Array.isArray(config.stages)) {
            resolveAgentRefs(config.stages, bundleDir);
        }
        // Basic validation
        if (!Array.isArray(config.stages) || config.stages.length === 0) {
            logger.warn({ groupFolder }, 'PIPELINE.json has no stages');
            return null;
        }
        // Validate stage names and transitions
        const stageNames = new Set(config.stages.map((s) => s.name));
        for (const stage of config.stages) {
            const isCommandStage = typeof stage.command === 'string';
            if (stage.kind !== undefined &&
                stage.kind !== 'agent' &&
                stage.kind !== 'command') {
                logger.error({ groupFolder, stage: stage.name, kind: stage.kind }, 'Invalid stage kind (must be "agent" or "command")');
                return null;
            }
            if (stage.prompts !== undefined &&
                (!Array.isArray(stage.prompts) ||
                    stage.prompts.some((promptId) => typeof promptId !== 'string'))) {
                logger.error({ groupFolder, stage: stage.name, prompts: stage.prompts }, 'Invalid prompts field (must be an array of prompt DB ids)');
                return null;
            }
            if (stage.prompt_append !== undefined &&
                typeof stage.prompt_append !== 'string') {
                logger.error({
                    groupFolder,
                    stage: stage.name,
                    prompt_append: stage.prompt_append,
                }, 'Invalid prompt_append field (must be a string)');
                return null;
            }
            if (stage.prompt !== undefined && typeof stage.prompt !== 'string') {
                logger.error({ groupFolder, stage: stage.name, prompt: stage.prompt }, 'Invalid prompt field (must be a string)');
                return null;
            }
            if (stage.timeout !== undefined) {
                if (!Number.isFinite(stage.timeout) || stage.timeout <= 0) {
                    logger.error({ groupFolder, stage: stage.name, timeout: stage.timeout }, 'Invalid timeout field (must be a positive number of milliseconds)');
                    return null;
                }
                if (!isCommandStage) {
                    logger.error({ groupFolder, stage: stage.name }, 'Stage "timeout" is only supported for command stages');
                    return null;
                }
            }
            if (stage.mcpAccess !== undefined &&
                (!Array.isArray(stage.mcpAccess) ||
                    stage.mcpAccess.some((ref) => typeof ref !== 'string'))) {
                logger.error({ groupFolder, stage: stage.name, mcpAccess: stage.mcpAccess }, 'Invalid mcpAccess field (must be an array of registry ref strings)');
                return null;
            }
            if (!stage.command &&
                !stage.prompt &&
                !stage.prompt_append &&
                (!stage.prompts || stage.prompts.length === 0)) {
                logger.error({ groupFolder, stage: stage.name }, 'Agent stage must define prompt, prompts, or prompt_append');
                return null;
            }
            if (isCommandStage && stage.mcpAccess && stage.mcpAccess.length > 0) {
                logger.error({ groupFolder, stage: stage.name }, 'Command stages cannot declare mcpAccess');
                return null;
            }
            if (stage.mcpAccess && stage.mcpAccess.length > 0) {
                try {
                    mcpRegistry ??= loadMcpRegistry();
                    resolveStageMcpServers(stage.mcpAccess, { registry: mcpRegistry });
                }
                catch (err) {
                    logger.error({ groupFolder, stage: stage.name, err }, 'Invalid mcpAccess configuration');
                    return null;
                }
            }
            if (stage.fan_in !== undefined && stage.fan_in !== 'all') {
                logger.error({ groupFolder, stage: stage.name, fan_in: stage.fan_in }, 'Invalid fan_in value (must be "all")');
                return null;
            }
            if (stage.join !== undefined) {
                logger.error({ groupFolder, stage: stage.name }, 'Runtime "join" metadata cannot be authored in PIPELINE.json');
                return null;
            }
            let afterTimeoutTransitions = 0;
            for (const t of stage.transitions) {
                const tAny = t;
                const transitionName = t.afterTimeout
                    ? 'afterTimeout'
                    : (t.marker ?? '<missing-marker>');
                if (tAny.retry !== undefined) {
                    logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "retry" is no longer supported');
                    return null;
                }
                if (tAny.next_dynamic !== undefined) {
                    logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "next_dynamic" is no longer supported');
                    return null;
                }
                if (t.afterTimeout !== undefined &&
                    typeof t.afterTimeout !== 'boolean') {
                    logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "afterTimeout" must be a boolean');
                    return null;
                }
                if (t.afterTimeout) {
                    afterTimeoutTransitions++;
                    if (!isCommandStage) {
                        logger.error({ groupFolder, stage: stage.name }, 'Transition "afterTimeout" is only supported for command stages');
                        return null;
                    }
                    if (t.marker !== undefined) {
                        logger.error({ groupFolder, stage: stage.name, marker: t.marker }, 'Transition "afterTimeout" cannot be combined with "marker"');
                        return null;
                    }
                    if (t.countFrom !== undefined || t.substitutionsFrom !== undefined) {
                        logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "afterTimeout" does not support payload-driven fanout fields');
                        return null;
                    }
                }
                else if (typeof t.marker !== 'string' || t.marker.length === 0) {
                    logger.error({ groupFolder, stage: stage.name }, 'Transition "marker" is required unless "afterTimeout" is true');
                    return null;
                }
                if (Array.isArray(t.next)) {
                    logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "next" must be a string or null — multi-target arrays are produced only by parallel stitch at runtime');
                    return null;
                }
                if (!Object.prototype.hasOwnProperty.call(tAny, 'next')) {
                    logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "next" is required (use null to end the current scope)');
                    return null;
                }
                if (t.next !== null && typeof t.next !== 'string') {
                    logger.error({
                        groupFolder,
                        stage: stage.name,
                        marker: transitionName,
                        next: t.next,
                    }, 'Transition "next" must be a string or null');
                    return null;
                }
                const hasNextString = typeof t.next === 'string';
                const hasTemplate = t.template !== undefined;
                if (hasTemplate) {
                    if (typeof t.template !== 'string' || t.template.length === 0) {
                        logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "template" must be a non-empty string');
                        return null;
                    }
                }
                if (t.count !== undefined) {
                    if (!Number.isInteger(t.count) || t.count < 1) {
                        logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "count" must be a positive integer');
                        return null;
                    }
                    if (!hasTemplate) {
                        logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "count" requires "template"');
                        return null;
                    }
                }
                if (t.countFrom !== undefined) {
                    if (t.countFrom !== 'payload') {
                        logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "countFrom" only accepts "payload"');
                        return null;
                    }
                    if (!hasTemplate) {
                        logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "countFrom" requires "template"');
                        return null;
                    }
                    if (t.count !== undefined) {
                        logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition must have either "count" or "countFrom", not both');
                        return null;
                    }
                }
                if (t.substitutionsFrom !== undefined) {
                    if (t.substitutionsFrom !== 'payload') {
                        logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "substitutionsFrom" only accepts "payload"');
                        return null;
                    }
                    if (t.countFrom !== 'payload') {
                        logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "substitutionsFrom" requires "countFrom: \\"payload\\""');
                        return null;
                    }
                }
                if (t.joinPolicy !== undefined) {
                    if (t.joinPolicy !== 'all_success' &&
                        t.joinPolicy !== 'any_success' &&
                        t.joinPolicy !== 'all_settled') {
                        logger.error({
                            groupFolder,
                            stage: stage.name,
                            marker: transitionName,
                            joinPolicy: t.joinPolicy,
                        }, 'Transition "joinPolicy" must be one of "all_success", "any_success", or "all_settled"');
                        return null;
                    }
                    if (!hasTemplate) {
                        logger.error({ groupFolder, stage: stage.name, marker: transitionName }, 'Transition "joinPolicy" requires "template"');
                        return null;
                    }
                }
                if (t.outcome !== undefined &&
                    t.outcome !== 'success' &&
                    t.outcome !== 'error') {
                    logger.error({
                        groupFolder,
                        stage: stage.name,
                        marker: transitionName,
                        outcome: t.outcome,
                    }, 'Transition "outcome" must be "success" or "error"');
                    return null;
                }
                if (hasNextString && !stageNames.has(t.next)) {
                    logger.error({ groupFolder, stage: stage.name, target: t.next }, 'Transition "next" must reference an existing stage in this pipeline');
                    return null;
                }
            }
            if (afterTimeoutTransitions > 1) {
                logger.error({ groupFolder, stage: stage.name }, 'At most one transition may declare "afterTimeout: true"');
                return null;
            }
        }
        try {
            assertConfigAcyclic(config);
        }
        catch (err) {
            logger.error({ groupFolder, err: err.message }, 'PIPELINE.json contains a cycle — pipelines must be DAGs');
            return null;
        }
        return config;
    }
    catch (err) {
        logger.error({ groupFolder, err }, 'Failed to parse PIPELINE.json');
        return null;
    }
}
//# sourceMappingURL=pipeline-runner.js.map