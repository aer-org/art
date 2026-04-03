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
import { buildContainerArgs, runContainerAgent, } from './container-runner.js';
import { getRuntime } from './container-runtime.js';
import { getImageForStage } from './image-registry.js';
import { validateAdditionalMounts } from './mount-security.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { generateRunId, writeCurrentRun, removeCurrentRun, writeRunManifest, } from './run-manifest.js';
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
    runId;
    manifest;
    aborted = false;
    activeHandles = new Map();
    stageSessionIds = new Map();
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
        // Stage mounts (e.g. "src": "rw" → /workspace/src)
        for (const [key, policy] of Object.entries(stageConfig.mounts)) {
            if (key.startsWith('project:'))
                continue;
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
        if (effectivePolicy) {
            mounts.push({
                hostPath: path.dirname(this.groupDir),
                containerPath: '/workspace/project',
                readonly: effectivePolicy === 'ro',
            });
            // Shadow __art__/ with empty dir
            const emptyDir = path.join(DATA_DIR, 'empty');
            fs.mkdirSync(emptyDir, { recursive: true });
            const artDirName = path.basename(this.groupDir);
            mounts.push({
                hostPath: emptyDir,
                containerPath: `/workspace/project/${artDirName}`,
                readonly: true,
            });
            // Process project:* sub-mount overrides (directory-level only)
            // File-level bind mounts are not supported because Docker tracks inodes,
            // and git operations (reset, checkout) replace files with new inodes,
            // making the bind mount stale.
            const projectRoot = path.dirname(this.groupDir);
            for (const [key, subPolicy] of Object.entries(stageConfig.mounts)) {
                if (!key.startsWith('project:'))
                    continue;
                const subPath = key.slice('project:'.length);
                if (subPath === artDirName || subPath.startsWith(artDirName + '/'))
                    continue;
                const subHostPath = path.join(projectRoot, subPath);
                const isFile = fs.existsSync(subHostPath) && fs.statSync(subHostPath).isFile();
                if (isFile) {
                    logger.warn({ key, subPath }, 'File-level project mount ignored (only directories supported)');
                    continue;
                }
                if (subPolicy === null) {
                    mounts.push({
                        hostPath: emptyDir,
                        containerPath: `/workspace/project/${subPath}`,
                        readonly: true,
                    });
                }
                else if (subPolicy && subPolicy !== effectivePolicy) {
                    mounts.push({
                        hostPath: subHostPath,
                        containerPath: `/workspace/project/${subPath}`,
                        readonly: subPolicy === 'ro',
                    });
                }
            }
        }
        // Host path mounts (validated against external allowlist)
        if (stageConfig.hostMounts && stageConfig.hostMounts.length > 0) {
            const validated = validateAdditionalMounts(stageConfig.hostMounts, `pipeline-${stageConfig.name}`, this.group.isMain ?? false);
            mounts.push(...validated);
        }
        // Conversations archive directory (agent-runner writes transcripts here)
        const subFolder = `${this.group.folder}__pipeline_${stageConfig.name}`;
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
    spawnStageContainer(stageConfig, initialPrompt, logStream) {
        const subFolder = `${this.group.folder}__pipeline_${stageConfig.name}`;
        // Build internal mounts (group + project + sub-path overrides)
        const internalMounts = this.buildStageMounts(stageConfig);
        // Resolve container image from registry (agent mode only)
        let resolvedImage;
        if (!stageConfig.command) {
            resolvedImage = getImageForStage(stageConfig.image, false);
        }
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
                image: resolvedImage,
                additionalMounts: filteredParentMounts,
                additionalDevices: stageConfig.devices || [],
                gpu: stageConfig.gpu === true,
                runAsRoot: stageConfig.runAsRoot === true,
                privileged: stageConfig.privileged === true,
                env: stageConfig.env,
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
            const configTimeout = this.group.containerConfig?.timeout || 14400000; // 4 hour default for commands
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
     * Build commonRules dynamically from a stage's transitions.
     */
    buildCommonRules(stageConfig) {
        const markerLines = stageConfig.transitions.map((t) => {
            const desc = t.prompt || t.marker;
            if (t.retry) {
                return `- ${desc} → [${t.marker}: brief description]`;
            }
            return `- ${desc} → [${t.marker}]`;
        });
        const modeRule = stageConfig.chat
            ? '- You are in an interactive conversation with the user. Ask questions and respond conversationally.\n- When the conversation goal is achieved, emit the completion marker.'
            : '- Do NOT ask questions. Always assume "yes" and proceed autonomously.\n- Do not stop until this stage is complete or you hit a blocking error.';
        return `
RULES:
${modeRule}
- Read files before editing. Use tools freely.
- Project source is available read-only at /workspace/project/.
- Stage working directories are mounted under /workspace/ (plan/, src/, tb/, build/, sim/, etc.). Always read and write files at these paths.

STAGE MARKERS — use the correct one:
${markerLines.join('\n')}`;
    }
    /**
     * Validate plan, initialize git if needed, write manifest, create log stream.
     * Returns null on validation failure.
     */
    async initRun() {
        const planPath = path.join(this.groupDir, 'plan', 'PLAN.md');
        if (!fs.existsSync(planPath)) {
            await this.notify('⚠️ PLAN.md not found. Please write an implementation plan first.');
            return null;
        }
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
        await this.notifyBanner(`🚀 Pipeline starting. Stages: ${stageNames}`);
        // Pipeline-wide log file
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
        return { planContent, stagesByName, pipelineLogStream };
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
            for (const t of s.transitions) {
                if (t.retry)
                    continue;
                // Skip next_dynamic transitions — their targets are determined at runtime
                // and tracked via activations/completions, not static predecessor counts.
                if (t.next_dynamic)
                    continue;
                for (const target of PipelineRunner.nextTargets(t.next)) {
                    let set = predecessors.get(target);
                    if (!set) {
                        set = new Set();
                        predecessors.set(target, set);
                    }
                    set.add(s.name);
                }
            }
        }
        return predecessors;
    }
    /**
     * Build reachability map: for each stage, which stages can it
     * transitively reach through the pipeline's transition graph?
     * Used by dynamic fan-in to determine if an unactivated predecessor
     * could still be activated by a currently-alive stage.
     */
    buildReachabilityMap() {
        // Build adjacency list from all transitions with `next` targets
        const adj = new Map();
        for (const s of this.config.stages) {
            if (!adj.has(s.name))
                adj.set(s.name, new Set());
            for (const t of s.transitions) {
                if (t.retry && !t.next)
                    continue;
                for (const target of PipelineRunner.nextTargets(t.next)) {
                    adj.get(s.name).add(target);
                }
            }
        }
        // BFS transitive closure per stage
        const reachability = new Map();
        for (const s of this.config.stages) {
            const reachable = new Set();
            const queue = [...(adj.get(s.name) ?? [])];
            while (queue.length > 0) {
                const current = queue.shift();
                if (reachable.has(current))
                    continue;
                reachable.add(current);
                for (const next of adj.get(current) ?? []) {
                    if (!reachable.has(next))
                        queue.push(next);
                }
            }
            reachability.set(s.name, reachable);
        }
        return reachability;
    }
    /**
     * Check if a stage's fan-in gate is satisfied:
     * all predecessors must appear in completedStages.
     */
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
     * Check if a stage's dynamic fan-in gate is satisfied:
     * only predecessors that have been activated are checked.
     * A predecessor is "done" if its completion count matches its activation count.
     *
     * An unactivated predecessor (activation=0) is only skipped if no alive
     * stage can transitively reach it. If any alive stage could still activate
     * the predecessor via retry/error paths, the gate stays closed.
     */
    static fanInReadyDynamic(stageName, predecessors, activations, completions, reachability, aliveStages) {
        const preds = predecessors.get(stageName);
        if (!preds || preds.size <= 1)
            return true;
        let anyActivated = false;
        for (const pred of preds) {
            const act = activations.get(pred) ?? 0;
            if (act === 0) {
                // Never activated — but could it still be activated?
                // Check if any alive stage can transitively reach this predecessor.
                for (const alive of aliveStages) {
                    if (reachability.get(alive)?.has(pred)) {
                        return false; // alive stage can still reach this predecessor — wait
                    }
                }
                continue; // no alive stage can reach it — safe to skip
            }
            anyActivated = true;
            const comp = completions.get(pred) ?? 0;
            if (comp < act)
                return false; // activated but not yet completed
        }
        return anyActivated; // at least one predecessor must have been activated
    }
    /**
     * Determine entry stage and resume from previous state if applicable.
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
                    if (t.retry)
                        continue;
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
            const completedStages = [...existingState.completedStages];
            // Find where to resume: look at the last completed stage's forward transition
            const lastCompleted = completedStages[completedStages.length - 1];
            const lastConfig = stagesByName.get(lastCompleted);
            const completeTransition = lastConfig?.transitions.find((t) => !t.retry && t.next);
            let initialStages;
            if (completeTransition?.next) {
                const targets = PipelineRunner.nextTargets(completeTransition.next);
                // Only resume targets not yet completed
                const remaining = targets.filter((t) => !completedStages.includes(t));
                initialStages = remaining.length > 0 ? remaining : [resolveEntry()];
            }
            else {
                initialStages = [resolveEntry()];
            }
            await this.notifyBanner(`🔄 Resuming from ${initialStages.join(', ')} (previously completed: ${existingState.completedStages.join(' → ')})`);
            // Restore activation/completion counts from persisted state
            const activations = new Map(Object.entries(existingState.activations ?? {}));
            const completions = new Map(Object.entries(existingState.completions ?? {}));
            return { initialStages, completedStages, activations, completions };
        }
        return {
            initialStages: [resolveEntry()],
            completedStages: [],
            activations: new Map(),
            completions: new Map(),
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
                lastResult: null,
            };
        }
        if (matched.retry) {
            const errorDesc = payload || matched.marker;
            await this.notify(`⚠️ [Turn ${turnCount}] ${currentStageName} error: ${errorDesc}`);
            // Synthetic container exit/error — container is dead, must respawn
            if (matched.marker.startsWith('_CONTAINER')) {
                if (ctx.containerRespawnCount >= ctx.maxContainerRespawns) {
                    await this.notify(`❌ [Turn ${turnCount}] ${currentStageName} container respawn limit exceeded (${ctx.maxContainerRespawns}) — stage failed`);
                    return {
                        stageResolved: true,
                        nextStageName: null,
                        nextInitialPrompt: null,
                        lastResult: 'error',
                    };
                }
                await this.notify(`🔄 [Turn ${turnCount}] ${currentStageName} container respawn (${ctx.containerRespawnCount + 1}/${ctx.maxContainerRespawns})...`);
                return {
                    stageResolved: true,
                    nextStageName: currentStageName,
                    nextInitialPrompt: `The container exited abnormally in the previous attempt: ${errorDesc}\n\nPlease retry.\n\n${stageConfig.prompt}\n${commonRules}\n\n## Plan\n\n${planContent}`,
                    lastResult: null,
                };
            }
            // Normal retry — container is still alive, re-send prompt via IPC
            handle.pendingResult = createDeferred();
            sendToStage(handle, `An error occurred in the previous attempt: ${errorDesc}\n\nPlease retry.\n\n${stageConfig.prompt}\n${commonRules}\n\n## Plan\n\n${planContent}`);
            return {
                stageResolved: false,
                nextStageName: null,
                nextInitialPrompt: null,
                lastResult: null,
            };
        }
        // Non-retry transition — move to next stage(s) or end pipeline
        let targetName;
        if (matched.next_dynamic && payload) {
            // Dynamic transition: agent picks targets from payload
            const requested = payload
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            const allowlist = new Set(PipelineRunner.nextTargets(matched.next));
            const invalid = requested.filter((t) => !allowlist.has(t));
            if (invalid.length > 0) {
                logger.error({ stage: currentStageName, invalid, allowlist: [...allowlist] }, 'Dynamic transition target not in allowlist');
                await this.notifyBanner(`❌ ${currentStageName}: dynamic transition target not in allowlist: ${invalid.join(', ')}`);
                return {
                    stageResolved: true,
                    nextStageName: null,
                    nextInitialPrompt: null,
                    lastResult: 'error',
                };
            }
            targetName =
                requested.length === 0
                    ? (matched.next ?? null) // empty payload → fallback to static next
                    : requested.length === 1
                        ? requested[0]
                        : requested;
        }
        else {
            targetName = matched.next ?? null;
        }
        const targetDisplay = Array.isArray(targetName)
            ? targetName.join(', ')
            : targetName;
        const isErrorTransition = matched.marker.includes('ERROR');
        if (isErrorTransition) {
            await this.notifyBanner(targetDisplay
                ? `⚠️ Warning: ${payload || matched.marker}\n🔄 Returning to ${targetDisplay}`
                : `⚠️ Warning: ${payload || matched.marker}`);
        }
        else {
            await this.notifyBanner(targetDisplay
                ? `✅ ${currentStageName} → ${targetDisplay} (${matched.marker})`
                : `✅ ${currentStageName} completed! (${matched.marker})`);
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
        // Close the container first, then retrieve session ID
        await this.closeAndWait(handle);
        const containerResult = await handle.containerPromise;
        if (containerResult.newSessionId) {
            this.stageSessionIds.set(currentStageName, containerResult.newSessionId);
        }
        this.activeHandles.delete(currentStageName);
        // Payload forwarding only works for single-target non-dynamic transitions
        // (dynamic payloads contain target names, not content to forward)
        let nextInitialPrompt = null;
        const targets = PipelineRunner.nextTargets(targetName);
        if (targets.length === 1 && payload && !matched.next_dynamic) {
            const targetConfig = stagesByName.get(targets[0]);
            const targetRules = targetConfig
                ? this.buildCommonRules(targetConfig)
                : commonRules;
            nextInitialPrompt = `Forwarded from previous stage (${currentStageName}):\n\n${payload}\n\n${targetConfig?.prompt || ''}\n${targetRules}\n\n## Plan\n\n${planContent}`;
        }
        return {
            stageResolved: true,
            nextStageName: targetName,
            nextInitialPrompt,
            lastResult: targets.length === 0 ? 'success' : null,
        };
    }
    /**
     * Save final pipeline state, close manifest and log stream.
     */
    async finalizeRun(completedStages, lastResult, pipelineLogStream) {
        savePipelineState(this.groupDir, {
            currentStage: null,
            completedStages,
            lastUpdated: new Date().toISOString(),
            status: lastResult,
        });
        this.manifest.endTime = new Date().toISOString();
        this.manifest.status = lastResult;
        writeRunManifest(this.groupDir, this.manifest);
        removeCurrentRun(this.groupDir);
        pipelineLogStream.write(`\n=== Pipeline ${lastResult === 'success' ? 'completed' : 'failed'}: ${new Date().toISOString()} ===\n`);
        pipelineLogStream.end();
        await this.notifyBanner(lastResult === 'success'
            ? '🏁 Pipeline completed!'
            : '❌ Pipeline terminated with errors.');
    }
    /**
     * Run a single stage to completion (spawn → turn loop → close).
     * Self-contained: handles retries and container respawns internally.
     */
    async runSingleStage(stageName, stagesByName, completedStages, planContent, pipelineLogStream, initialPromptOverride) {
        const stageConfig = stagesByName.get(stageName);
        if (!stageConfig) {
            logger.error({ stage: stageName }, 'Stage config not found');
            return {
                stageName,
                nextStages: null,
                nextInitialPrompt: null,
                result: 'error',
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
        let stageResult = null;
        let outNextInitialPrompt = null;
        try {
            const commonRules = this.buildCommonRules(stageConfig);
            let nextInitialPrompt = initialPromptOverride ?? null;
            let containerRespawnCount = 0;
            const MAX_CONTAINER_RESPAWNS = 3;
            let turnCount = 0;
            let currentStage = stageName;
            while (currentStage === stageName) {
                if (this.aborted) {
                    stageResult = 'error';
                    break;
                }
                const initialPrompt = nextInitialPrompt ||
                    `${stageConfig.prompt}\n${commonRules}\n\n## Plan\n\n${planContent}`;
                nextInitialPrompt = null;
                const stageStartTime = Date.now();
                const handle = this.spawnStageContainer(stageConfig, initialPrompt, pipelineLogStream);
                this.activeHandles.set(stageName, handle);
                logger.info({ stage: stageName }, 'Stage container spawned (on-demand)');
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
                        const prompt = `${stageConfig.prompt}\n${commonRules}\n\n## Plan\n\n${planContent}`;
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
                            currentStage = stageName; // stay in outer while
                        }
                        else {
                            // Advance to next stage(s) or end
                            nextStages = outcome.nextStageName;
                            outNextInitialPrompt = outcome.nextInitialPrompt;
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
        const { initialStages, completedStages, activations, completions } = await this.resolveEntryStage(stagesByName);
        // Track activations for initial stages
        for (const name of initialStages) {
            activations.set(name, (activations.get(name) ?? 0) + 1);
        }
        savePipelineState(this.groupDir, {
            currentStage: initialStages.length === 1 ? initialStages[0] : initialStages,
            completedStages,
            lastUpdated: new Date().toISOString(),
            status: 'running',
            activations: Object.fromEntries(activations),
            completions: Object.fromEntries(completions),
        });
        const predecessors = this.buildPredecessorMap();
        const reachability = this.buildReachabilityMap();
        // Each entry: { name, initialPrompt } — prompt is set when payload forwarding applies
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
            const p = this.runSingleStage(entry.name, stagesByName, completedStages, planContent, pipelineLogStream, entry.initialPrompt)
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
                    result: 'error',
                });
                running.delete(p);
                runningNames.delete(entry.name);
                signalResult();
            });
            running.add(p);
        };
        // Helper: check fan-in readiness for a stage
        const isFanInReady = (stageName) => {
            const cfg = stagesByName.get(stageName);
            const fanInMode = cfg?.fan_in ?? 'all';
            if (fanInMode === 'dynamic') {
                // Compute alive stages: running + pending + waiting-for-fan-in, excluding self
                const aliveStages = new Set([
                    ...runningNames,
                    ...pendingStages.map((s) => s.name),
                    ...waitingForFanIn,
                ]);
                aliveStages.delete(stageName);
                return PipelineRunner.fanInReadyDynamic(stageName, predecessors, activations, completions, reachability, aliveStages);
            }
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
        // Launch initial stages
        for (const entry of pendingStages) {
            tryLaunch(entry);
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
            savePipelineState(this.groupDir, {
                currentStage: activeNames.length === 1 ? activeNames[0] : activeNames,
                completedStages,
                lastUpdated: new Date().toISOString(),
                status: 'running',
                activations: Object.fromEntries(activations),
                completions: Object.fromEntries(completions),
            });
            // Wait for at least one stage to complete
            await waitForResult();
            // Drain all available results and launch ready successors immediately
            while (resultQueue.length > 0) {
                const { stageName: finishedStage, nextStages, nextInitialPrompt, result, } = resultQueue.shift();
                if (result === 'error')
                    lastResult = 'error';
                // Track completion for dynamic fan-in
                completions.set(finishedStage, (completions.get(finishedStage) ?? 0) + 1);
                const targets = PipelineRunner.nextTargets(nextStages);
                for (const target of targets) {
                    // Skip if already running, queued, or waiting for fan-in
                    if (runningNames.has(target) ||
                        pendingStages.some((s) => s.name === target) ||
                        waitingForFanIn.has(target)) {
                        continue;
                    }
                    // Track activation for dynamic fan-in (only when actually queued, not deduped)
                    activations.set(target, (activations.get(target) ?? 0) + 1);
                    if (isFanInReady(target)) {
                        tryLaunch({
                            name: target,
                            initialPrompt: targets.length === 1 ? nextInitialPrompt : null,
                        });
                    }
                    else {
                        waitingForFanIn.add(target);
                    }
                }
            }
            // Re-check fan-in gates — a newly completed stage may have unblocked waiters
            for (const w of [...waitingForFanIn]) {
                if (isFanInReady(w)) {
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
        // Validate stage names and transitions
        const stageNames = new Set(config.stages.map((s) => s.name));
        for (const stage of config.stages) {
            // Validate fan_in value
            if (stage.fan_in !== undefined &&
                stage.fan_in !== 'all' &&
                stage.fan_in !== 'dynamic') {
                logger.error({ groupFolder, stage: stage.name, fan_in: stage.fan_in }, 'Invalid fan_in value (must be "all" or "dynamic")');
                return null;
            }
            for (const t of stage.transitions) {
                // next_dynamic + retry mutual exclusion
                if (t.next_dynamic && t.retry) {
                    logger.error({ groupFolder, stage: stage.name, marker: t.marker }, 'next_dynamic and retry cannot be used together');
                    return null;
                }
                // next_dynamic requires non-null next
                if (t.next_dynamic && t.next == null) {
                    logger.error({ groupFolder, stage: stage.name, marker: t.marker }, 'next_dynamic requires next to be a non-null array (allowlist)');
                    return null;
                }
                // Validate transition targets exist
                if (!t.retry) {
                    const targets = Array.isArray(t.next)
                        ? t.next
                        : t.next != null
                            ? [t.next]
                            : [];
                    for (const target of targets) {
                        if (!stageNames.has(target)) {
                            logger.warn({ groupFolder, stage: stage.name, target }, 'Transition target references non-existent stage');
                        }
                    }
                }
            }
        }
        return config;
    }
    catch (err) {
        logger.error({ groupFolder, err }, 'Failed to parse PIPELINE.json');
        return null;
    }
}
//# sourceMappingURL=pipeline-runner.js.map