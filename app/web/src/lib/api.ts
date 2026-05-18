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
  graphMode?: 'live' | 'template-overview';
  templates?: Record<string, TemplateFile>;
  isRunning?: boolean;
  isRunStarting?: boolean;
  isStopping?: boolean;
}

export interface TemplateFile {
  entry?: string;
  stages: Array<{
    name: string;
    kind?: 'agent' | 'command';
    agent?: string;
    prompt?: string;
    promptSource?: string;
    command?: string;
    image?: string;
    mounts?: Record<string, 'ro' | 'rw' | null | undefined>;
    hostMounts?: Array<{
      hostPath: string;
      containerPath?: string;
      readonly?: boolean;
    }>;
    env?: Record<string, string>;
    successMarker?: string;
    errorMarker?: string;
    timeout?: number;
    transitions?: Array<{
      marker?: string;
      next?: string | string[] | null;
      template?: string;
    }>;
  }>;
}

export interface GraphNode {
  id: string;
  name: string;
  kind: 'agent' | 'command' | 'barrier' | 'template';
  status: 'pending' | 'running' | 'success' | 'error' | 'unknown';
  isStitched: boolean;
  isTemplatePlaceholder: boolean;
  templateName?: string;
  // Authored local name (pre dispatch-scope rename). Same as `name`
  // for base stages; for stitched lanes, the source-template stage
  // name — used to look up static config.
  localName?: string;
  // Run-detail mode only.
  retryCount?: number;
  nodeId?: string;
  exitCode?: number | null;
  // Barrier-only fields (kind === 'barrier').
  barrierId?: string;
  ownerNodeId?: string;
  joinPolicy?: 'all_success' | 'any_success' | 'all_settled';
  downstreamNext?: string | null;
  childNodeIds?: string[];
  // Template-overview-only fields (kind === 'template').
  templateStageCount?: number;
  templateSelfStitches?: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  marker?: string;
  isTemplate?: boolean;
  isRetry?: boolean;
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

export interface StageScriptResponse {
  name: string;
  exists: boolean;
  hostPath: string;
  size?: number;
  truncated?: boolean;
  content?: string;
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
  run: (opts?: { model?: string }) =>
    http<{ ok: true; pid: number }>('POST', '/api/run', opts ?? {}),
  stop: () => http<{ ok: true }>('POST', '/api/stop'),
  runLog: () => http<{ lines: string[] }>('GET', '/api/run/log'),
  stage: (name: string) => http<StageInfoResponse>('GET', `/api/stage/${encodeURIComponent(name)}`),
  stageScript: (name: string) =>
    http<StageScriptResponse>(
      'GET',
      `/api/stage/${encodeURIComponent(name)}/script`,
    ),
  pipelineSave: (config: unknown) => http<{ ok: true }>('POST', '/api/pipeline', { config }),
  chatOptions: () => http<ChatOptions>('GET', '/api/chat/options'),
  chatSession: (opts?: { model?: string; effort?: string; chatId?: string }) =>
    http<{
      chatId: string;
      model: string;
      effort: string;
      chatProtocolVersion?: number;
      reused?: boolean;
    }>('POST', '/api/chat/session', opts ?? {}),
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
  // --- Transparency-layer (read-only run inspection) ---
  listRuns: () => http<{ runs: RunHeader[] }>('GET', '/api/runs'),
  runDetail: (runId: string) =>
    http<RunDetail>('GET', `/api/runs/${encodeURIComponent(runId)}`),
  runEvents: (
    runId: string,
    opts?: { type?: string; limit?: number; stage?: string; node?: string },
  ) => {
    const q = new URLSearchParams();
    if (opts?.type) q.set('type', opts.type);
    if (opts?.limit !== undefined) q.set('limit', String(opts.limit));
    if (opts?.stage) q.set('stage', opts.stage);
    if (opts?.node) q.set('node', opts.node);
    const qs = q.toString() ? `?${q.toString()}` : '';
    return http<{ events: Array<Record<string, unknown>> }>(
      'GET',
      `/api/runs/${encodeURIComponent(runId)}/events${qs}`,
    );
  },
  runProvenance: (runId: string) =>
    http<Record<string, unknown>>(
      'GET',
      `/api/runs/${encodeURIComponent(runId)}/provenance`,
    ),
  runPipelineSnap: (runId: string) =>
    http<Record<string, unknown>>(
      'GET',
      `/api/runs/${encodeURIComponent(runId)}/pipeline-snap`,
    ),
  stageDetail: (runId: string, nodeId: string, stageName: string) =>
    http<StageDetail>(
      'GET',
      `/api/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(nodeId)}/${encodeURIComponent(stageName)}`,
    ),
  stagePrompt: (runId: string, nodeId: string, stageName: string) =>
    httpText(
      `/api/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(nodeId)}/${encodeURIComponent(stageName)}/prompt`,
    ),
  stageInitial: (runId: string, nodeId: string, stageName: string) =>
    httpText(
      `/api/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(nodeId)}/${encodeURIComponent(stageName)}/initial`,
    ),
  stageCommand: (runId: string, nodeId: string, stageName: string) =>
    http<{ sh: string | null; meta: Record<string, unknown> | null }>(
      'GET',
      `/api/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(nodeId)}/${encodeURIComponent(stageName)}/command`,
    ),
  stageDiffSummary: (runId: string, nodeId: string, stageName: string) =>
    http<Record<string, unknown>>(
      'GET',
      `/api/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(nodeId)}/${encodeURIComponent(stageName)}/diff`,
    ),
  stageDiff: (runId: string, nodeId: string, stageName: string, mount: string) =>
    httpText(
      `/api/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(nodeId)}/${encodeURIComponent(stageName)}/diff/${encodeURIComponent(mount)}`,
    ),
  stageTurns: (runId: string, nodeId: string, stageName: string) =>
    http<{ turns: Array<Record<string, unknown>> }>(
      'GET',
      `/api/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(nodeId)}/${encodeURIComponent(stageName)}/turns`,
    ),
  stageTranscript: (runId: string, nodeId: string, stageName: string) =>
    http<{
      records: Array<Record<string, unknown>>;
      bytes: number;
    }>(
      'GET',
      `/api/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(nodeId)}/${encodeURIComponent(stageName)}/transcript`,
    ),
  runGraph: (runId: string) =>
    http<{ nodes: GraphNode[]; edges: GraphEdge[] }>(
      'GET',
      `/api/runs/${encodeURIComponent(runId)}/graph`,
    ),
  runStages: (runId: string) =>
    http<{ stages: AllStageRecord[] }>(
      'GET',
      `/api/runs/${encodeURIComponent(runId)}/stages`,
    ),
  stageStream: (
    runId: string,
    nodeId: string,
    stageName: string,
    opts?: { kind?: 'agent' | 'stdout' | 'stderr'; tail?: number },
  ) => {
    const q = new URLSearchParams();
    if (opts?.kind) q.set('kind', opts.kind);
    if (opts?.tail !== undefined) q.set('tail', String(opts.tail));
    const qs = q.toString() ? `?${q.toString()}` : '';
    return http<{ lines: string[]; bytes: number }>(
      'GET',
      `/api/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(nodeId)}/${encodeURIComponent(stageName)}/stream${qs}`,
    );
  },
};

async function httpText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    let msg = '';
    try {
      msg = JSON.parse(await res.text()).error ?? '';
    } catch {
      /* ignore */
    }
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return res.text();
}

