/**
 * Conditional database backend.
 *
 * Tries to load the SQLite backend (better-sqlite3). If the native module is
 * missing (e.g. art CLI installed via `npm install -g` without build tools),
 * falls back to a pure-JS in-memory implementation.
 */
export declare const initDatabase: typeof import("./db-sqlite.js").initDatabase;
export declare const _initTestDatabase: typeof import("./db-sqlite.js")._initTestDatabase;
export declare const storeChatMetadata: typeof import("./db-sqlite.js").storeChatMetadata;
export declare const updateChatName: typeof import("./db-sqlite.js").updateChatName;
export declare const getAllChats: typeof import("./db-sqlite.js").getAllChats;
export declare const getLastGroupSync: typeof import("./db-sqlite.js").getLastGroupSync;
export declare const setLastGroupSync: typeof import("./db-sqlite.js").setLastGroupSync;
export declare const storeMessage: typeof import("./db-sqlite.js").storeMessage;
export declare const storeMessageDirect: typeof import("./db-sqlite.js").storeMessageDirect;
export declare const getNewMessages: typeof import("./db-sqlite.js").getNewMessages;
export declare const getMessagesSince: typeof import("./db-sqlite.js").getMessagesSince;
export declare const createTask: typeof import("./db-sqlite.js").createTask;
export declare const getTaskById: typeof import("./db-sqlite.js").getTaskById;
export declare const getTasksForGroup: typeof import("./db-sqlite.js").getTasksForGroup;
export declare const getAllTasks: typeof import("./db-sqlite.js").getAllTasks;
export declare const updateTask: typeof import("./db-sqlite.js").updateTask;
export declare const deleteTask: typeof import("./db-sqlite.js").deleteTask;
export declare const getDueTasks: typeof import("./db-sqlite.js").getDueTasks;
export declare const updateTaskAfterRun: typeof import("./db-sqlite.js").updateTaskAfterRun;
export declare const logTaskRun: typeof import("./db-sqlite.js").logTaskRun;
export declare const getRouterState: typeof import("./db-sqlite.js").getRouterState;
export declare const setRouterState: typeof import("./db-sqlite.js").setRouterState;
export declare const getSession: typeof import("./db-sqlite.js").getSession;
export declare const setSession: typeof import("./db-sqlite.js").setSession;
export declare const getAllSessions: typeof import("./db-sqlite.js").getAllSessions;
export declare const getRegisteredGroup: typeof import("./db-sqlite.js").getRegisteredGroup;
export declare const setRegisteredGroup: typeof import("./db-sqlite.js").setRegisteredGroup;
export declare const getAllRegisteredGroups: typeof import("./db-sqlite.js").getAllRegisteredGroups;
export declare const insertPipelineIssue: typeof import("./db-sqlite.js").insertPipelineIssue;
export declare const resolvePipelineIssues: typeof import("./db-sqlite.js").resolvePipelineIssues;
export declare const getPipelineIssues: typeof import("./db-sqlite.js").getPipelineIssues;
export declare const getUnresolvedIssueCount: typeof import("./db-sqlite.js").getUnresolvedIssueCount;
export type { ChatInfo, PipelineStageIssue } from './db-sqlite.js';
//# sourceMappingURL=db.d.ts.map