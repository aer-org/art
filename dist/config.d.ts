export declare const ASSISTANT_NAME: string;
export declare const ASSISTANT_HAS_OWN_NUMBER: boolean;
export declare const POLL_INTERVAL = 2000;
export declare const SCHEDULER_POLL_INTERVAL = 60000;
export declare const ART_DIR_NAME = "__art__";
export declare const MOUNT_ALLOWLIST_PATH: string;
export declare const SENDER_ALLOWLIST_PATH: string;
export declare const IMAGE_REGISTRY_PATH: string;
export declare let STORE_DIR: string;
export declare let GROUPS_DIR: string;
export declare let DATA_DIR: string;
/**
 * Reconfigure path roots for art CLI mode.
 * engineRoot = AerArt install dir (for DB, store, groups)
 */
export declare function setEngineRoot(engineRoot: string): void;
export declare function getProjectRoot(): string;
export declare const CONTAINER_IMAGE: string;
export declare const CONTAINER_TIMEOUT: number;
export declare const CONTAINER_MAX_OUTPUT_SIZE: number;
export declare function getCredentialProxyPort(): number;
export declare function setCredentialProxyPort(port: number): void;
export declare const CREDENTIAL_PROXY_PORT: number;
export declare const IPC_POLL_INTERVAL = 1000;
export declare const IDLE_TIMEOUT: number;
export declare const MAX_CONCURRENT_CONTAINERS: number;
export declare const TRIGGER_PATTERN: RegExp;
export declare const TIMEZONE: string;
//# sourceMappingURL=config.d.ts.map