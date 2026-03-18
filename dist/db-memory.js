/**
 * Pure-JS in-memory database backend.
 * Used when better-sqlite3 is not available (e.g. art CLI installs via npm).
 * All data lives in Maps/Arrays and is lost when the process exits.
 */
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
// --- In-memory stores ---
const chats = new Map();
const messages = [];
const scheduledTasks = new Map();
const taskRunLogs = [];
const routerState = new Map();
const sessions = new Map();
const registeredGroups = new Map();
let pipelineIssueSeq = 1;
const pipelineIssues = [];
// --- Init ---
export function initDatabase() {
    // No-op for in-memory backend — stores are ready at import time.
}
export function _initTestDatabase() {
    chats.clear();
    messages.length = 0;
    scheduledTasks.clear();
    taskRunLogs.length = 0;
    routerState.clear();
    sessions.clear();
    registeredGroups.clear();
    pipelineIssues.length = 0;
    pipelineIssueSeq = 1;
}
// --- Chat metadata ---
export function storeChatMetadata(chatJid, timestamp, name, channel, isGroup) {
    const existing = chats.get(chatJid);
    const ch = channel ?? existing?.channel ?? null;
    const group = isGroup !== undefined ? (isGroup ? 1 : 0) : (existing?.is_group ?? 0);
    const displayName = name ?? existing?.name ?? chatJid;
    const lastTime = existing && existing.last_message_time > timestamp
        ? existing.last_message_time
        : timestamp;
    chats.set(chatJid, {
        jid: chatJid,
        name: displayName,
        last_message_time: lastTime,
        channel: ch,
        is_group: group,
    });
}
export function updateChatName(chatJid, name) {
    const existing = chats.get(chatJid);
    if (existing) {
        existing.name = name;
    }
    else {
        chats.set(chatJid, {
            jid: chatJid,
            name,
            last_message_time: new Date().toISOString(),
            channel: null,
            is_group: 0,
        });
    }
}
export function getAllChats() {
    return [...chats.values()]
        .sort((a, b) => (b.last_message_time > a.last_message_time ? 1 : -1))
        .map((c) => ({
        jid: c.jid,
        name: c.name,
        last_message_time: c.last_message_time,
        channel: c.channel ?? '',
        is_group: c.is_group,
    }));
}
export function getLastGroupSync() {
    const row = chats.get('__group_sync__');
    return row?.last_message_time || null;
}
export function setLastGroupSync() {
    const now = new Date().toISOString();
    chats.set('__group_sync__', {
        jid: '__group_sync__',
        name: '__group_sync__',
        last_message_time: now,
        channel: null,
        is_group: 0,
    });
}
// --- Messages ---
export function storeMessage(msg) {
    // Replace existing message with same id+chat_jid
    const idx = messages.findIndex((m) => m.id === msg.id && m.chat_jid === msg.chat_jid);
    const row = {
        id: msg.id,
        chat_jid: msg.chat_jid,
        sender: msg.sender,
        sender_name: msg.sender_name,
        content: msg.content,
        timestamp: msg.timestamp,
        is_from_me: msg.is_from_me ? 1 : 0,
        is_bot_message: msg.is_bot_message ? 1 : 0,
    };
    if (idx >= 0) {
        messages[idx] = row;
    }
    else {
        messages.push(row);
    }
}
export function storeMessageDirect(msg) {
    storeMessage(msg);
}
export function getNewMessages(jids, lastTimestamp, botPrefix, limit = 200) {
    if (jids.length === 0)
        return { messages: [], newTimestamp: lastTimestamp };
    const jidSet = new Set(jids);
    const prefix = `${botPrefix}:`;
    const filtered = messages
        .filter((m) => m.timestamp > lastTimestamp &&
        jidSet.has(m.chat_jid) &&
        m.is_bot_message === 0 &&
        !m.content.startsWith(prefix) &&
        m.content !== '' &&
        m.content != null)
        .sort((a, b) => (b.timestamp > a.timestamp ? 1 : -1))
        .slice(0, limit)
        .sort((a, b) => (a.timestamp > b.timestamp ? 1 : -1));
    let newTimestamp = lastTimestamp;
    for (const row of filtered) {
        if (row.timestamp > newTimestamp)
            newTimestamp = row.timestamp;
    }
    return {
        messages: filtered.map((r) => ({
            id: r.id,
            chat_jid: r.chat_jid,
            sender: r.sender,
            sender_name: r.sender_name,
            content: r.content,
            timestamp: r.timestamp,
            is_from_me: !!r.is_from_me,
        })),
        newTimestamp,
    };
}
export function getMessagesSince(chatJid, sinceTimestamp, botPrefix, limit = 200) {
    const prefix = `${botPrefix}:`;
    return messages
        .filter((m) => m.chat_jid === chatJid &&
        m.timestamp > sinceTimestamp &&
        m.is_bot_message === 0 &&
        !m.content.startsWith(prefix) &&
        m.content !== '' &&
        m.content != null)
        .sort((a, b) => (b.timestamp > a.timestamp ? 1 : -1))
        .slice(0, limit)
        .sort((a, b) => (a.timestamp > b.timestamp ? 1 : -1))
        .map((r) => ({
        id: r.id,
        chat_jid: r.chat_jid,
        sender: r.sender,
        sender_name: r.sender_name,
        content: r.content,
        timestamp: r.timestamp,
        is_from_me: !!r.is_from_me,
    }));
}
// --- Scheduled tasks ---
export function createTask(task) {
    scheduledTasks.set(task.id, {
        ...task,
        context_mode: task.context_mode || 'isolated',
        last_run: null,
        last_result: null,
    });
}
export function getTaskById(id) {
    return scheduledTasks.get(id);
}
export function getTasksForGroup(groupFolder) {
    return [...scheduledTasks.values()]
        .filter((t) => t.group_folder === groupFolder)
        .sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
}
export function getAllTasks() {
    return [...scheduledTasks.values()].sort((a, b) => b.created_at > a.created_at ? 1 : -1);
}
export function updateTask(id, updates) {
    const task = scheduledTasks.get(id);
    if (!task)
        return;
    if (updates.prompt !== undefined)
        task.prompt = updates.prompt;
    if (updates.schedule_type !== undefined)
        task.schedule_type = updates.schedule_type;
    if (updates.schedule_value !== undefined)
        task.schedule_value = updates.schedule_value;
    if (updates.next_run !== undefined)
        task.next_run = updates.next_run;
    if (updates.status !== undefined)
        task.status = updates.status;
}
export function deleteTask(id) {
    scheduledTasks.delete(id);
    // Remove associated run logs
    for (let i = taskRunLogs.length - 1; i >= 0; i--) {
        if (taskRunLogs[i].task_id === id)
            taskRunLogs.splice(i, 1);
    }
}
export function getDueTasks() {
    const now = new Date().toISOString();
    return [...scheduledTasks.values()]
        .filter((t) => t.status === 'active' && t.next_run != null && t.next_run <= now)
        .sort((a, b) => (a.next_run > b.next_run ? 1 : -1));
}
export function updateTaskAfterRun(id, nextRun, lastResult) {
    const task = scheduledTasks.get(id);
    if (!task)
        return;
    const now = new Date().toISOString();
    task.next_run = nextRun;
    task.last_run = now;
    task.last_result = lastResult;
    if (nextRun === null)
        task.status = 'completed';
}
export function logTaskRun(log) {
    taskRunLogs.push(log);
}
// --- Router state ---
export function getRouterState(key) {
    return routerState.get(key);
}
export function setRouterState(key, value) {
    routerState.set(key, value);
}
// --- Sessions ---
export function getSession(groupFolder) {
    return sessions.get(groupFolder);
}
export function setSession(groupFolder, sessionId) {
    sessions.set(groupFolder, sessionId);
}
export function getAllSessions() {
    const result = {};
    for (const [k, v] of sessions)
        result[k] = v;
    return result;
}
// --- Registered groups ---
export function getRegisteredGroup(jid) {
    const group = registeredGroups.get(jid);
    if (!group)
        return undefined;
    if (!isValidGroupFolder(group.folder)) {
        logger.warn({ jid, folder: group.folder }, 'Skipping registered group with invalid folder');
        return undefined;
    }
    return { jid, ...group };
}
export function setRegisteredGroup(jid, group) {
    if (!isValidGroupFolder(group.folder)) {
        throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
    }
    registeredGroups.set(jid, { ...group });
}
export function getAllRegisteredGroups() {
    const result = {};
    for (const [jid, group] of registeredGroups) {
        if (!isValidGroupFolder(group.folder)) {
            logger.warn({ jid, folder: group.folder }, 'Skipping registered group with invalid folder');
            continue;
        }
        result[jid] = { ...group };
    }
    return result;
}
// --- Pipeline stage issues ---
export function insertPipelineIssue(issue) {
    // INSERT OR IGNORE — skip if tool_use_id already exists
    if (pipelineIssues.some((i) => i.tool_use_id === issue.toolUseId))
        return;
    pipelineIssues.push({
        id: pipelineIssueSeq++,
        group_folder: issue.groupFolder,
        stage: issue.stage,
        tool: issue.tool,
        tool_use_id: issue.toolUseId,
        input_preview: issue.inputPreview,
        input_hash: issue.inputHash,
        error_content: issue.errorContent,
        assistant_context: issue.assistantContext ?? null,
        turn_index: issue.turnIndex ?? null,
        timestamp: issue.timestamp,
        resolved: 0,
    });
}
export function resolvePipelineIssues(inputHash, stage, groupFolder) {
    for (const issue of pipelineIssues) {
        if (issue.input_hash === inputHash &&
            issue.stage === stage &&
            issue.group_folder === groupFolder &&
            issue.resolved === 0) {
            issue.resolved = 1;
        }
    }
}
export function getPipelineIssues(groupFolder, stage) {
    return pipelineIssues
        .filter((i) => i.group_folder === groupFolder &&
        (stage === undefined || i.stage === stage))
        .sort((a, b) => (b.timestamp > a.timestamp ? 1 : -1));
}
export function getUnresolvedIssueCount(groupFolder, stage) {
    return pipelineIssues.filter((i) => i.group_folder === groupFolder && i.stage === stage && i.resolved === 0).length;
}
//# sourceMappingURL=db-memory.js.map