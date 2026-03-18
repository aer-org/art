interface RemoteControlSession {
    pid: number;
    url: string;
    startedBy: string;
    startedInChat: string;
    startedAt: string;
}
/**
 * Restore session from disk on startup.
 * If the process is still alive, adopt it. Otherwise, clean up.
 */
export declare function restoreRemoteControl(): void;
export declare function getActiveSession(): RemoteControlSession | null;
/** @internal — exported for testing only */
export declare function _resetForTesting(): void;
/** @internal — exported for testing only */
export declare function _getStateFilePath(): string;
export declare function startRemoteControl(sender: string, chatJid: string, cwd: string): Promise<{
    ok: true;
    url: string;
} | {
    ok: false;
    error: string;
}>;
export declare function stopRemoteControl(): {
    ok: true;
} | {
    ok: false;
    error: string;
};
export {};
//# sourceMappingURL=remote-control.d.ts.map