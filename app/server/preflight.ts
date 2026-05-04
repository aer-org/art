import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ART_BIN, ART_DIR_NAME, CLAUDE_BIN, childProcessEnv } from './config.ts';
import { debuggerSandboxStatus, type DebuggerSandboxStatus } from './debugger-sandbox.ts';

const execFileP = promisify(execFile);

export interface PreflightResult {
  ok: boolean;
  art: { present: boolean; version?: string; error?: string };
  claude: { present: boolean; version?: string; error?: string };
  containerRuntime: { present: boolean; which?: string; error?: string };
  debuggerSandbox: DebuggerSandboxStatus;
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

let cached: { at: number; projectDir?: string; result: PreflightResult } | null = null;
let claudeSetupTokenProcess: ChildProcess | null = null;
let claudeSetupTokenUsesPty = false;
let lastClaudeSetupTokenStatus: ClaudeSetupTokenStatus = { running: false };
let setupTokenInputRedactions: string[] = [];
let capturedSetupToken: string | null = null;
const CACHE_MS = 60_000;
const SETUP_TOKEN_OUTPUT_LIMIT = 60_000;
const TOKEN_FILE = path.join(os.homedir(), '.config', 'aer-art', 'token');
const CLAUDE_CREDENTIALS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
const SCRIPT_BIN = process.env.ART_APP_SCRIPT_BIN ?? 'script';
const DEBUGGER_DIR_NAME = '.debugger';
const DEBUGGER_CLAUDE_CONFIG_DIR_NAME = 'claude-config';
const TOKEN_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  '_ART_OAUTH_TOKEN',
] as const;
type TokenEnvKey = typeof TOKEN_ENV_KEYS[number];
const CLAUDE_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  '_ART_OAUTH_TOKEN',
] as const;

async function tryVersion(bin: string): Promise<{ present: boolean; version?: string; error?: string }> {
  try {
    const { stdout } = await execFileP(bin, ['--version'], {
      env: childProcessEnv(),
      timeout: 5000,
    });
    return { present: true, version: stdout.trim().split('\n')[0] };
  } catch (e) {
    return { present: false, error: (e as Error).message };
  }
}

async function detectContainerRuntime(): Promise<{ present: boolean; which?: string; error?: string }> {
  for (const [bin, args] of [
    ['docker', ['info']],
    ['podman', ['info']],
    ['udocker', ['version']],
  ] as const) {
    try {
      await execFileP(bin, args, { env: childProcessEnv(), timeout: 10000 });
      return { present: true, which: bin };
    } catch {
      // try next
    }
  }
  return { present: false, error: 'No container runtime found (docker, podman, or udocker).' };
}

function cleanEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readProjectEnvTokenValue(projectDir?: string): { key: TokenEnvKey; value: string } | null {
  if (!projectDir) return null;
  try {
    const env = fs.readFileSync(path.join(projectDir, '.env'), 'utf8');
    for (const line of env.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      for (const key of TOKEN_ENV_KEYS) {
        const prefix = `${key}=`;
        if (trimmed.startsWith(prefix) && trimmed.slice(prefix.length).trim()) {
          return { key, value: cleanEnvValue(trimmed.slice(prefix.length)) };
        }
      }
    }
  } catch {
    // no project .env or unreadable
  }
  return null;
}

