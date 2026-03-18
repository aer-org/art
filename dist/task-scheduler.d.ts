import { ChildProcess } from 'child_process';
import { GroupQueue } from './group-queue.js';
import { RegisteredGroup, ScheduledTask } from './types.js';
/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export declare function computeNextRun(task: ScheduledTask): string | null;
export interface SchedulerDependencies {
    registeredGroups: () => Record<string, RegisteredGroup>;
    getSessions: () => Record<string, string>;
    queue: GroupQueue;
    onProcess: (groupJid: string, proc: ChildProcess, containerName: string, groupFolder: string) => void;
    sendMessage: (jid: string, text: string) => Promise<void>;
}
export declare function startSchedulerLoop(deps: SchedulerDependencies): void;
/** @internal - for tests only. */
export declare function _resetSchedulerLoopForTests(): void;
//# sourceMappingURL=task-scheduler.d.ts.map