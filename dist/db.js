/**
 * Conditional database backend.
 *
 * Tries to load the SQLite backend (better-sqlite3). If the native module is
 * missing (e.g. art CLI installed via `npm install -g` without build tools),
 * falls back to a pure-JS in-memory implementation.
 */
let mod;
try {
    mod = await import('./db-sqlite.js');
}
catch {
    mod = await import('./db-memory.js');
}
// Re-export everything so importers see the same API regardless of backend.
export const initDatabase = mod.initDatabase;
export const _initTestDatabase = mod._initTestDatabase;
export const storeChatMetadata = mod.storeChatMetadata;
export const updateChatName = mod.updateChatName;
export const getAllChats = mod.getAllChats;
export const getLastGroupSync = mod.getLastGroupSync;
export const setLastGroupSync = mod.setLastGroupSync;
export const storeMessage = mod.storeMessage;
export const storeMessageDirect = mod.storeMessageDirect;
export const getNewMessages = mod.getNewMessages;
export const getMessagesSince = mod.getMessagesSince;
export const createTask = mod.createTask;
export const getTaskById = mod.getTaskById;
export const getTasksForGroup = mod.getTasksForGroup;
export const getAllTasks = mod.getAllTasks;
export const updateTask = mod.updateTask;
export const deleteTask = mod.deleteTask;
export const getDueTasks = mod.getDueTasks;
export const updateTaskAfterRun = mod.updateTaskAfterRun;
export const logTaskRun = mod.logTaskRun;
export const getRouterState = mod.getRouterState;
export const setRouterState = mod.setRouterState;
export const getSession = mod.getSession;
export const setSession = mod.setSession;
export const getAllSessions = mod.getAllSessions;
export const getRegisteredGroup = mod.getRegisteredGroup;
export const setRegisteredGroup = mod.setRegisteredGroup;
export const getAllRegisteredGroups = mod.getAllRegisteredGroups;
export const insertPipelineIssue = mod.insertPipelineIssue;
export const resolvePipelineIssues = mod.resolvePipelineIssues;
export const getPipelineIssues = mod.getPipelineIssues;
export const getUnresolvedIssueCount = mod.getUnresolvedIssueCount;
//# sourceMappingURL=db.js.map