function readSavedToken(): string | null {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function writeSavedToken(token: string): void {
  const dir = path.dirname(TOKEN_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  cached = null;
}

function readClaudeCredentialsToken(credentialsFile: string): string | null {
  try {
    const raw = fs.readFileSync(credentialsFile, 'utf8');
    const creds = JSON.parse(raw);
    const oauth = creds?.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    const expiresAt =
      typeof oauth.expiresAt === 'number'
        ? oauth.expiresAt
        : typeof oauth.expiresAt === 'string'
          ? Date.parse(oauth.expiresAt)
          : null;
    if (expiresAt && Number.isFinite(expiresAt) && Date.now() > expiresAt - 60_000) {
      return null;
    }
    return String(oauth.accessToken);
  } catch {
    return null;
  }
}

function readClaudeCliToken(): string | null {
  return readClaudeCredentialsToken(CLAUDE_CREDENTIALS_FILE);
}

function debuggerClaudeConfigDir(projectDir?: string): string | null {
  if (!projectDir) return null;
  try {
    const canonicalProjectDir = fs.realpathSync(projectDir);
    return path.join(canonicalProjectDir, ART_DIR_NAME, DEBUGGER_DIR_NAME, DEBUGGER_CLAUDE_CONFIG_DIR_NAME);
  } catch {
    return null;
  }
}

function debuggerClaudeCredentialsFile(projectDir?: string): string | null {
  const configDir = debuggerClaudeConfigDir(projectDir);
  return configDir ? path.join(configDir, '.credentials.json') : null;
}

function readDebuggerClaudeToken(projectDir?: string): string | null {
  const credentialsFile = debuggerClaudeCredentialsFile(projectDir);
  return credentialsFile ? readClaudeCredentialsToken(credentialsFile) : null;
}

function isOAuthLikeToken(token: string): boolean {
  return /^sk-ant-o/i.test(token) || /\boauth\b/i.test(token);
}

function isApiKeyLikeToken(token: string): boolean {
  return /^sk-ant-api/i.test(token);
}

function authKindForToken(
  key: TokenEnvKey | 'saved-token' | 'claude-cli' | 'debugger-cli',
  token?: string,
): AuthStatus['kind'] {
  if (key === 'ANTHROPIC_AUTH_TOKEN') return 'auth-token';
  if (token && isApiKeyLikeToken(token)) return 'api-key';
  if (key === 'ANTHROPIC_API_KEY' && token && !isOAuthLikeToken(token)) return 'api-key';
  return 'oauth-token';
}

function runtimeAuthStatus(projectDir?: string): Pick<AuthStatus, 'present' | 'source' | 'error' | 'kind'> {
  if (process.env.ART_AGENT_PROVIDER === 'codex') {
    return { present: true, source: 'Codex provider selected', kind: 'codex-provider' };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      present: true,
      source: 'ANTHROPIC_API_KEY',
      kind: authKindForToken('ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY),
    };
  }
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    return { present: true, source: 'ANTHROPIC_AUTH_TOKEN', kind: 'auth-token' };
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { present: true, source: 'CLAUDE_CODE_OAUTH_TOKEN', kind: 'oauth-token' };
  }
  if (process.env._ART_OAUTH_TOKEN) {
    return { present: true, source: 'process token', kind: 'oauth-token' };
  }

  const projectEnvToken = readProjectEnvTokenValue(projectDir);
  if (projectEnvToken) {
    return {
      present: true,
      source: `${projectEnvToken.key} in project .env`,
      kind: authKindForToken(projectEnvToken.key, projectEnvToken.value),
    };
  }

  const savedToken = readSavedToken();
  if (savedToken) {
    return {
      present: true,
      source: '~/.config/aer-art/token',
      kind: authKindForToken('saved-token', savedToken),
    };
  }

  const claudeCliToken = readClaudeCliToken();
  if (claudeCliToken) {
    return {
      present: true,
      source: 'Claude CLI credentials',
      kind: authKindForToken('claude-cli', claudeCliToken),
    };
  }

  return {
    present: false,
    kind: 'missing',
    error: 'No Claude authentication found. Open Initial Setup for ART runtime OAuth.',
  };
}

function debuggerChatStatus(projectDir?: string): Pick<AuthStatus, 'chatReady' | 'chatSource' | 'chatError'> {
  const debuggerToken = readDebuggerClaudeToken(projectDir);
  if (debuggerToken) {
    return {
      chatReady: true,
      chatSource: 'Left-panel Claude OAuth',
    };
  }

  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return {
      chatReady: true,
      chatSource: 'CLAUDE_CODE_OAUTH_TOKEN',
    };
  }

  if (process.env.ANTHROPIC_API_KEY && !isOAuthLikeToken(process.env.ANTHROPIC_API_KEY)) {
    return {
      chatReady: true,
      chatSource: 'ANTHROPIC_API_KEY',
    };
  }

  const projectEnvToken = readProjectEnvTokenValue(projectDir);
  if (projectEnvToken?.key === 'CLAUDE_CODE_OAUTH_TOKEN') {
    return {
      chatReady: true,
      chatSource: 'CLAUDE_CODE_OAUTH_TOKEN in project .env',
    };
  }
  if (projectEnvToken?.key === 'ANTHROPIC_API_KEY' && !isOAuthLikeToken(projectEnvToken.value)) {
    return {
      chatReady: true,
      chatSource: 'ANTHROPIC_API_KEY in project .env',
    };
  }

  const savedToken = readSavedToken();
  if (savedToken) {
    return {
      chatReady: true,
      chatSource: '~/.config/aer-art/token',
    };
  }

  return {
    chatReady: false,
    chatError: projectDir
      ? 'Left-panel Claude OAuth is not configured. Use this row’s Setup button.'
      : 'Load a project, then use the left-panel chat Setup button.',
  };
}

function withoutClaudeAuthEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of CLAUDE_AUTH_ENV_KEYS) delete clean[key];
  return clean;
}

export function resolveClaudeAuthEnv(projectDir?: string): NodeJS.ProcessEnv {
  if (readDebuggerClaudeToken(projectDir)) return {};

  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  }

  if (process.env.ANTHROPIC_API_KEY && !isOAuthLikeToken(process.env.ANTHROPIC_API_KEY)) {
    return { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  }

  const projectEnvToken = readProjectEnvTokenValue(projectDir);
  if (projectEnvToken?.key === 'CLAUDE_CODE_OAUTH_TOKEN') {
    return { CLAUDE_CODE_OAUTH_TOKEN: projectEnvToken.value };
  }
  if (
    projectEnvToken?.key === 'ANTHROPIC_API_KEY' &&
    !isOAuthLikeToken(projectEnvToken.value)
  ) {
    return { ANTHROPIC_API_KEY: projectEnvToken.value };
  }

  const savedToken = readSavedToken();
  if (savedToken) {
    return isApiKeyLikeToken(savedToken)
      ? { ANTHROPIC_API_KEY: savedToken }
      : { CLAUDE_CODE_OAUTH_TOKEN: savedToken };
  }

  return {};
}

export function childProcessEnvForDebugger(projectDir?: string): NodeJS.ProcessEnv {
  return {
    ...withoutClaudeAuthEnv(childProcessEnv()),
    ...resolveClaudeAuthEnv(projectDir),
  };
}

export function authStatus(projectDir?: string): AuthStatus {
  return {
    ...runtimeAuthStatus(projectDir),
    ...debuggerChatStatus(projectDir),
  };
}

export function saveAuthToken(token: string): AuthStatus {
  const trimmed = token.trim();
  if (!trimmed) {
    return {
      present: false,
      kind: 'missing',
      chatReady: false,
      error: 'Token is empty.',
      chatError: 'Token is empty.',
    };
  }
  writeSavedToken(trimmed);
  return {
    present: true,
    source: '~/.config/aer-art/token',
    kind: authKindForToken('saved-token', trimmed),
    ...debuggerChatStatus(),
  };
}

