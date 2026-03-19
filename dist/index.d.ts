import './channels/index.js';
import { RegisteredGroup } from './types.js';
export { escapeXml, formatMessages } from './router.js';
/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export declare function getAvailableGroups(): import('./container-runner.js').AvailableGroup[];
/** @internal - exported for testing */
export declare function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void;
export interface StartEngineOpts {
    /** Pre-register a group before the message loop starts (art CLI mode) */
    autoRegisterGroup?: {
        jid: string;
        group: RegisteredGroup;
    };
    /** Run ID for pipeline execution tracking */
    runId?: string;
}
export declare function startEngine(opts?: StartEngineOpts): Promise<void>;
//# sourceMappingURL=index.d.ts.map