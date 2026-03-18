import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { getRuntimeCapabilities, stopContainer } from './container-runtime.js';
import { logger } from './logger.js';
const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;
export class GroupQueue {
    groups = new Map();
    activeCount = 0;
    waitingGroups = [];
    processMessagesFn = null;
    shuttingDown = false;
    getGroup(groupJid) {
        let state = this.groups.get(groupJid);
        if (!state) {
            state = {
                active: false,
                idleWaiting: false,
                isTaskContainer: false,
                runningTaskId: null,
                pendingMessages: false,
                pendingTasks: [],
                process: null,
                containerName: null,
                groupFolder: null,
                retryCount: 0,
            };
            this.groups.set(groupJid, state);
        }
        return state;
    }
    setProcessMessagesFn(fn) {
        this.processMessagesFn = fn;
    }
    enqueueMessageCheck(groupJid) {
        if (this.shuttingDown)
            return;
        const state = this.getGroup(groupJid);
        if (state.active) {
            state.pendingMessages = true;
            logger.debug({ groupJid }, 'Container active, message queued');
            return;
        }
        if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
            state.pendingMessages = true;
            if (!this.waitingGroups.includes(groupJid)) {
                this.waitingGroups.push(groupJid);
            }
            logger.debug({ groupJid, activeCount: this.activeCount }, 'At concurrency limit, message queued');
            return;
        }
        this.runForGroup(groupJid, 'messages').catch((err) => logger.error({ groupJid, err }, 'Unhandled error in runForGroup'));
    }
    enqueueTask(groupJid, taskId, fn) {
        if (this.shuttingDown)
            return;
        const state = this.getGroup(groupJid);
        // Prevent double-queuing: check both pending and currently-running task
        if (state.runningTaskId === taskId) {
            logger.debug({ groupJid, taskId }, 'Task already running, skipping');
            return;
        }
        if (state.pendingTasks.some((t) => t.id === taskId)) {
            logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
            return;
        }
        if (state.active) {
            state.pendingTasks.push({ id: taskId, groupJid, fn });
            if (state.idleWaiting) {
                this.closeStdin(groupJid);
            }
            logger.debug({ groupJid, taskId }, 'Container active, task queued');
            return;
        }
        if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
            state.pendingTasks.push({ id: taskId, groupJid, fn });
            if (!this.waitingGroups.includes(groupJid)) {
                this.waitingGroups.push(groupJid);
            }
            logger.debug({ groupJid, taskId, activeCount: this.activeCount }, 'At concurrency limit, task queued');
            return;
        }
        // Run immediately
        this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) => logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'));
    }
    registerProcess(groupJid, proc, containerName, groupFolder) {
        const state = this.getGroup(groupJid);
        state.process = proc;
        state.containerName = containerName;
        if (groupFolder)
            state.groupFolder = groupFolder;
    }
    /**
     * Mark the container as idle-waiting (finished work, waiting for IPC input).
     * If tasks are pending, preempt the idle container immediately.
     */
    notifyIdle(groupJid) {
        const state = this.getGroup(groupJid);
        state.idleWaiting = true;
        if (state.pendingTasks.length > 0) {
            this.closeStdin(groupJid);
        }
    }
    /**
     * Send a follow-up message to the active container via IPC file.
     * Returns true if the message was written, false if no active container.
     */
    sendMessage(groupJid, text) {
        const state = this.getGroup(groupJid);
        if (!state.active || !state.groupFolder || state.isTaskContainer)
            return false;
        state.idleWaiting = false; // Agent is about to receive work, no longer idle
        const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
        try {
            fs.mkdirSync(inputDir, { recursive: true });
            const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
            const filepath = path.join(inputDir, filename);
            const tempPath = `${filepath}.tmp`;
            fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
            fs.renameSync(tempPath, filepath);
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * Signal the active container to wind down by writing a close sentinel.
     */
    closeStdin(groupJid) {
        const state = this.getGroup(groupJid);
        if (!state.active || !state.groupFolder)
            return;
        const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
        try {
            fs.mkdirSync(inputDir, { recursive: true });
            fs.writeFileSync(path.join(inputDir, '_close'), '');
        }
        catch {
            // ignore
        }
    }
    async runForGroup(groupJid, reason) {
        const state = this.getGroup(groupJid);
        state.active = true;
        state.idleWaiting = false;
        state.isTaskContainer = false;
        state.pendingMessages = false;
        this.activeCount++;
        logger.debug({ groupJid, reason, activeCount: this.activeCount }, 'Starting container for group');
        try {
            if (this.processMessagesFn) {
                const success = await this.processMessagesFn(groupJid);
                if (success) {
                    state.retryCount = 0;
                }
                else {
                    this.scheduleRetry(groupJid, state);
                }
            }
        }
        catch (err) {
            logger.error({ groupJid, err }, 'Error processing messages for group');
            this.scheduleRetry(groupJid, state);
        }
        finally {
            state.active = false;
            state.process = null;
            state.containerName = null;
            state.groupFolder = null;
            this.activeCount--;
            this.drainGroup(groupJid);
        }
    }
    async runTask(groupJid, task) {
        const state = this.getGroup(groupJid);
        state.active = true;
        state.idleWaiting = false;
        state.isTaskContainer = true;
        state.runningTaskId = task.id;
        this.activeCount++;
        logger.debug({ groupJid, taskId: task.id, activeCount: this.activeCount }, 'Running queued task');
        try {
            await task.fn();
        }
        catch (err) {
            logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
        }
        finally {
            state.active = false;
            state.isTaskContainer = false;
            state.runningTaskId = null;
            state.process = null;
            state.containerName = null;
            state.groupFolder = null;
            this.activeCount--;
            this.drainGroup(groupJid);
        }
    }
    scheduleRetry(groupJid, state) {
        state.retryCount++;
        if (state.retryCount > MAX_RETRIES) {
            logger.error({ groupJid, retryCount: state.retryCount }, 'Max retries exceeded, dropping messages (will retry on next incoming message)');
            state.retryCount = 0;
            return;
        }
        const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
        logger.info({ groupJid, retryCount: state.retryCount, delayMs }, 'Scheduling retry with backoff');
        setTimeout(() => {
            if (!this.shuttingDown) {
                this.enqueueMessageCheck(groupJid);
            }
        }, delayMs);
    }
    drainGroup(groupJid) {
        if (this.shuttingDown)
            return;
        const state = this.getGroup(groupJid);
        // Tasks first (they won't be re-discovered from SQLite like messages)
        if (state.pendingTasks.length > 0) {
            const task = state.pendingTasks.shift();
            this.runTask(groupJid, task).catch((err) => logger.error({ groupJid, taskId: task.id, err }, 'Unhandled error in runTask (drain)'));
            return;
        }
        // Then pending messages
        if (state.pendingMessages) {
            this.runForGroup(groupJid, 'drain').catch((err) => logger.error({ groupJid, err }, 'Unhandled error in runForGroup (drain)'));
            return;
        }
        // Nothing pending for this group; check if other groups are waiting for a slot
        this.drainWaiting();
    }
    drainWaiting() {
        while (this.waitingGroups.length > 0 &&
            this.activeCount < MAX_CONCURRENT_CONTAINERS) {
            const nextJid = this.waitingGroups.shift();
            const state = this.getGroup(nextJid);
            // Prioritize tasks over messages
            if (state.pendingTasks.length > 0) {
                const task = state.pendingTasks.shift();
                this.runTask(nextJid, task).catch((err) => logger.error({ groupJid: nextJid, taskId: task.id, err }, 'Unhandled error in runTask (waiting)'));
            }
            else if (state.pendingMessages) {
                this.runForGroup(nextJid, 'drain').catch((err) => logger.error({ groupJid: nextJid, err }, 'Unhandled error in runForGroup (waiting)'));
            }
            // If neither pending, skip this group
        }
    }
    async shutdown(_gracePeriodMs) {
        this.shuttingDown = true;
        const activeContainers = [];
        for (const [_jid, state] of this.groups) {
            if (state.process && !state.process.killed && state.containerName) {
                activeContainers.push(state.containerName);
            }
        }
        // TUI mode: stop all containers on exit (user expects clean shutdown)
        if (process.env.ART_TUI_MODE && activeContainers.length > 0) {
            const caps = getRuntimeCapabilities();
            logger.info({ count: activeContainers.length, containers: activeContainers }, 'Stopping containers');
            if (caps.supportsNaming) {
                for (const name of activeContainers) {
                    try {
                        execSync(stopContainer(name), { stdio: 'pipe', timeout: 15000 });
                    }
                    catch {
                        // container may have already exited
                    }
                }
            }
            else {
                // Runtime without --name (udocker): kill processes directly
                for (const [_jid, state] of this.groups) {
                    if (state.process && !state.process.killed) {
                        try {
                            state.process.kill('SIGTERM');
                        }
                        catch {
                            // already exited
                        }
                    }
                }
            }
            logger.info('All containers stopped');
        }
        else {
            logger.info({ activeCount: this.activeCount, detachedContainers: activeContainers }, 'GroupQueue shutting down (containers detached, not killed)');
        }
    }
}
//# sourceMappingURL=group-queue.js.map