export function claudeSetupTokenStatus(scope?: ClaudeSetupTokenScope): ClaudeSetupTokenStatus {
  if (scope && lastClaudeSetupTokenStatus.scope && lastClaudeSetupTokenStatus.scope !== scope) {
    return { scope, running: false };
  }
  return {
    scope: scope ?? lastClaudeSetupTokenStatus.scope,
    ...lastClaudeSetupTokenStatus,
    output: lastClaudeSetupTokenStatus.output?.slice(),
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function setupTokenScopeLabel(scope: ClaudeSetupTokenScope): string {
  return scope === 'debugger' ? 'left-panel Claude OAuth' : 'ART runtime Claude OAuth';
}

function setupTokenSpawnCommand(scope: ClaudeSetupTokenScope): { command: string; args: string[]; label: string; usesPty: boolean } {
  const label = `${setupTokenScopeLabel(scope)} (${CLAUDE_BIN} setup-token)`;
  if (process.platform === 'win32' || process.env.ART_APP_SETUP_TOKEN_PTY === '0') {
    return {
      command: CLAUDE_BIN,
      args: ['setup-token'],
      label,
      usesPty: false,
    };
  }

  const quotedClaude = shellQuote(CLAUDE_BIN);
  const command = `stty -echo 2>/dev/null; ${quotedClaude} setup-token; status=$?; stty echo 2>/dev/null; exit $status`;
  return {
    command: SCRIPT_BIN,
    args: ['-q', '-f', '-e', '-c', command, '/dev/null'],
    label,
    usesPty: true,
  };
}

function setupTokenEnv(scope: ClaudeSetupTokenScope, projectDir?: string): NodeJS.ProcessEnv {
  if (scope === 'runtime') return childProcessEnv();

  const configDir = debuggerClaudeConfigDir(projectDir);
  if (!configDir) {
    throw new Error('Load a project before setting up left-panel Claude OAuth.');
  }
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  return {
    ...withoutClaudeAuthEnv(childProcessEnv()),
    CLAUDE_CONFIG_DIR: configDir,
  };
}

function rememberSetupTokenInputForRedaction(input: string): void {
  const trimmed = input.replace(/[\r\n]+$/g, '');
  if (!trimmed) return;
  rememberSetupTokenSecretForRedaction(trimmed);
}

function rememberSetupTokenSecretForRedaction(secret: string): void {
  const trimmed = secret.trim();
  if (!trimmed) return;
  setupTokenInputRedactions = [
    trimmed,
    ...setupTokenInputRedactions.filter((value) => value !== trimmed),
  ].slice(0, 8);
}

function redactSetupTokenOutput(text: string): string {
  let redacted = text;
  for (const secret of setupTokenInputRedactions) {
    if (!secret) continue;
    redacted = redacted.split(secret).join('[input hidden]');
  }
  return redacted
    .replace(/\bexport\s+CLAUDE_CODE_OAUTH_TOKEN\s*=\s*[^\s'"<>]+/gi, 'export CLAUDE_CODE_OAUTH_TOKEN=[saved token hidden]')
    .replace(/\bCLAUDE_CODE_OAUTH_TOKEN\s*=\s*[^\s'"<>]+/gi, 'CLAUDE_CODE_OAUTH_TOKEN=[saved token hidden]')
    .replace(/\bsk-ant-o[^\s'"<>]+/gi, '[saved token hidden]');
}

function sanitizeSetupTokenTerminalOutput(text: string): string {
  const hadTerminalControls = /[\x1B\x9B]/.test(text);
  const cleaned = text
    // Common spinner/redraw frame: move cursor, draw one spinner glyph, move
    // cursor again. Strip as a unit so a bare "-", "|", "/", or "\\" does not
    // survive as user-visible noise.
    .replace(/\x1B\[[0-?]*[ -/]*[@-~][|/\\-]\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    // OSC and longer string controls, including hyperlink/title updates.
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[P^_][\s\S]*?\x1B\\/g, '')
    // CSI/8-bit CSI sequences: cursor movement, erase line, private modes
    // like ?2026h/l, bracketed paste, sync updates, colors, etc.
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x9B[0-?]*[ -/]*[@-~]/g, '')
    // Remaining single ESC controls and non-printing C0 controls.
    .replace(/\x1B[@-_]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // Keep CRLF as normal newlines, but collapse terminal redraw CRs to the
    // final visible line content instead of replaying every cursor update.
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.split('\r').at(-1) ?? '')
    .join('\n');

  return hadTerminalControls && /^[\s|/\\-]*$/.test(cleaned) ? '' : cleaned;
}

function extractClaudeSetupToken(text: string): string | null {
  const envMatch = /\bCLAUDE_CODE_OAUTH_TOKEN\s*=\s*([^\s'"<>]+)/i.exec(text);
  if (envMatch?.[1]) return envMatch[1];
  const rawMatch = /\b(sk-ant-o[^\s'"<>]+)/i.exec(text);
  return rawMatch?.[1] ?? null;
}

function maybeSaveClaudeSetupTokenFromOutput(text: string): boolean {
  const token = extractClaudeSetupToken(text);
  if (!token || token === capturedSetupToken) return false;
  capturedSetupToken = token;
  rememberSetupTokenSecretForRedaction(token);
  writeSavedToken(token);
  return true;
}

function appendClaudeSetupTokenOutput(stream: ClaudeSetupTokenOutputChunk['stream'], text: string): void {
  if (!text) return;
  const sanitizedText = sanitizeSetupTokenTerminalOutput(text);
  const savedToken = maybeSaveClaudeSetupTokenFromOutput(sanitizedText);
  const safeText = redactSetupTokenOutput(sanitizedText);
  if (!safeText) return;
  const output = [
    ...(lastClaudeSetupTokenStatus.output ?? []),
    { stream, text: safeText, ts: new Date().toISOString() },
  ];
  if (savedToken) {
    output.push({
      stream: 'system',
      text: 'Captured and saved Claude OAuth token for ART and the left-panel debugger.\n',
      ts: new Date().toISOString(),
    });
  }
  let chars = output.reduce((sum, chunk) => sum + chunk.text.length, 0);
  while (chars > SETUP_TOKEN_OUTPUT_LIMIT && output.length > 1) {
    const removed = output.shift();
    chars -= removed?.text.length ?? 0;
  }
  lastClaudeSetupTokenStatus = {
    ...lastClaudeSetupTokenStatus,
    output,
  };
}

export function launchClaudeSetupToken(
  scope: ClaudeSetupTokenScope = 'runtime',
  projectDir?: string,
): ClaudeSetupTokenStatus {
  if (claudeSetupTokenProcess && lastClaudeSetupTokenStatus.running) {
    return {
      ...lastClaudeSetupTokenStatus,
      output: lastClaudeSetupTokenStatus.output?.slice(),
    };
  }

  const startedAt = new Date().toISOString();
  try {
    const setupCommand = setupTokenSpawnCommand(scope);
    const env = setupTokenEnv(scope, projectDir);
    const child = spawn(setupCommand.command, setupCommand.args, {
      env: {
        ...env,
        CLICOLOR: '0',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        TERM: 'dumb',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    claudeSetupTokenProcess = child;
    claudeSetupTokenUsesPty = setupCommand.usesPty;
    setupTokenInputRedactions = [];
    capturedSetupToken = null;
    lastClaudeSetupTokenStatus = {
      scope,
      running: true,
      pid: child.pid,
      startedAt,
      output: [],
    };
    appendClaudeSetupTokenOutput(
      'system',
      setupCommand.usesPty
        ? `Started ${setupCommand.label} in the app terminal\n`
        : `Started ${setupCommand.label}\n`,
    );

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => appendClaudeSetupTokenOutput('stdout', String(chunk)));
    child.stderr?.on('data', (chunk) => appendClaudeSetupTokenOutput('stderr', String(chunk)));

    child.once('error', (err) => {
      if (claudeSetupTokenProcess === child) claudeSetupTokenProcess = null;
      if (claudeSetupTokenProcess === null) claudeSetupTokenUsesPty = false;
      cached = null;
      appendClaudeSetupTokenOutput('system', `Process error: ${err.message}\n`);
      lastClaudeSetupTokenStatus = {
        ...lastClaudeSetupTokenStatus,
        running: false,
        finishedAt: new Date().toISOString(),
        error: err.message,
      };
    });

    child.once('exit', (exitCode, signal) => {
      if (claudeSetupTokenProcess === child) claudeSetupTokenProcess = null;
      if (claudeSetupTokenProcess === null) claudeSetupTokenUsesPty = false;
      cached = null;
      appendClaudeSetupTokenOutput(
        'system',
        signal ? `Process stopped by signal ${signal}\n` : `Process exited with code ${exitCode ?? 'unknown'}\n`,
      );
      lastClaudeSetupTokenStatus = {
        ...lastClaudeSetupTokenStatus,
        running: false,
        finishedAt: new Date().toISOString(),
        exitCode,
        signal,
      };
    });

    return claudeSetupTokenStatus(scope);
  } catch (err) {
    claudeSetupTokenProcess = null;
    claudeSetupTokenUsesPty = false;
    capturedSetupToken = null;
    cached = null;
    lastClaudeSetupTokenStatus = {
      scope,
      running: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: (err as Error).message,
      output: [
        {
          stream: 'system',
          text: `Failed to start ${setupTokenScopeLabel(scope)}: ${(err as Error).message}\n`,
          ts: new Date().toISOString(),
        },
      ],
    };
    return claudeSetupTokenStatus(scope);
  }
}

export function writeClaudeSetupTokenInput(input: string): ClaudeSetupTokenStatus {
  if (!claudeSetupTokenProcess || !lastClaudeSetupTokenStatus.running) {
    throw new Error('Claude subscription setup is not running.');
  }
  const stdin = claudeSetupTokenProcess.stdin;
  if (!stdin || stdin.destroyed || stdin.writableEnded) {
    throw new Error('Claude subscription setup is not accepting input.');
  }
  rememberSetupTokenInputForRedaction(input);
  const lineEnding = claudeSetupTokenUsesPty ? '\r' : '\n';
  stdin.write(/[\r\n]$/.test(input) ? input : `${input}${lineEnding}`);
  return {
    ...lastClaudeSetupTokenStatus,
    output: lastClaudeSetupTokenStatus.output?.slice(),
  };
}

function signalSetupTokenProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child below.
    }
  }
  try { child.kill(signal); } catch { /* ignore */ }
}

export function terminateClaudeSetupToken(reason = 'shutdown'): void {
  const child = claudeSetupTokenProcess;
  if (!child || !lastClaudeSetupTokenStatus.running) return;
  appendClaudeSetupTokenOutput('system', `Terminating Claude OAuth setup due to ${reason}\n`);
  signalSetupTokenProcess(child, 'SIGTERM');
  setTimeout(() => {
    if (claudeSetupTokenProcess === child && lastClaudeSetupTokenStatus.running) {
      signalSetupTokenProcess(child, 'SIGKILL');
    }
  }, 1500).unref?.();
}

export async function preflight(force = false, projectDir?: string): Promise<PreflightResult> {
  if (!force && cached && cached.projectDir === projectDir && Date.now() - cached.at < CACHE_MS) {
    return cached.result;
  }
  const [art, claude, containerRuntime, debuggerSandbox] = await Promise.all([
    tryVersion(ART_BIN),
    tryVersion(CLAUDE_BIN),
    detectContainerRuntime(),
    debuggerSandboxStatus(),
  ]);
  const auth = authStatus(projectDir);
  const result: PreflightResult = {
    ok:
      art.present &&
      claude.present &&
      containerRuntime.present &&
      debuggerSandbox.present &&
      auth.present &&
      (!projectDir || auth.chatReady),
    art,
    claude,
    containerRuntime,
    debuggerSandbox,
    auth,
  };
  cached = { at: Date.now(), projectDir, result };
  return result;
}
