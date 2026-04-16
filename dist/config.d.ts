export declare const ART_DIR_NAME = "__art__";
export declare const MOUNT_ALLOWLIST_PATH: string;
export declare const IMAGE_REGISTRY_PATH: string;
export declare const MCP_REGISTRY_PATH: string;
export declare let STORE_DIR: string;
export declare let GROUPS_DIR: string;
export declare let DATA_DIR: string;
/**
 * Reconfigure path roots for art CLI mode.
 * engineRoot = AerArt install dir (for DB, store, groups)
 */
export declare function setEngineRoot(engineRoot: string): void;
export declare function setDataDir(dir: string): void;
export declare function getProjectRoot(): string;
export declare const CONTAINER_IMAGE: string;
export declare const CONTAINER_TIMEOUT: number;
export declare const CONTAINER_MAX_OUTPUT_SIZE: number;
export declare function getCredentialProxyPort(): number;
export declare function setCredentialProxyPort(port: number): void;
export declare function getCodexAuthProxyPort(): number;
export declare function setCodexAuthProxyPort(port: number): void;
export declare const CREDENTIAL_PROXY_PORT: number;
export declare const CODEX_AUTH_PROXY_PORT: number;
export declare const IDLE_TIMEOUT: number;
export declare const TIMEZONE: string;
//# sourceMappingURL=config.d.ts.map