export type RunState = 'live' | 'crashed' | 'sealed';

export interface RunHeader {
  runId: string;
  state: RunState;
  pid?: number;
  hostname?: string;
  startTime?: string;
  provider?: string;
  outcome?: 'success' | 'error';
  endTime?: string;
  durationMs?: number;
  totalStages?: number;
  failedStages?: number;
}

export interface NodeIndex {
  nodeId: string;
  stages: string[];
}

export interface RunDetail extends RunHeader {
  runDir: string;
  args?: string[];
  schemaVersion?: number;
  hasProvenance: boolean;
  hasPipelineSnap: boolean;
  hasEvents: boolean;
  nodes: NodeIndex[];
}

export interface AllStageRecord {
  nodeId: string;
  stageName: string;
  stage: Record<string, unknown> | null;
  turnCount: number;
  turnSum: {
    tokensIn: number;
    tokensOut: number;
    cacheReadTokens: number;
    latencyMs: number;
    costUsd: number;
  };
}

export interface StageDetail {
  nodeId: string;
  stageName: string;
  stage: Record<string, unknown> | null;
  container: Record<string, unknown> | null;
  substitutions: Record<string, unknown> | null;
  promptSource: string | null;
  hasPrompt: boolean;
  hasInitial: boolean;
  hasCommand: boolean;
  hasDiff: boolean;
  hasTranscript: boolean;
  diffMounts: string[];
  turnCount: number;
  streamSizes: { agent: number; stdout: number; stderr: number };
}

/**
 * AuthoredStage — Tier 1 source of truth (what the user wrote in
 * PIPELINE.json or templates/<name>.json). Independent of any run.
 *
 * Distinct from StageDetail (Tier 2c — what the runtime archived for a
 * specific stage execution). The two get rendered in different sections
 * of the inspector so the user can tell "what was designed" from "what
 * actually ran".
 *
 * For stitched lanes, the authored config lives inside the source
 * template (`templateName`); `localName` is the pre-rename stage name
 * used to look it up.
 */
export interface AuthoredStage {
  name: string;
  kind: 'agent' | 'command';
  agent?: string;
  prompt?: string;
  promptSource?: string;
  command?: string;
  // For kind: 'command' the runtime synthesizes `command` as
  // `bash /workspace/scripts/<localName>.sh`. The L3 viewer fetches
  // the script body via /api/stage/:name/script when this is set.
  scriptStageName?: string;
  image?: string;
  mounts?: Record<string, 'ro' | 'rw' | null | undefined>;
  hostMounts?: Array<{
    hostPath: string;
    containerPath?: string;
    readonly?: boolean;
  }>;
  env?: Record<string, string>;
  successMarker?: string;
  errorMarker?: string;
  timeout?: number;
  privileged?: boolean;
  runAsRoot?: boolean;
  transitions?: Array<{
    marker?: string;
    next?: string | string[] | null;
    template?: string;
  }>;
  // null for a base-pipeline stage; the source template name for a
  // stitched-lane stage.
  templateName?: string;
  // For stitched lanes, the authored stage name (before dispatch-scope
  // rename). For base stages, equal to `name`.
  localName: string;
}

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
