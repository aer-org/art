import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import readline from 'readline';

type JsonRpcId = string | number;

interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface JsonRpcSuccessResponse {
  id: JsonRpcId;
  result: unknown;
}

interface JsonRpcErrorResponse {
  id: JsonRpcId | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

type JsonRpcInbound =
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse
  | JsonRpcRequest;

export interface CodexExternalLogin {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType?: string | null;
}

export interface CodexAppServerInitOptions {
  cwd?: string;
  clientName?: string;
  clientTitle?: string;
  clientVersion?: string;
}

export interface CodexAppServerClientOptions {
  codexBin?: string;
  env?: Record<string, string | undefined>;
  onServerRequest?: (
    request: JsonRpcRequest,
  ) => Promise<unknown> | unknown;
  onNotification?: (notification: JsonRpcNotification) => void;
}

function cleanEnv(
  env: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== undefined) cleaned[key] = value;
  }
  return cleaned;
}

function isNotification(message: unknown): message is JsonRpcNotification {
  return !!message && typeof message === 'object' && 'method' in message && !('id' in message);
}

function isRequest(message: unknown): message is JsonRpcRequest {
  return !!message && typeof message === 'object' && 'method' in message && 'id' in message;
}

function isSuccessResponse(message: unknown): message is JsonRpcSuccessResponse {
  return !!message && typeof message === 'object' && 'id' in message && 'result' in message;
}

function isErrorResponse(message: unknown): message is JsonRpcErrorResponse {
  return !!message && typeof message === 'object' && 'id' in message && 'error' in message;
}

export class CodexAppServerClient {
  private readonly codexBin: string;
  private readonly env: Record<string, string>;
  private readonly onServerRequest?: CodexAppServerClientOptions['onServerRequest'];
  private readonly onNotification?: CodexAppServerClientOptions['onNotification'];

  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    JsonRpcId,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      method: string;
    }
  >();

  constructor(options: CodexAppServerClientOptions = {}) {
    this.codexBin = options.codexBin ?? 'codex';
    this.env = cleanEnv(options.env);
    this.onServerRequest = options.onServerRequest;
    this.onNotification = options.onNotification;
  }

  async start(): Promise<void> {
    if (this.proc) return;

    const proc = spawn(this.codexBin, ['app-server', '--listen', 'stdio://'], {
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;

    proc.on('exit', (code, signal) => {
      const err = new Error(
        `codex app-server exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
      );
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

  async initialize(options: CodexAppServerInitOptions = {}): Promise<unknown> {
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

  async loginWithExternalAuth(login: CodexExternalLogin): Promise<unknown> {
    return this.request('account/login/start', {
      type: 'chatgptAuthTokens',
      accessToken: login.accessToken,
      chatgptAccountId: login.chatgptAccountId,
      chatgptPlanType: login.chatgptPlanType ?? null,
    });
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    await this.start();
    const id = this.nextId++;
    const message: JsonRpcRequest = { id, method, params };
    const payload = JSON.stringify(message);

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.proc!.stdin.write(payload + '\n', 'utf8', (err) => {
        if (!err) return;
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.start();
    const payload = JSON.stringify({ method, params });
    await new Promise<void>((resolve, reject) => {
      this.proc!.stdin.write(payload + '\n', 'utf8', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    proc.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      proc.once('exit', () => resolve());
      setTimeout(resolve, 1000);
    });
  }

  private async handleInboundLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message: JsonRpcInbound;
    try {
      message = JSON.parse(trimmed) as JsonRpcInbound;
    } catch {
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
      if (!pending) return;
      this.pending.delete(message.id);
      pending.resolve(message.result);
      return;
    }

    if (isErrorResponse(message)) {
      const pending = this.pending.get(message.id ?? -1);
      const err = new Error(message.error.message);
      if (!pending) throw err;
      this.pending.delete(message.id ?? -1);
      pending.reject(err);
    }
  }

  private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
    const responseTarget = this.proc;
    if (!responseTarget) return;

    try {
      const result = this.onServerRequest
        ? await this.onServerRequest(request)
        : {};
      responseTarget.stdin.write(
        JSON.stringify({ id: request.id, result }) + '\n',
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unhandled server request';
      responseTarget.stdin.write(
        JSON.stringify({
          id: request.id,
          error: { code: -32000, message },
        }) + '\n',
      );
    }
  }
}
