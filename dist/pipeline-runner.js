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
import { spawn } from 'child_process';
import { CONTAINER_IMAGE, DATA_DIR } from './config.js';
import { buildContainerArgs, runContainerAgent, } from './container-runner.js';
import { getRuntime } from './container-runtime.js';
import { getImageForStage } from './image-registry.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
// --- Run ID + Manifest ---
export function generateRunId() {
    return `run-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}
function runsDir(groupDir) {
    return path.join(groupDir, 'runs');
}
export function writeCurrentRun(groupDir, info) {
    const dir = runsDir(groupDir);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = path.join(dir, '_current.json.tmp');
    const filePath = path.join(dir, '_current.json');
    fs.writeFileSync(tmpPath, JSON.stringify(info, null, 2));
    fs.renameSync(tmpPath, filePath);
}
export function readCurrentRun(groupDir) {
    try {
        const raw = fs.readFileSync(path.join(runsDir(groupDir), '_current.json'), 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
export function removeCurrentRun(groupDir) {
    try {
        fs.unlinkSync(path.join(runsDir(groupDir), '_current.json'));
    }
    catch {
        /* file may not exist */
    }
}
export function writeRunManifest(groupDir, manifest) {
    const dir = runsDir(groupDir);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${manifest.runId}.json`);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2));
    fs.renameSync(tmpPath, filePath);
}
export function readRunManifest(groupDir, runId) {
    try {
        const raw = fs.readFileSync(path.join(runsDir(groupDir), `${runId}.json`), 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
export function listRunManifests(groupDir) {
    const dir = runsDir(groupDir);
    if (!fs.existsSync(dir))
        return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.startsWith('run-') && f.endsWith('.json'))
        .sort()
        .reverse()
        .map((f) => {
        try {
            return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        }
        catch {
            return null;
        }
    })
        .filter((m) => m !== null);
}
/**
 * Check if a PID is alive.
 */
export function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
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
export function savePipelineState(groupDir, state) {
    const filepath = path.join(groupDir, PIPELINE_STATE_FILE);
    atomicWrite(filepath, JSON.stringify(state, null, 2));
}
export function loadPipelineState(groupDir) {
    const filepath = path.join(groupDir, PIPELINE_STATE_FILE);
    try {
        const raw = fs.readFileSync(filepath, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
/**
 * Parse stage markers dynamically from the stage's transitions array.
 * Matches `[MARKER]` or `[MARKER: payload]` patterns, first match wins.
 */
export function parseStageMarkers(resultTexts, transitions) {
    const combined = resultTexts.join('\n');
    for (const transition of transitions) {
        // Match [MARKER] or [MARKER: payload]
        const regex = new RegExp(`\\[${escapeRegExp(transition.marker)}(?::\\s*(.+?))?\\]`);
        const match = regex.exec(combined);
        if (match) {
            return { matched: transition, payload: match[1] ?? null };
        }
    }
    return { matched: null, payload: null };
}
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function normalizeError(desc) {
    return desc.trim().toLowerCase().replace(/\s+/g, ' ');
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
    runId;
    manifest;
    aborted = false;
    currentHandle = null;
    constructor(group, chatJid, pipelineConfig, notify, onProcess, groupDir, runId) {
        this.group = group;
        this.chatJid = chatJid;
        this.config = pipelineConfig;
        this.notify = notify;
        this.onProcess = onProcess;
        this.groupDir = groupDir ?? resolveGroupFolderPath(this.group.folder);
        this.runId = runId ?? generateRunId();
        this.manifest = {
            runId: this.runId,
            pid: process.pid,
            startTime: new Date().toISOString(),
            status: 'running',
            stages: [],
        };
    }
    getRunId() {
        return this.runId;
    }
    async abort() {
        this.aborted = true;
        if (this.currentHandle) {
            await this.closeAndWait(this.currentHandle);
        }
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
     * Build internal mounts for a stage based on its mount policy.
     * Returns absolute container paths under /workspace/group/ for direct overlay.
     */
    pipelineStageMounts(stageConfig) {
        const groupDir = this.groupDir;
        const mounts = [];
        for (const [key, policy] of Object.entries(stageConfig.mounts)) {
            if (key === 'project' || key.startsWith('project:'))
                continue; // handled separately
            if (!policy)
                continue;
            const hostDir = path.join(groupDir, key);
            fs.mkdirSync(hostDir, { recursive: true });
            mounts.push({
                hostPath: hostDir,
                containerPath: `/workspace/group/${key}`,
                readonly: policy === 'ro',
            });
        }
        return mounts;
    }
    /**
     * Spawn a stage container as a virtual sub-group.
     * The container starts with an initial prompt and enters the IPC wait loop.
     */
    spawnStageContainer(stageConfig, initialPrompt, logStream) {
        const subFolder = `${this.group.folder}__pipeline_${stageConfig.name}`;
        // Stage workspace nested inside parent group dir
        const stageWorkspaceDir = path.join(this.groupDir, stageConfig.name);
        fs.mkdirSync(stageWorkspaceDir, { recursive: true });
        // Write CLAUDE.md in the nested stage workspace
        fs.writeFileSync(path.join(stageWorkspaceDir, 'CLAUDE.md'), `# Pipeline Stage: ${stageConfig.name}\n\nYou are the ${stageConfig.name} agent in an automated pipeline. Follow instructions precisely and use the correct stage markers.\n`);
        // Build internal mounts (project dirs mounted under /workspace/group/)
        const internalMounts = this.pipelineStageMounts(stageConfig);
        // Mount project directory (parent of __art__/) based on config
        const projectPolicy = stageConfig.mounts['project'];
        const effectivePolicy = projectPolicy === undefined ? 'ro' : projectPolicy;
        if (effectivePolicy) {
            internalMounts.push({
                hostPath: path.dirname(this.groupDir),
                containerPath: '/workspace/project',
                readonly: effectivePolicy === 'ro',
            });
            // Shadow __art__/ with empty dir so agents can't see pipeline internals
            const emptyDir = path.join(DATA_DIR, 'empty');
            fs.mkdirSync(emptyDir, { recursive: true });
            const artDirName = path.basename(this.groupDir);
            internalMounts.push({
                hostPath: emptyDir,
                containerPath: `/workspace/project/${artDirName}`,
                readonly: true,
            });
            // Process project:* sub-mount overrides
            const projectRoot = path.dirname(this.groupDir);
            for (const [key, subPolicy] of Object.entries(stageConfig.mounts)) {
                if (!key.startsWith('project:'))
                    continue;
                const subPath = key.slice('project:'.length);
                // Skip __art__/ paths (already shadowed above)
                if (subPath === artDirName || subPath.startsWith(artDirName + '/'))
                    continue;
                if (subPolicy === null) {
                    // Disabled → shadow with empty dir
                    internalMounts.push({
                        hostPath: emptyDir,
                        containerPath: `/workspace/project/${subPath}`,
                        readonly: true,
                    });
                }
                else if (subPolicy && subPolicy !== effectivePolicy) {
                    // Different permission from root → overlay mount
                    const subHostPath = path.join(projectRoot, subPath);
                    internalMounts.push({
                        hostPath: subHostPath,
                        containerPath: `/workspace/project/${subPath}`,
                        readonly: subPolicy === 'ro',
                    });
                }
                // Same permission as root → inherited, no extra mount needed
            }
        }
        // Resolve container image from registry (agent mode only)
        let resolvedImage;
        if (!stageConfig.command) {
            resolvedImage = getImageForStage(stageConfig.image, false);
        }
        // Parent's additional mounts stay in additionalMounts (security-validated)
        const parentMounts = this.group.containerConfig?.additionalMounts || [];
        const virtualGroup = {
            name: `pipeline-${stageConfig.name}`,
            folder: subFolder, // Flat folder for IPC/sessions
            trigger: '',
            added_at: new Date().toISOString(),
            containerConfig: {
                image: resolvedImage,
                additionalMounts: parentMounts,
                additionalDevices: stageConfig.devices || [],
                runAsRoot: stageConfig.runAsRoot === true,
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
            pendingResult: null,
            resultTexts: [],
        };
        // Create onOutput callback that resolves the pending deferred
        const onOutput = async (output) => {
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
            // Stream agent output to TUI so user can see progress
            if (process.env.ART_TUI_MODE) {
                const lines = output.result.split('\n');
                const summary = lines.length > 3
                    ? lines.slice(0, 3).join('\n') +
                        `\n... (${lines.length - 3} more lines)`
                    : output.result;
                await this.notify(`[${stageConfig.name}] ${summary}`);
            }
            const markers = parseStageMarkers(handle.resultTexts, stageConfig.transitions);
            if (markers.matched) {
                if (handle.pendingResult) {
                    handle.pendingResult.resolve(markers);
                    handle.pendingResult = null;
                }
                handle.resultTexts = [];
            }
        };
        if (stageConfig.command) {
            // Command mode: run shell command, no agent
            handle.containerPromise = this.runStageCommand(stageConfig, handle, logStream);
        }
        else {
            // Agent mode: spawn the container (don't await — it runs in background)
            handle.containerPromise = runContainerAgent(virtualGroup, {
                prompt: initialPrompt,
                groupFolder: subFolder,
                chatJid: this.chatJid,
                isMain: false,
                assistantName: `pipeline-${stageConfig.name}`,
                runId: this.runId,
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
                            retry: true,
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
                        retry: true,
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
        const internalMounts = this.pipelineStageMounts(stageConfig);
        // Mount project directory based on config
        const projectPolicy = stageConfig.mounts['project'];
        const effectivePolicy = projectPolicy === undefined ? 'ro' : projectPolicy;
        if (effectivePolicy) {
            internalMounts.push({
                hostPath: path.dirname(this.groupDir),
                containerPath: '/workspace/project',
                readonly: effectivePolicy === 'ro',
            });
            // Shadow __art__/ with empty dir so commands can't see pipeline internals
            const emptyDir = path.join(DATA_DIR, 'empty');
            fs.mkdirSync(emptyDir, { recursive: true });
            const artDirName = path.basename(this.groupDir);
            internalMounts.push({
                hostPath: emptyDir,
                containerPath: `/workspace/project/${artDirName}`,
                readonly: true,
            });
        }
        const safeName = stageConfig.name.replace(/[^a-zA-Z0-9-]/g, '-');
        const containerName = `aer-art-cmd-${safeName}-${Date.now()}`;
        const image = stageConfig.image || CONTAINER_IMAGE;
        const devices = stageConfig.devices || [];
        const runAsRoot = stageConfig.runAsRoot === true;
        const containerArgs = buildContainerArgs(internalMounts, containerName, devices, runAsRoot, image, 'sh', this.runId);
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
            container.stdout.on('data', (data) => {
                const chunk = data.toString();
                stdout += chunk;
                if (logStream)
                    logStream.write(chunk);
                // Stream output to TUI
                if (process.env.ART_TUI_MODE) {
                    const trimmed = chunk.trim();
                    if (trimmed) {
                        this.notify(`[${stageConfig.name}] ${trimmed}`).catch(() => { });
                    }
                }
            });
            container.stderr.on('data', (data) => {
                const chunk = data.toString();
                stderr += chunk;
                if (logStream)
                    logStream.write(`[stderr] ${chunk}`);
            });
            const configTimeout = this.group.containerConfig?.timeout || 1800000; // 30 min default for commands
            let timedOut = false;
            const timeout = setTimeout(() => {
                timedOut = true;
                container.kill('SIGTERM');
                setTimeout(() => container.kill('SIGKILL'), 15000);
            }, configTimeout);
            container.on('close', (code) => {
                clearTimeout(timeout);
                if (logStream) {
                    logStream.write(`\n=== Command Stage ${stageConfig.name} exited: code=${code} ===\n`);
                }
                if (timedOut) {
                    if (handle.pendingResult) {
                        handle.pendingResult.resolve({
                            matched: {
                                marker: '_CONTAINER_TIMEOUT',
                                retry: true,
                                prompt: 'Command timed out',
                            },
                            payload: 'Command timed out',
                        });
                        handle.pendingResult = null;
                    }
                    resolve({
                        status: 'error',
                        result: null,
                        error: `Command timed out after ${configTimeout}ms`,
                    });
                    return;
                }
                // Parse markers from stdout
                const markerResult = parseStageMarkers([stdout], stageConfig.transitions);
                if (handle.pendingResult) {
                    if (markerResult.matched) {
                        handle.pendingResult.resolve(markerResult);
                    }
                    else if (code !== 0) {
                        handle.pendingResult.resolve({
                            matched: {
                                marker: '_COMMAND_FAILED',
                                retry: true,
                                prompt: 'Command failed',
                            },
                            payload: `Exit code ${code}: ${stderr.slice(-500)}`,
                        });
                    }
                    else {
                        // Exited 0 but no markers found
                        handle.pendingResult.resolve({
                            matched: null,
                            payload: null,
                        });
                    }
                    handle.pendingResult = null;
                }
                resolve({
                    status: code === 0 ? 'success' : 'error',
                    result: stdout,
                    error: code !== 0 ? `Command exited with code ${code}` : undefined,
                });
            });
            container.on('error', (err) => {
                clearTimeout(timeout);
                if (handle.pendingResult) {
                    handle.pendingResult.resolve({
                        matched: {
                            marker: '_CONTAINER_ERROR',
                            retry: true,
                            prompt: 'Container spawn error',
                        },
                        payload: err.message,
                    });
                    handle.pendingResult = null;
                }
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
     * Main FSM loop. Spawns each stage container on-demand and closes it when leaving.
     */
    async run() {
        const planPath = path.join(this.groupDir, 'plan', 'PLAN.md');
        if (!fs.existsSync(planPath)) {
            await this.notify('⚠️ PLAN.md가 없습니다. 먼저 구현 계획을 작성해주세요.');
            return 'error';
        }
        // Write _current.json and initial manifest
        writeCurrentRun(this.groupDir, {
            runId: this.runId,
            pid: process.pid,
            startTime: this.manifest.startTime,
        });
        writeRunManifest(this.groupDir, this.manifest);
        const planContent = fs.readFileSync(planPath, 'utf-8');
        logger.info({
            group: this.group.name,
            runId: this.runId,
            planLen: planContent.length,
            stageCount: this.config.stages.length,
        }, 'Pipeline starting');
        const stageNames = this.config.stages.map((s) => s.name).join(' → ');
        await this.notifyBanner(`🚀 파이프라인 시작. 스테이지: ${stageNames}`);
        // Pipeline-wide log file: all stage container output in one file
        const logsDir = path.join(this.groupDir, 'logs');
        fs.mkdirSync(logsDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const pipelineLogFile = path.join(logsDir, `pipeline-${ts}.log`);
        this.manifest.logFile = `logs/pipeline-${ts}.log`;
        writeRunManifest(this.groupDir, this.manifest);
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
        /**
         * Build commonRules dynamically from a stage's transitions.
         */
        function buildCommonRules(stageConfig) {
            const markerLines = stageConfig.transitions.map((t) => {
                const desc = t.prompt || t.marker;
                if (t.retry) {
                    return `- ${desc} → [${t.marker}: brief description]`;
                }
                return `- ${desc} → [${t.marker}]`;
            });
            return `
RULES:
- Do NOT ask questions. Always assume "yes" and proceed autonomously.
- Read files before editing. Use tools freely.
- Do not stop until this stage is complete or you hit a blocking error.
- 프로젝트 소스는 /workspace/project/ 에서 읽기 전용으로 볼 수 있다.
- 스테이지 작업 디렉토리는 /workspace/group/ 아래에 마운트되어 있다 (plan/, src/, tb/, build/, sim/ 등). 반드시 이 경로에서 파일을 읽고 작업하라.

STAGE MARKERS — use the correct one:
${markerLines.join('\n')}`;
        }
        // FSM loop — spawn each stage on-demand
        let currentStageName;
        let completedStages;
        let nextInitialPrompt = null; // Set by code-error transitions
        let turnCount = 0;
        let lastResult = 'success';
        // Determine entry stage: explicit > heuristic (prefer nodes with outgoing edges) > stages[0]
        const resolveEntry = () => {
            if (this.config.entryStage && stagesByName.has(this.config.entryStage)) {
                return this.config.entryStage;
            }
            // Heuristic: prefer stages with outgoing non-retry transitions that aren't dead-ends
            const hasIncoming = new Set();
            const hasOutgoing = new Set();
            for (const s of this.config.stages) {
                for (const t of s.transitions) {
                    if (!t.retry && t.next) {
                        hasOutgoing.add(s.name);
                        hasIncoming.add(t.next);
                    }
                }
            }
            const preferred = this.config.stages.find((s) => !hasIncoming.has(s.name) && hasOutgoing.has(s.name));
            if (preferred)
                return preferred.name;
            const fallback = this.config.stages.find((s) => !hasIncoming.has(s.name));
            if (fallback)
                return fallback.name;
            const loopFallback = this.config.stages.find((s) => hasOutgoing.has(s.name));
            if (loopFallback)
                return loopFallback.name;
            return this.config.stages[0].name;
        };
        // Resume from last completed stage if pipeline was interrupted
        const existingState = loadPipelineState(this.groupDir);
        if (existingState &&
            existingState.status !== 'success' &&
            existingState.completedStages.length > 0) {
            const lastCompleted = existingState.completedStages[existingState.completedStages.length - 1];
            const lastConfig = stagesByName.get(lastCompleted);
            const completeTransition = lastConfig?.transitions.find((t) => !t.retry && t.next);
            currentStageName = completeTransition?.next ?? resolveEntry();
            completedStages = [...existingState.completedStages];
            await this.notifyBanner(`🔄 ${currentStageName}부터 재개 (이전 완료: ${existingState.completedStages.join(' → ')})`);
        }
        else {
            currentStageName = resolveEntry();
            completedStages = [];
        }
        savePipelineState(this.groupDir, {
            currentStage: currentStageName,
            completedStages,
            lastUpdated: new Date().toISOString(),
            status: 'running',
        });
        while (currentStageName !== null) {
            if (this.aborted)
                break;
            const stageConfig = stagesByName.get(currentStageName);
            if (!stageConfig) {
                logger.error({ stage: currentStageName }, 'Stage config not found');
                lastResult = 'error';
                break;
            }
            // Exclusive lock: wait for shared resource (e.g. Vivado memory, FPGA board)
            let exclusiveLock = null;
            if (stageConfig.exclusive) {
                exclusiveLock = getExclusiveLock(stageConfig.exclusive);
                logger.info({ stage: currentStageName, key: stageConfig.exclusive }, 'Waiting for exclusive lock');
                await this.notify(`🔒 ${currentStageName}: 대기 중 (${stageConfig.exclusive} lock)...`);
                await exclusiveLock.acquire();
                logger.info({ stage: currentStageName, key: stageConfig.exclusive }, 'Exclusive lock acquired');
            }
            try {
                const commonRules = buildCommonRules(stageConfig);
                // Spawn container for this stage
                const initialPrompt = nextInitialPrompt ||
                    `${stageConfig.prompt}\n${commonRules}\n\n## Plan\n\n${planContent}`;
                nextInitialPrompt = null;
                const stageStartTime = Date.now();
                const handle = this.spawnStageContainer(stageConfig, initialPrompt, pipelineLogStream);
                this.currentHandle = handle;
                handle.pendingResult = createDeferred();
                logger.info({ stage: currentStageName }, 'Stage container spawned (on-demand)');
                logger.info({ stage: currentStageName }, 'Entering stage');
                await this.notifyBanner(`📌 Stage: ${currentStageName} 시작`);
                const tracker = {
                    lastError: null,
                    consecutiveCount: 0,
                    debugAttempted: false,
                };
                let isFirstTurn = true;
                let stageResolved = false;
                while (!stageResolved) {
                    turnCount++;
                    // Set up deferred if not already set
                    if (!handle.pendingResult) {
                        handle.pendingResult = createDeferred();
                    }
                    // Send work prompt to stage (unless first turn, which got it at spawn)
                    if (!isFirstTurn) {
                        const prompt = `${stageConfig.prompt}\n${commonRules}\n\n## Plan\n\n${planContent}`;
                        sendToStage(handle, prompt);
                    }
                    isFirstTurn = false;
                    logger.debug({ stage: currentStageName, turn: turnCount }, 'Waiting for stage result');
                    await this.notify(`🔧 [턴 ${turnCount}] ${currentStageName} 진행 중...`);
                    // Wait for the stage to produce a result
                    const result = await handle.pendingResult.promise;
                    handle.pendingResult = null;
                    logger.info({ stage: currentStageName, turn: turnCount, result }, 'Stage result received');
                    const { matched, payload } = result;
                    if (!matched) {
                        // No markers found — retry
                        logger.warn({ stage: currentStageName, turn: turnCount }, 'No stage markers found');
                        handle.pendingResult = createDeferred();
                        sendToStage(handle, `이전 응답에 스테이지 마커가 없었습니다. 작업을 계속하고 완료 시 적절한 마커를 출력하세요.\n\n${stageConfig.prompt}\n${commonRules}`);
                    }
                    else if (matched.retry) {
                        // Retry transition (error with error tracking)
                        const errorDesc = payload || matched.marker;
                        const normalized = normalizeError(errorDesc);
                        if (tracker.lastError &&
                            normalizeError(tracker.lastError) === normalized) {
                            tracker.consecutiveCount++;
                        }
                        else {
                            tracker.lastError = errorDesc;
                            tracker.consecutiveCount = 1;
                            tracker.debugAttempted = false;
                        }
                        await this.notify(`⚠️ [턴 ${turnCount}] ${currentStageName} 에러 (${tracker.consecutiveCount}/${this.config.errorPolicy.maxConsecutive}회): ${errorDesc}`);
                        if (tracker.consecutiveCount >=
                            this.config.errorPolicy.maxConsecutive &&
                            !tracker.debugAttempted &&
                            this.config.errorPolicy.debugOnMaxErrors) {
                            await this.notify(`🔍 ${currentStageName} 디버깅 세션 시작`);
                            const debugAdvice = await this.runDebugSession(currentStageName, tracker.lastError, planContent);
                            tracker.consecutiveCount = 0;
                            tracker.debugAttempted = true;
                            handle.pendingResult = createDeferred();
                            sendToStage(handle, `${stageConfig.prompt}\n${commonRules}\n\n## Plan\n\n${planContent}\n\n## Debugging Advice\n\n${debugAdvice}\n\nApply this advice to resolve the previous error, then continue.`);
                            await this.notify(`🔄 디버그 조언 적용하여 재시도`);
                        }
                        else if (tracker.consecutiveCount >=
                            this.config.errorPolicy.maxConsecutive &&
                            tracker.debugAttempted) {
                            await this.notify(`❌ ${currentStageName} 실패: 디버그 후에도 동일 에러 반복`);
                            this.manifest.stages.push({
                                name: currentStageName,
                                status: 'error',
                                duration: Date.now() - stageStartTime,
                            });
                            await this.closeAndWait(handle);
                            this.currentHandle = null;
                            currentStageName = null;
                            lastResult = 'error';
                            stageResolved = true;
                        }
                        else {
                            handle.pendingResult = createDeferred();
                            sendToStage(handle, `이전 시도에서 에러가 발생했습니다: ${errorDesc}\n\n다시 시도하세요.\n\n${stageConfig.prompt}\n${commonRules}\n\n## Plan\n\n${planContent}`);
                        }
                    }
                    else {
                        // Non-retry transition — move to next stage or end pipeline
                        const targetName = matched.next ?? null;
                        const isErrorTransition = matched.marker.includes('ERROR');
                        if (isErrorTransition) {
                            await this.notifyBanner(targetName
                                ? `⚠️ 주의: ${payload || matched.marker}\n🔄 ${targetName}으로 복귀`
                                : `⚠️ 주의: ${payload || matched.marker}`);
                        }
                        else {
                            await this.notifyBanner(targetName
                                ? `✅ ${currentStageName} → ${targetName} (${matched.marker})`
                                : `✅ ${currentStageName} 완료! (${matched.marker})`);
                        }
                        // Track completed stage
                        completedStages.push(currentStageName);
                        this.manifest.stages.push({
                            name: currentStageName,
                            status: isErrorTransition ? 'error' : 'success',
                            duration: Date.now() - stageStartTime,
                        });
                        writeRunManifest(this.groupDir, this.manifest);
                        savePipelineState(this.groupDir, {
                            currentStage: targetName,
                            completedStages,
                            lastUpdated: new Date().toISOString(),
                            status: 'running',
                        });
                        await this.closeAndWait(handle);
                        this.currentHandle = null;
                        if (targetName) {
                            // Inject payload as context for the next stage
                            if (payload) {
                                const targetConfig = stagesByName.get(targetName);
                                const targetRules = targetConfig
                                    ? buildCommonRules(targetConfig)
                                    : commonRules;
                                nextInitialPrompt = `이전 스테이지(${currentStageName})에서 전달된 내용:\n\n${payload}\n\n${targetConfig?.prompt || ''}\n${targetRules}\n\n## Plan\n\n${planContent}`;
                            }
                        }
                        else {
                            lastResult = 'success';
                        }
                        currentStageName = targetName;
                        stageResolved = true;
                    }
                }
            }
            finally {
                // Release exclusive lock after stage completes (any exit path, including exceptions)
                if (exclusiveLock) {
                    exclusiveLock.release();
                    logger.info({ stage: currentStageName, key: stageConfig.exclusive }, 'Exclusive lock released');
                }
            }
        }
        // Save final pipeline state
        savePipelineState(this.groupDir, {
            currentStage: null,
            completedStages,
            lastUpdated: new Date().toISOString(),
            status: lastResult,
        });
        // Finalize run manifest and remove _current.json
        this.manifest.endTime = new Date().toISOString();
        this.manifest.status = lastResult;
        writeRunManifest(this.groupDir, this.manifest);
        removeCurrentRun(this.groupDir);
        pipelineLogStream.write(`\n=== Pipeline ${lastResult === 'success' ? 'completed' : 'failed'}: ${new Date().toISOString()} ===\n`);
        pipelineLogStream.end();
        await this.notifyBanner(lastResult === 'success'
            ? '🏁 전체 파이프라인 완료!'
            : '❌ 파이프라인이 에러로 종료되었습니다.');
        return lastResult;
    }
    /**
     * Spawn a one-off debug container to analyze a repeated error.
     */
    async runDebugSession(stageName, error, planContent) {
        const debugPrompt = `You are a debugging advisor. An implementation agent has repeatedly hit the following error during the **${stageName}** stage.

## Repeated Error
${error}

## Current Stage
${stageName}

## Plan Being Implemented
${planContent}

Analyze the error in the context of the current stage and plan. Provide specific, actionable debugging advice:
1. What is likely causing this error?
2. What specific steps should the agent take to fix it?
3. Are there alternative approaches if the current approach is fundamentally broken?

Be concise and specific. Your advice will be injected into the implementation agent's next prompt.`;
        const subFolder = `${this.group.folder}__pipeline_debug`;
        // Debug workspace nested inside parent group dir
        const debugWorkspaceDir = path.join(this.groupDir, 'debug');
        fs.mkdirSync(debugWorkspaceDir, { recursive: true });
        const virtualGroup = {
            name: 'pipeline-debug',
            folder: subFolder, // Flat folder for IPC/sessions
            trigger: '',
            added_at: new Date().toISOString(),
            containerConfig: {
                additionalMounts: this.group.containerConfig?.additionalMounts || [],
                workspaceDir: debugWorkspaceDir,
            },
        };
        let debugResult = 'No specific advice generated.';
        try {
            const output = await runContainerAgent(virtualGroup, {
                prompt: debugPrompt,
                groupFolder: subFolder,
                chatJid: this.chatJid,
                isMain: false,
                assistantName: 'pipeline-debug',
                endOnFirstResult: true,
                runId: this.runId,
            }, (proc, containerName) => this.onProcess(proc, containerName), async (o) => {
                if (o.result) {
                    debugResult = o.result;
                }
            });
            logger.info({ stage: stageName, status: output.status }, 'Debug session completed');
        }
        catch (err) {
            logger.error({ stage: stageName, err }, 'Debug session failed');
        }
        return debugResult;
    }
}
/**
 * Load and validate AGENT_TEAM.json from a group folder.
 * Returns null if the file doesn't exist.
 */
export function loadAgentTeamConfig(groupFolder) {
    const groupDir = resolveGroupFolderPath(groupFolder);
    const teamPath = path.join(groupDir, 'AGENT_TEAM.json');
    if (!fs.existsSync(teamPath)) {
        return null;
    }
    try {
        const raw = fs.readFileSync(teamPath, 'utf-8');
        const config = JSON.parse(raw);
        if (!Array.isArray(config.agents) || config.agents.length === 0) {
            logger.warn({ groupFolder }, 'AGENT_TEAM.json has no agents');
            return null;
        }
        // Validate folder names: no path traversal, alphanumeric + underscore/hyphen only
        const folderPattern = /^[a-zA-Z0-9_-]+$/;
        for (const agent of config.agents) {
            if (!agent.name || !agent.folder || !folderPattern.test(agent.folder)) {
                logger.warn({ groupFolder, agent }, 'AGENT_TEAM.json has invalid agent entry');
                return null;
            }
        }
        return config;
    }
    catch (err) {
        logger.error({ groupFolder, err }, 'Failed to parse AGENT_TEAM.json');
        return null;
    }
}
/**
 * Load and validate PIPELINE.json from a group folder.
 * Returns null if the file doesn't exist.
 */
export function loadPipelineConfig(groupFolder, groupDir) {
    const dir = groupDir ?? resolveGroupFolderPath(groupFolder);
    const pipelinePath = path.join(dir, 'PIPELINE.json');
    if (!fs.existsSync(pipelinePath)) {
        return null;
    }
    try {
        const raw = fs.readFileSync(pipelinePath, 'utf-8');
        const config = JSON.parse(raw);
        // Basic validation
        if (!Array.isArray(config.stages) || config.stages.length === 0) {
            logger.warn({ groupFolder }, 'PIPELINE.json has no stages');
            return null;
        }
        if (!config.errorPolicy) {
            config.errorPolicy = { maxConsecutive: 3, debugOnMaxErrors: true };
        }
        return config;
    }
    catch (err) {
        logger.error({ groupFolder, err }, 'Failed to parse PIPELINE.json');
        return null;
    }
}
//# sourceMappingURL=pipeline-runner.js.map