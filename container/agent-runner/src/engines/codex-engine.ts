import fs from 'fs';
import readline from 'readline';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { Codex } from '@openai/codex-sdk';

import { AgentEngine, NormalizedEvent, RunTurnInput } from './types.js';

type JsonRpcId = string | number;

interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  method: string;
  params?: any;
}

interface JsonRpcSuccessResponse {
  id: JsonRpcId;
  result: any;
}

interface JsonRpcErrorResponse {
  id: JsonRpcId | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

function cleanEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) cleaned[key] = value;
  }
  return cleaned;
}

function buildPrompt(basePrompt: string, ephemeralAppend?: string): string {
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
  if (contextBlocks.length === 0) return basePrompt;
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

function collectExtraDirs(): string[] {
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (!fs.existsSync(extraBase)) return extraDirs;
  for (const entry of fs.readdirSync(extraBase)) {
    const fullPath = `${extraBase}/${entry}`;
    if (fs.statSync(fullPath).isDirectory()) {
      extraDirs.push(fullPath);
    }
  }
  return extraDirs;
}

function isNotification(message: unknown): message is JsonRpcNotification {
  return (
    !!message &&
    typeof message === 'object' &&
    'method' in message &&
    !('id' in message)
  );
}

function isRequest(message: unknown): message is JsonRpcRequest {
  return (
    !!message &&
    typeof message === 'object' &&
    'method' in message &&
    'id' in message
  );
}

function isSuccessResponse(
  message: unknown,
): message is JsonRpcSuccessResponse {
  return (
    !!message &&
    typeof message === 'object' &&
    'id' in message &&
    'result' in message
  );
}

function isErrorResponse(message: unknown): message is JsonRpcErrorResponse {
  return (
    !!message &&
    typeof message === 'object' &&
    'id' in message &&
    'error' in message
  );
}

async function readProxyLogin(
  proxyUrl: string,
  path: '/login' | '/refresh',
  payload?: unknown,
): Promise<{
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType?: string | null;
}> {
  const url = `${proxyUrl}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });
  } catch (error) {
    throw new Error(
      `Codex auth proxy request failed (${url}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Codex auth proxy failed: ${response.status} ${body}`);
  }
  return (await response.json()) as {
    accessToken: string;
    chatgptAccountId: string;
    chatgptPlanType?: string | null;
  };
}

class LocalCodexAppServerClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    JsonRpcId,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
    }
  >();

  constructor(
    private readonly env: Record<string, string>,
    private readonly onNotification: (
      notification: JsonRpcNotification,
    ) => void,
    private readonly onServerRequest: (
      request: JsonRpcRequest,
    ) => Promise<unknown> | unknown,
  ) {}

  async start(): Promise<void> {
    if (this.proc) return;

    const proc = spawn('codex', ['app-server', '--listen', 'stdio://'], {
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

  async initialize(): Promise<void> {
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

  async loginWithExternalAuth(login: {
    accessToken: string;
    chatgptAccountId: string;
    chatgptPlanType?: string | null;
  }): Promise<void> {
    await this.request('account/login/start', {
      type: 'chatgptAuthTokens',
      accessToken: login.accessToken,
      chatgptAccountId: login.chatgptAccountId,
      chatgptPlanType: login.chatgptPlanType ?? null,
    });
  }

  async request(method: string, params?: unknown): Promise<any> {
    await this.start();
    const id = this.nextId++;
    const message: JsonRpcRequest = { id, method, params };
    const payload = JSON.stringify(message);

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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

    let message: any;
    try {
      message = JSON.parse(trimmed);
    } catch {
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
      if (!pending) return;
      this.pending.delete(message.id);
      pending.resolve(message.result);
      return;
    }

    if (isErrorResponse(message)) {
      const pending = this.pending.get(message.id ?? -1);
      const error = new Error(message.error.message);
      if (!pending) throw error;
      this.pending.delete(message.id ?? -1);
      pending.reject(error);
    }
  }

  private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
    const target = this.proc;
    if (!target) return;

    try {
      const result = await this.onServerRequest(request);
      target.stdin.write(JSON.stringify({ id: request.id, result }) + '\n');
    } catch (error) {
      target.stdin.write(
        JSON.stringify({
          id: request.id,
          error: {
            code: -32000,
            message:
              error instanceof Error
                ? error.message
                : 'Unhandled server request',
          },
        }) + '\n',
      );
    }
  }
}

export class CodexEngine implements AgentEngine {
  async *runTurn(input: RunTurnInput): AsyncGenerator<NormalizedEvent> {
    const authMode = process.env.ART_CODEX_AUTH_MODE ?? 'passthrough';
    if (
      authMode === 'host-managed' &&
      process.env.ART_CODEX_AUTH_PROXY_URL?.trim()
    ) {
      yield* this.runTurnViaLocalAppServer(input);
      return;
    }
    yield* this.runTurnViaSdk(input);
  }

  private async *runTurnViaSdk(
    input: RunTurnInput,
  ): AsyncGenerator<NormalizedEvent> {
    const codex = new Codex({
      baseUrl: input.sdkEnv.OPENAI_BASE_URL,
      env: cleanEnv(input.sdkEnv),
    });

    const threadOptions = {
      workingDirectory: '/workspace',
      additionalDirectories: collectExtraDirs(),
      sandboxMode: 'danger-full-access' as const,
      approvalPolicy: 'never' as const,
      skipGitRepoCheck: true,
      networkAccessEnabled: true,
    };
    const thread = input.sessionId
      ? codex.resumeThread(input.sessionId, threadOptions)
      : codex.startThread(threadOptions);
    const prompt = buildPrompt(input.prompt, input.ephemeralAppend);
    const { events } = await thread.runStreamed(prompt);

    let finalResponse: string | null = null;
    let lastMessageId: string | undefined;

    for await (const event of events) {
      if (event.type === 'thread.started') {
        yield { type: 'session.started', sessionId: event.thread_id };
        continue;
      }

      if (
        event.type === 'item.started' ||
        event.type === 'item.updated' ||
        event.type === 'item.completed'
      ) {
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
          } else if (event.type === 'item.completed') {
            yield {
              type: 'tool.result',
              id: item.id,
              isError: item.status === 'failed',
              errorText:
                item.status === 'failed'
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
          } else if (event.type === 'item.completed') {
            yield {
              type: 'tool.result',
              id: item.id,
              isError: item.status === 'failed',
              errorText: item.error?.message,
            };
          }
        }
      } else if (event.type === 'turn.completed') {
        yield { type: 'assistant.checkpoint', messageId: lastMessageId };
        yield { type: 'turn.result', result: finalResponse };
      } else if (event.type === 'turn.failed') {
        yield { type: 'turn.error', error: event.error.message };
      } else if (event.type === 'error') {
        yield { type: 'turn.error', error: event.message };
      }
    }
  }

  private async *runTurnViaLocalAppServer(
    input: RunTurnInput,
  ): AsyncGenerator<NormalizedEvent> {
    const proxyUrl = process.env.ART_CODEX_AUTH_PROXY_URL!;
    const prompt = buildPrompt(input.prompt, input.ephemeralAppend);
    let finalResponse = '';
    let lastMessageId: string | undefined;
    const emittedToolStarts = new Set<string>();

    const client = new LocalCodexAppServerClient(
      cleanEnv(input.sdkEnv),
      (notification) => {
        notificationQueue.push(notification);
        notificationResolvers.splice(0).forEach((resolve) => resolve());
      },
      async (request) => {
        if (request.method === 'account/chatgptAuthTokens/refresh') {
          const params = (request.params ?? {}) as {
            reason?: string;
            previousAccountId?: string | null;
          };
          return readProxyLogin(proxyUrl, '/refresh', {
            reason: params.reason,
            previousAccountId: params.previousAccountId ?? null,
          });
        }
        return {};
      },
    );

    const notificationQueue: JsonRpcNotification[] = [];
    const notificationResolvers: Array<() => void> = [];
    const waitForNotification = async (): Promise<JsonRpcNotification> => {
      while (notificationQueue.length === 0) {
        await new Promise<void>((resolve) =>
          notificationResolvers.push(resolve),
        );
      }
      return notificationQueue.shift()!;
    };

    try {
      await client.start();
      await client.initialize();
      await client.loginWithExternalAuth(
        await readProxyLogin(proxyUrl, '/login'),
      );

      let threadId = input.sessionId;
      if (!threadId) {
        const started = (await client.request('thread/start', {
          cwd: '/workspace',
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
          experimentalRawEvents: false,
          persistExtendedHistory: true,
          serviceName: 'art_container_codex',
        })) as { thread: { id: string } };
        threadId = started.thread.id;
      } else {
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
      })) as { turn: { id: string } };
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
          if (event.params?.turnId !== turnId || !item?.id) continue;
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
          if (event.params?.turnId !== turnId || !item?.id) continue;
          if (item.type === 'agentMessage') {
            lastMessageId = item.id;
            if (!finalResponse && item.text) finalResponse = item.text;
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
              errorText:
                item.status === 'failed'
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
          if (event.params?.turn?.id !== turnId) continue;
          if (lastMessageId) {
            yield { type: 'assistant.checkpoint', messageId: lastMessageId };
          }
          if (event.params?.turn?.status === 'failed') {
            yield {
              type: 'turn.error',
              error: String(
                event.params?.turn?.error?.message ?? 'Codex turn failed',
              ),
            };
          } else {
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
    } finally {
      await client.close();
    }
  }
}
