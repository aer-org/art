import { spawn } from 'child_process';
import readline from 'readline';
function cleanEnv(env) {
    const cleaned = {};
    for (const [key, value] of Object.entries(env ?? {})) {
        if (value !== undefined)
            cleaned[key] = value;
    }
    return cleaned;
}
function isNotification(message) {
    return !!message && typeof message === 'object' && 'method' in message && !('id' in message);
}
function isRequest(message) {
    return !!message && typeof message === 'object' && 'method' in message && 'id' in message;
}
function isSuccessResponse(message) {
    return !!message && typeof message === 'object' && 'id' in message && 'result' in message;
}
function isErrorResponse(message) {
    return !!message && typeof message === 'object' && 'id' in message && 'error' in message;
}
export class CodexAppServerClient {
    codexBin;
    env;
    onServerRequest;
    onNotification;
    proc = null;
    nextId = 1;
    pending = new Map();
    constructor(options = {}) {
        this.codexBin = options.codexBin ?? 'codex';
        this.env = cleanEnv(options.env);
        this.onServerRequest = options.onServerRequest;
        this.onNotification = options.onNotification;
    }
    async start() {
        if (this.proc)
            return;
        const proc = spawn(this.codexBin, ['app-server', '--listen', 'stdio://'], {
            env: { ...process.env, ...this.env },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.proc = proc;
        proc.on('exit', (code, signal) => {
            const err = new Error(`codex app-server exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
            for (const pending of this.pending.values()) {
                pending.reject(err);
            }
            this.pending.clear();
            this.proc = null;
        });
        const lineReader = readline.createInterface({ input: proc.stdout });
        lineReader.on('line', (line) => {
            void this.handleInboundLine(line);
        });
    }
    async initialize(options = {}) {
        const result = await this.request('initialize', {
            clientInfo: {
                name: options.clientName ?? 'art_codex_proxy',
                title: options.clientTitle ?? 'ART Codex Proxy',
                version: options.clientVersion ?? '0.0.0',
            },
            capabilities: {
                experimentalApi: true,
            },
        });
        await this.notify('initialized', {});
        return result;
    }
    async loginWithExternalAuth(login) {
        return this.request('account/login/start', {
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
            this.pending.set(id, { resolve, reject, method });
            this.proc.stdin.write(payload + '\n', 'utf8', (err) => {
                if (!err)
                    return;
                this.pending.delete(id);
                reject(err);
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
            this.onNotification?.(message);
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
            const err = new Error(message.error.message);
            if (!pending)
                throw err;
            this.pending.delete(message.id ?? -1);
            pending.reject(err);
        }
    }
    async handleServerRequest(request) {
        const responseTarget = this.proc;
        if (!responseTarget)
            return;
        try {
            const result = this.onServerRequest
                ? await this.onServerRequest(request)
                : {};
            responseTarget.stdin.write(JSON.stringify({ id: request.id, result }) + '\n');
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Unhandled server request';
            responseTarget.stdin.write(JSON.stringify({
                id: request.id,
                error: { code: -32000, message },
            }) + '\n');
        }
    }
}
//# sourceMappingURL=codex-app-server-client.js.map