export interface BrowseEntry {
  name: string;
  path: string;
  hasArt: boolean;
}

export interface BrowseResponse {
  path: string;
  parent: string | null;
  home: string;
  hasArt: boolean;
  entries: BrowseEntry[];
}

export interface PipelineSnapshot {
  projectDir: string | null;
  initialized?: boolean;
  pipeline?: any;
  pipelineError?: string;
  state?: any;
  latestRun?: any;
  graph?: { nodes: GraphNode[]; edges: GraphEdge[] };
  isRunning?: boolean;
  isRunStarting?: boolean;
}

export interface GraphNode {
  id: string;
  name: string;
  kind: 'agent' | 'command';
  status: 'pending' | 'running' | 'success' | 'error' | 'unknown';
  isStitched: boolean;
  isTemplatePlaceholder: boolean;
  templateName?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  marker?: string;
  isTemplate?: boolean;
}

export interface PreflightResponse {
  ok: boolean;
  art: { present: boolean; version?: string; error?: string };
  claude: { present: boolean; version?: string; error?: string };
  containerRuntime: { present: boolean; which?: string; error?: string };
  debuggerSandbox: { present: boolean; executable?: string; error?: string };
  auth: AuthStatus;
}

export interface AuthStatus {
  present: boolean;
  source?: string;
  error?: string;
  kind?: 'api-key' | 'oauth-token' | 'auth-token' | 'codex-provider' | 'missing';
  chatReady: boolean;
  chatSource?: string;
  chatError?: string;
}

export interface ClaudeSetupTokenOutputChunk {
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  ts: string;
}

export type ClaudeSetupTokenScope = 'runtime' | 'debugger';

export interface ClaudeSetupTokenStatus {
  scope?: ClaudeSetupTokenScope;
  running: boolean;
  pid?: number;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  output?: ClaudeSetupTokenOutputChunk[];
}

export interface NodeLogLine {
  stage: string;
  kind: 'stdout' | 'stderr';
  line: string;
  sourceFile?: string;
}

export interface StageInfoResponse {
  name: string;
  config: any;
  runtime: {
    currentStage: string | string[] | null;
    completed: boolean;
    runStatus: string | null;
    runStage: { name: string; status: string; duration?: number } | null;
    latestRun: { runId: string; status: string; startTime: string; endTime?: string } | null;
  };
  logs: {
    pipelineLogFile: string | null;
    nodeLogFile: string | null;
    nodeTail: NodeLogLine[];
    pipelineTail: string[];
    containerLogs: { file: string; tail: string }[];
  };
  transitions: any[];
}

async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = text;
    try { msg = JSON.parse(text).error ?? text; } catch { /* ignore */ }
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  preflight: () => http<PreflightResponse>('GET', '/api/preflight'),
  preflightForce: () => http<PreflightResponse>('GET', '/api/preflight?force=1'),
  authStatus: () => http<AuthStatus>('GET', '/api/setup/auth'),
  claudeSetupTokenStatus: (scope?: ClaudeSetupTokenScope) =>
    http<ClaudeSetupTokenStatus>(
      'GET',
      `/api/setup/claude-token${scope ? `?scope=${encodeURIComponent(scope)}` : ''}`,
    ),
  launchClaudeSetupToken: (scope: ClaudeSetupTokenScope = 'runtime') =>
    http<{ ok: true; status: ClaudeSetupTokenStatus }>('POST', '/api/setup/claude-token', { scope }),
  sendClaudeSetupTokenInput: (input: string) =>
    http<{ ok: true; status: ClaudeSetupTokenStatus }>('POST', '/api/setup/claude-token/input', { input }),
  saveAuthToken: (token: string) =>
    http<{ ok: true; auth: AuthStatus; preflight: PreflightResponse }>('POST', '/api/setup/auth-token', { token }),
  browse: (p?: string) => http<BrowseResponse>('GET', `/api/browse${p ? `?path=${encodeURIComponent(p)}` : ''}`),
  load: (path: string) => http<PipelineSnapshot>('POST', '/api/load', { path }),
  current: () => http<PipelineSnapshot>('GET', '/api/current'),
  run: () => http<{ ok: true; pid: number }>('POST', '/api/run'),
  stop: () => http<{ ok: true }>('POST', '/api/stop'),
  runLog: () => http<{ lines: string[] }>('GET', '/api/run/log'),
  stage: (name: string) => http<StageInfoResponse>('GET', `/api/stage/${encodeURIComponent(name)}`),
  pipelineSave: (config: unknown) => http<{ ok: true }>('POST', '/api/pipeline', { config }),
  chatOptions: () => http<ChatOptions>('GET', '/api/chat/options'),
  chatSession: (opts?: { model?: string; effort?: string }) =>
    http<{ chatId: string; model: string; effort: string; chatProtocolVersion?: number }>(
      'POST',
      '/api/chat/session',
      opts ?? {},
    ),
  chatSettings: (chatId: string, opts: { model?: string; effort?: string }) =>
    http<{ ok: true; model: string; effort: string; chatProtocolVersion?: number }>(
      'POST',
      '/api/chat/settings',
      { chatId, ...opts },
    ),
  chatSend: (chatId: string, message: string) =>
    http<{ ok: true; turnId: string; chatProtocolVersion?: number }>('POST', '/api/chat', { chatId, message }),
  chatCancel: (chatId: string) => http<{ ok: true }>('POST', '/api/chat/cancel', { chatId }),
  chatPermission: (chatId: string, permissionId: string, decision: 'allow_once' | 'allow_project' | 'deny') =>
    http<{ ok: true }>('POST', '/api/chat/permission', { chatId, permissionId, decision }),
};

export interface ChatOptions {
  chatProtocolVersion?: number;
  models: { id: string; label: string }[];
  efforts: string[];
  defaults: { model: string; effort: string };
}

export function subscribeSSE(
  url: string,
  handlers: Record<string, (data: any) => void>,
  opts?: { onOpen?: () => void; onError?: (event: Event) => void },
): () => void {
  const es = new EventSource(url);
  if (opts?.onOpen) es.addEventListener('open', opts.onOpen);
  if (opts?.onError) es.addEventListener('error', opts.onError);
  for (const [event, handler] of Object.entries(handlers)) {
    es.addEventListener(event, (e) => {
      try { handler(JSON.parse((e as MessageEvent).data)); }
      catch { handler((e as MessageEvent).data); }
    });
  }
  return () => {
    if (opts?.onOpen) es.removeEventListener('open', opts.onOpen);
    if (opts?.onError) es.removeEventListener('error', opts.onError);
    es.close();
  };
}
