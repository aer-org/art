import fs from 'fs';
import readline from 'readline';
import { spawn } from 'child_process';
import { Codex } from '@openai/codex-sdk';
function cleanEnv(env) {
    const cleaned = {};
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined)
            cleaned[key] = value;
    }
    return cleaned;
}
function buildPrompt(basePrompt, ephemeralAppend) {
    const globalDocPathCandidates = [
        '/workspace/global/AGENTS.md',
        '/workspace/global/CLAUDE.md',
    ];
    let globalDoc = '';
    for (const candidate of globalDocPathCandidates) {
        if (fs.existsSync(candidate)) {
            globalDoc = fs.readFileSync(candidate, 'utf-8');
            break;
        }
    }
    const contextBlocks = [globalDoc, ephemeralAppend].filter(Boolean);
    if (contextBlocks.length === 0)
        return basePrompt;
    return [
        'The following context is system-level guidance for this turn. Treat it as higher priority than the user request.',
        '',
        '<system_context>',
        contextBlocks.join('\n\n'),
        '</system_context>',
        '',
        basePrompt,
    ].join('\n');
}
function collectExtraDirs() {
    const extraDirs = [];
    const extraBase = '/workspace/extra';
    if (!fs.existsSync(extraBase))
        return extraDirs;
    for (const entry of fs.readdirSync(extraBase)) {
        const fullPath = `${extraBase}/${entry}`;
        if (fs.statSync(fullPath).isDirectory()) {
            extraDirs.push(fullPath);
        }
    }
    return extraDirs;
}
function isNotification(message) {
    return (!!message &&
        typeof message === 'object' &&
        'method' in message &&
        !('id' in message));
}
function isRequest(message) {
    return (!!message &&
        typeof message === 'object' &&
        'method' in message &&
        'id' in message);
}
function isSuccessResponse(message) {
    return (!!message &&
        typeof message === 'object' &&
        'id' in message &&
        'result' in message);
}
function isErrorResponse(message) {
    return (!!message &&
        typeof message === 'object' &&
        'id' in message &&
        'error' in message);
}
async function readProxyLogin(proxyUrl, path, payload) {
    const url = `${proxyUrl}${path}`;
    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload ?? {}),
        });
    }
    catch (error) {
        throw new Error(`Codex auth proxy request failed (${url}): ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Codex auth proxy failed: ${response.status} ${body}`);
    }
    return (await response.json());
}
class LocalCodexAppServerClient {
    env;
    onNotification;
    onServerRequest;
    proc = null;
    nextId = 1;
    pending = new Map();
    constructor(env, onNotification, onServerRequest) {
        this.env = env;
        this.onNotification = onNotification;
        this.onServerRequest = onServerRequest;
    }
    async start() {
        if (this.proc)
            return;
        const proc = spawn('codex', ['app-server', '--listen', 'stdio://'], {
            env: { ...process.env, ...this.env },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.proc = proc;
        proc.on('exit', (code, signal) => {
            for (const pending of this.pending.values()) {
                pending.reject(new Error(`Codex app-server request "${pending.method}" failed: app-server exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`));
            }
            this.pending.clear();
            this.proc = null;
        });
        const lineReader = readline.createInterface({ input: proc.stdout });
        lineReader.on('line', (line) => {
            void this.handleInboundLine(line);
        });
        const stderrReader = readline.createInterface({ input: proc.stderr });
        stderrReader.on('line', (line) => {
            if (line.trim())
                console.error(`[codex-app-server] ${line}`);
        });
    }
    async initialize() {
        await this.request('initialize', {
            clientInfo: {
                name: 'art_container_codex',
                title: 'ART Container Codex',
                version: '0.0.0',
            },
            capabilities: {
                experimentalApi: true,
            },
        });
        await this.notify('initialized', {});
    }
    async loginWithExternalAuth(login) {
        await this.request('account/login/start', {
            type: 'chatgptAuthTokens',
            accessToken: login.accessToken,
            chatgptAccountId: login.chatgptAccountId,
            chatgptPlanType: login.chatgptPlanType ?? null,
        });
    }
    async request(method, params) {
        await this.start();
        const id = this.nextId++;
        const message = { id, method, params };
        const payload = JSON.stringify(message);
        return new Promise((resolve, reject) => {
            this.pending.set(id, { method, resolve, reject });
            this.proc.stdin.write(payload + '\n', 'utf8', (err) => {
                if (!err)
                    return;
                this.pending.delete(id);
                reject(new Error(`Codex app-server request "${method}" failed while writing stdin: ${err.message}`));
            });
        });
    }
    async notify(method, params) {
        await this.start();
        const payload = JSON.stringify({ method, params });
        await new Promise((resolve, reject) => {
            this.proc.stdin.write(payload + '\n', 'utf8', (err) => {
                if (err)
                    reject(err);
                else
                    resolve();
            });
        });
    }
    async close() {
        if (!this.proc)
            return;
        const proc = this.proc;
        this.proc = null;
        proc.kill('SIGTERM');
        await new Promise((resolve) => {
            proc.once('exit', () => resolve());
            setTimeout(resolve, 1000);
        });
    }
    async handleInboundLine(line) {
        const trimmed = line.trim();
        if (!trimmed)
            return;
        let message;
        try {
            message = JSON.parse(trimmed);
        }
        catch {
            return;
        }
        if (isNotification(message)) {
            this.onNotification(message);
            return;
        }
        if (isRequest(message)) {
            await this.handleServerRequest(message);
            return;
        }
        if (isSuccessResponse(message)) {
            const pending = this.pending.get(message.id);
            if (!pending)
                return;
            this.pending.delete(message.id);
            pending.resolve(message.result);
            return;
        }
        if (isErrorResponse(message)) {
            const pending = this.pending.get(message.id ?? -1);
            const messageText = message.error.message;
            if (!pending)
                throw new Error(messageText);
            this.pending.delete(message.id ?? -1);
            pending.reject(new Error(`Codex app-server request "${pending.method}" failed: ${messageText}`));
        }
    }
    async handleServerRequest(request) {
        const target = this.proc;
        if (!target)
            return;
        try {
            const result = await this.onServerRequest(request);
            target.stdin.write(JSON.stringify({ id: request.id, result }) + '\n');
        }
        catch (error) {
            target.stdin.write(JSON.stringify({
                id: request.id,
                error: {
                    code: -32000,
                    message: error instanceof Error
                        ? error.message
                        : 'Unhandled server request',
                },
            }) + '\n');
        }
    }
}
export class CodexEngine {
    async *runTurn(input) {
        const authMode = process.env.ART_CODEX_AUTH_MODE ?? 'passthrough';
        if (authMode === 'host-managed' &&
            process.env.ART_CODEX_AUTH_PROXY_URL?.trim()) {
            yield* this.runTurnViaLocalAppServer(input);
            return;
        }
        yield* this.runTurnViaSdk(input);
    }
    async *runTurnViaSdk(input) {
        const codex = new Codex({
            baseUrl: input.sdkEnv.OPENAI_BASE_URL,
            env: cleanEnv(input.sdkEnv),
        });
        const threadOptions = {
            workingDirectory: '/workspace',
            additionalDirectories: collectExtraDirs(),
            sandboxMode: 'danger-full-access',
            approvalPolicy: 'never',
            skipGitRepoCheck: true,
            networkAccessEnabled: true,
        };
        const thread = input.sessionId
            ? codex.resumeThread(input.sessionId, threadOptions)
            : codex.startThread(threadOptions);
        const prompt = buildPrompt(input.prompt, input.ephemeralAppend);
        const { events } = await thread.runStreamed(prompt);
        let finalResponse = null;
        let lastMessageId;
        for await (const event of events) {
            if (event.type === 'thread.started') {
                yield { type: 'session.started', sessionId: event.thread_id };
                continue;
            }
            if (event.type === 'item.started' ||
                event.type === 'item.updated' ||
                event.type === 'item.completed') {
                const { item } = event;
                if (item.type === 'agent_message') {
                    finalResponse = item.text;
                    lastMessageId = item.id;
                    if (event.type === 'item.completed') {
                        yield { type: 'assistant.text', text: item.text };
                        yield { type: 'assistant.checkpoint', messageId: item.id };
                    }
                    continue;
                }
                if (item.type === 'command_execution') {
                    if (event.type === 'item.started') {
                        yield {
                            type: 'tool.started',
                            id: item.id,
                            name: 'Bash',
                            preview: item.command,
                            input: { command: item.command },
                        };
                    }
                    else if (event.type === 'item.completed') {
                        yield {
                            type: 'tool.result',
                            id: item.id,
                            isError: item.status === 'failed',
                            errorText: item.status === 'failed'
                                ? item.aggregated_output.slice(-4000)
                                : undefined,
                        };
                    }
                    continue;
                }
                if (item.type === 'mcp_tool_call') {
                    if (event.type === 'item.started') {
                        yield {
                            type: 'tool.started',
                            id: item.id,
                            name: `${item.server}__${item.tool}`,
                            preview: `${item.server}/${item.tool}`,
                            input: item.arguments,
                        };
                    }
                    else if (event.type === 'item.completed') {
                        yield {
                            type: 'tool.result',
                            id: item.id,
                            isError: item.status === 'failed',
                            errorText: item.error?.message,
                        };
                    }
                }
            }
            else if (event.type === 'turn.completed') {
                yield { type: 'assistant.checkpoint', messageId: lastMessageId };
                yield { type: 'turn.result', result: finalResponse };
            }
            else if (event.type === 'turn.failed') {
                yield { type: 'turn.error', error: event.error.message };
            }
            else if (event.type === 'error') {
                yield { type: 'turn.error', error: event.message };
            }
        }
    }
    async *runTurnViaLocalAppServer(input) {
        const proxyUrl = process.env.ART_CODEX_AUTH_PROXY_URL;
        const prompt = buildPrompt(input.prompt, input.ephemeralAppend);
        let finalResponse = '';
        let lastMessageId;
        const emittedToolStarts = new Set();
        const client = new LocalCodexAppServerClient(cleanEnv(input.sdkEnv), (notification) => {
            notificationQueue.push(notification);
            notificationResolvers.splice(0).forEach((resolve) => resolve());
        }, async (request) => {
            if (request.method === 'account/chatgptAuthTokens/refresh') {
                const params = (request.params ?? {});
                return readProxyLogin(proxyUrl, '/refresh', {
                    reason: params.reason,
                    previousAccountId: params.previousAccountId ?? null,
                });
            }
            return {};
        });
        const notificationQueue = [];
        const notificationResolvers = [];
        const waitForNotification = async () => {
            while (notificationQueue.length === 0) {
                await new Promise((resolve) => notificationResolvers.push(resolve));
            }
            return notificationQueue.shift();
        };
        const loginWithProxyAuth = async () => {
            const initialLogin = await readProxyLogin(proxyUrl, '/login');
            try {
                await client.loginWithExternalAuth(initialLogin);
                return;
            }
            catch (error) {
                const initialError = error instanceof Error ? error.message : String(error);
                const refreshedLogin = await readProxyLogin(proxyUrl, '/refresh', {
                    reason: 'account_login_start_failed',
                    previousAccountId: initialLogin.chatgptAccountId,
                });
                try {
                    await client.loginWithExternalAuth(refreshedLogin);
                    return;
                }
                catch (retryError) {
                    throw new Error(`Codex app-server login failed after forced refresh: ${retryError instanceof Error ? retryError.message : String(retryError)} (initial failure: ${initialError})`);
                }
            }
        };
        try {
            await client.start();
            await client.initialize();
            await loginWithProxyAuth();
            let threadId = input.sessionId;
            if (!threadId) {
                const started = (await client.request('thread/start', {
                    cwd: '/workspace',
                    approvalPolicy: 'never',
                    sandbox: 'danger-full-access',
                    experimentalRawEvents: false,
                    persistExtendedHistory: true,
                    serviceName: 'art_container_codex',
                }));
                threadId = started.thread.id;
            }
            else {
                await client.request('thread/resume', {
                    threadId,
                    cwd: '/workspace',
                    approvalPolicy: 'never',
                    sandbox: 'danger-full-access',
                    persistExtendedHistory: true,
                });
            }
            yield { type: 'session.started', sessionId: threadId };
            const turnStart = (await client.request('turn/start', {
                threadId,
                input: [{ type: 'text', text: prompt, text_elements: [] }],
            }));
            const turnId = turnStart.turn.id;
            while (true) {
                const event = await waitForNotification();
                if (event.method === 'item/agentMessage/delta') {
                    const delta = String(event.params?.delta ?? '');
                    finalResponse += delta;
                    yield { type: 'assistant.text', text: delta };
                    continue;
                }
                if (event.method === 'thread/started') {
                    yield {
                        type: 'session.started',
                        sessionId: String(event.params?.thread?.id ?? threadId),
                    };
                    continue;
                }
                if (event.method === 'item/started') {
                    const item = event.params?.item;
                    if (event.params?.turnId !== turnId || !item?.id)
                        continue;
                    if (item.type === 'commandExecution') {
                        emittedToolStarts.add(item.id);
                        yield {
                            type: 'tool.started',
                            id: item.id,
                            name: 'Bash',
                            preview: item.command,
                            input: { command: item.command },
                        };
                        continue;
                    }
                    if (item.type === 'mcpToolCall') {
                        emittedToolStarts.add(item.id);
                        yield {
                            type: 'tool.started',
                            id: item.id,
                            name: `${item.server}__${item.tool}`,
                            preview: `${item.server}/${item.tool}`,
                            input: item.arguments,
                        };
                    }
                    continue;
                }
                if (event.method === 'item/completed') {
                    const item = event.params?.item;
                    if (event.params?.turnId !== turnId || !item?.id)
                        continue;
                    if (item.type === 'agentMessage') {
                        lastMessageId = item.id;
                        if (!finalResponse && item.text)
                            finalResponse = item.text;
                        yield { type: 'assistant.checkpoint', messageId: item.id };
                        continue;
                    }
                    if (item.type === 'commandExecution') {
                        if (!emittedToolStarts.has(item.id)) {
                            yield {
                                type: 'tool.started',
                                id: item.id,
                                name: 'Bash',
                                preview: item.command,
                                input: { command: item.command },
                            };
                        }
                        yield {
                            type: 'tool.result',
                            id: item.id,
                            isError: item.status === 'failed',
                            errorText: item.status === 'failed'
                                ? String(item.aggregatedOutput ?? '').slice(-4000)
                                : undefined,
                        };
                        continue;
                    }
                    if (item.type === 'mcpToolCall') {
                        if (!emittedToolStarts.has(item.id)) {
                            yield {
                                type: 'tool.started',
                                id: item.id,
                                name: `${item.server}__${item.tool}`,
                                preview: `${item.server}/${item.tool}`,
                                input: item.arguments,
                            };
                        }
                        yield {
                            type: 'tool.result',
                            id: item.id,
                            isError: item.status === 'failed',
                            errorText: item.error?.message,
                        };
                    }
                    continue;
                }
                if (event.method === 'turn/completed') {
                    if (event.params?.turn?.id !== turnId)
                        continue;
                    if (lastMessageId) {
                        yield { type: 'assistant.checkpoint', messageId: lastMessageId };
                    }
                    if (event.params?.turn?.status === 'failed') {
                        yield {
                            type: 'turn.error',
                            error: String(event.params?.turn?.error?.message ?? 'Codex turn failed'),
                        };
                    }
                    else {
                        yield { type: 'turn.result', result: finalResponse || null };
                    }
                    break;
                }
                if (event.method === 'error') {
                    yield {
                        type: 'turn.error',
                        error: String(event.params?.message ?? 'Codex app-server error'),
                    };
                    break;
                }
            }
        }
        finally {
            await client.close();
        }
    }
}
