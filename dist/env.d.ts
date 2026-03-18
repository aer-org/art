/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export declare function readEnvFile(keys: string[]): Record<string, string>;
//# sourceMappingURL=env.d.ts.map