import fs from 'fs';
import path from 'path';
import { MCP_REGISTRY_PATH } from './config.js';
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function normalizeStringArray(value, field, ref) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new Error(`MCP registry entry "${ref}" field "${field}" must be an array of strings.`);
    }
    return [...new Set(value)];
}
function normalizeStringMap(value, field, ref) {
    if (value === undefined)
        return undefined;
    if (!isRecord(value)) {
        throw new Error(`MCP registry entry "${ref}" field "${field}" must be an object of strings.`);
    }
    const normalized = {};
    for (const [key, item] of Object.entries(value)) {
        if (typeof item !== 'string') {
            throw new Error(`MCP registry entry "${ref}" field "${field}.${key}" must be a string.`);
        }
        normalized[key] = item;
    }
    return normalized;
}
function normalizeStartupTimeoutSec(value, ref) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error(`MCP registry entry "${ref}" field "startupTimeoutSec" must be a positive number.`);
    }
    return Math.floor(value);
}
function defaultServerNameForRef(ref) {
    const normalized = ref
        .trim()
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (!normalized) {
        throw new Error(`MCP registry entry "${ref}" cannot derive a server name from the ref.`);
    }
    return normalized;
}
function normalizeRegistryEntry(ref, value) {
    if (!isRecord(value)) {
        throw new Error(`MCP registry entry "${ref}" must be an object.`);
    }
    const transport = value.transport === undefined ? 'stdio' : value.transport;
    if (transport !== 'stdio' && transport !== 'http') {
        throw new Error(`MCP registry entry "${ref}" field "transport" must be "stdio" or "http".`);
    }
    const nameValue = value.name;
    if (nameValue !== undefined && typeof nameValue !== 'string') {
        throw new Error(`MCP registry entry "${ref}" field "name" must be a string.`);
    }
    const base = {
        name: nameValue ?? defaultServerNameForRef(ref),
        tools: normalizeStringArray(value.tools, 'tools', ref),
        startupTimeoutSec: normalizeStartupTimeoutSec(value.startupTimeoutSec, ref),
    };
    if (transport === 'http') {
        if (typeof value.url !== 'string' || value.url.trim().length === 0) {
            throw new Error(`MCP registry entry "${ref}" field "url" must be a non-empty string for http transport.`);
        }
        if (value.bearerTokenEnvVar !== undefined &&
            typeof value.bearerTokenEnvVar !== 'string') {
            throw new Error(`MCP registry entry "${ref}" field "bearerTokenEnvVar" must be a string.`);
        }
        return {
            ...base,
            transport: 'http',
            url: value.url,
            bearerTokenEnvVar: value.bearerTokenEnvVar,
        };
    }
    if (typeof value.command !== 'string' || value.command.trim().length === 0) {
        throw new Error(`MCP registry entry "${ref}" field "command" must be a non-empty string for stdio transport.`);
    }
    return {
        ...base,
        transport: 'stdio',
        command: value.command,
        args: normalizeStringArray(value.args, 'args', ref),
        env: normalizeStringMap(value.env, 'env', ref),
    };
}
export function getMcpRegistryPath() {
    const configured = process.env.ART_MCP_REGISTRY_PATH?.trim();
    if (configured)
        return path.resolve(configured);
    return MCP_REGISTRY_PATH;
}
export function loadMcpRegistry(registryPath = getMcpRegistryPath()) {
    if (!fs.existsSync(registryPath)) {
        return {};
    }
    const raw = fs.readFileSync(registryPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
        throw new Error(`MCP registry at ${registryPath} must be a JSON object.`);
    }
    const registry = {};
    for (const [ref, value] of Object.entries(parsed)) {
        registry[ref] = normalizeRegistryEntry(ref, value);
    }
    return registry;
}
function replaceHostGatewayPlaceholder(value, hostGateway) {
    if (!hostGateway)
        return value;
    return value
        .replace(/\$\{ART_HOST_GATEWAY\}/g, hostGateway)
        .replace(/\$ART_HOST_GATEWAY\b/g, hostGateway);
}
export function validateStageMcpAccess(refs, registry = loadMcpRegistry()) {
    if (!refs || refs.length === 0)
        return;
    const seenRefs = new Set();
    const seenNames = new Map();
    for (const ref of refs) {
        if (seenRefs.has(ref)) {
            throw new Error(`Duplicate mcpAccess ref "${ref}" is not allowed.`);
        }
        seenRefs.add(ref);
        const entry = registry[ref];
        if (!entry) {
            throw new Error(`mcpAccess ref "${ref}" was not found in ${getMcpRegistryPath()}.`);
        }
        const existing = seenNames.get(entry.name);
        if (existing) {
            throw new Error(`mcpAccess refs "${existing}" and "${ref}" resolve to the same server name "${entry.name}". Use distinct server names for stage-level isolation.`);
        }
        seenNames.set(entry.name, ref);
    }
}
export function resolveStageMcpServers(refs, options = {}) {
    if (!refs || refs.length === 0)
        return [];
    const registry = options.registry ?? loadMcpRegistry();
    validateStageMcpAccess(refs, registry);
    return refs.map((ref) => {
        const entry = registry[ref];
        if (entry.transport === 'http') {
            return {
                ref,
                name: entry.name,
                transport: 'http',
                tools: [...(entry.tools ?? [])],
                startupTimeoutSec: entry.startupTimeoutSec,
                url: replaceHostGatewayPlaceholder(entry.url, options.hostGateway),
                bearerTokenEnvVar: entry.bearerTokenEnvVar,
            };
        }
        const resolvedEnv = entry.env
            ? Object.fromEntries(Object.entries(entry.env).map(([key, value]) => [
                key,
                replaceHostGatewayPlaceholder(value, options.hostGateway),
            ]))
            : undefined;
        return {
            ref,
            name: entry.name,
            transport: 'stdio',
            tools: [...(entry.tools ?? [])],
            startupTimeoutSec: entry.startupTimeoutSec,
            command: replaceHostGatewayPlaceholder(entry.command, options.hostGateway),
            args: (entry.args ?? []).map((arg) => replaceHostGatewayPlaceholder(arg, options.hostGateway)),
            env: resolvedEnv,
        };
    });
}
export function formatStageMcpAccessSummary(servers) {
    return servers.map((server) => {
        if (server.tools.length === 0)
            return `- ${server.name} (all tools)`;
        return `- ${server.name}: ${server.tools.join(', ')}`;
    });
}
//# sourceMappingURL=mcp-registry.js.map