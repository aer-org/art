import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  type SDKSession,
  type SDKMessage,
  type HookCallbackMatcher,
  type HookInput,
  type HookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';

import { APP_ROOT, ART_DIR_NAME } from './config.ts';
import {
  buildDebuggerSandboxLaunch,
  classifyDebuggerBashCommand,
  createDebuggerCanUseTool,
  DEBUGGER_CLAUDE_WRAPPER_PATH,
  normalizeDebuggerCommand,
  prepareDebuggerWorkspace,
  type DebuggerWorkspace,
  type DebuggerExecutionPermissionController,
  type DebuggerExecutionPermissionDecision,
  type DebuggerExecutionPermissionRequest,
} from './debugger-sandbox.ts';
import { authStatus, childProcessEnvForDebugger } from './preflight.ts';
import { runController } from './run-controller.ts';

const DEBUGGER_DIR = path.join(APP_ROOT, 'debugger');
const DEBUGGER_AGENT_PATH = path.join(DEBUGGER_DIR, 'AGENT.md');
const DEBUGGER_AGENTS_PATH = path.join(DEBUGGER_DIR, 'AGENTS.md');
const DEBUGGER_MEMORY_SEED_PATH = path.join(DEBUGGER_DIR, 'MEMORY.md');
const ART_ROOT = path.resolve(APP_ROOT, '..');
const ART_SKILLS_DIR = path.join(ART_ROOT, '.claude', 'skills');
function positiveTimeoutFromEnv(name: string, fallbackMs: number): number {
  const value = Number(process.env[name] ?? fallbackMs);
  return Number.isFinite(value) && value > 0 ? value : fallbackMs;
}

const SDK_INITIALIZATION_TIMEOUT_MS = positiveTimeoutFromEnv(
  'AER_ART_DEBUGGER_INIT_TIMEOUT_MS',
  30_000,
);
const SEND_TIMEOUT_MS = positiveTimeoutFromEnv(
  'AER_ART_DEBUGGER_SEND_TIMEOUT_MS',
  30_000,
);
const TURN_IDLE_TIMEOUT_MS = positiveTimeoutFromEnv(
  'AER_ART_DEBUGGER_TURN_IDLE_TIMEOUT_MS',
  180_000,
);
const TURN_IDLE_TIMEOUT_ENABLED = TURN_IDLE_TIMEOUT_MS > 0;

export const DEFAULT_MODEL = 'claude-opus-4-6';
export const DEFAULT_EFFORT = 'max';
export const CHAT_PROTOCOL_VERSION = 2;

export const MODEL_OPTIONS = [
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];
export const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = typeof EFFORT_OPTIONS[number];

export interface ChatSession {
  id: string;
  projectDir: string;
  v2: SDKSession | null;
  consumer: Promise<void> | null; // long-lived stream() consumer
  resumableSessionId: string | null; // captured from `system/init` for re-resume on settings change
  workspace: DebuggerWorkspace | null;
  sentBootstrapContext: boolean;
  busy: boolean; // set on send(), cleared on `result`
  activeTurnId: string | null;
  turnWatchdog: NodeJS.Timeout | null;
  turnLastActivityAt: number | null;
  lastTurnStatus: TurnLifecycle | null;
  debugLogPath: string | null;
  history: ChatEvent[];
  nextEventSeq: number;
  pendingPermissions: Map<string, PendingExecutionPermission>;
  temporaryAllowedCommands: Set<string>;
  model: string;
  effort: Effort;
  appliedSettings: { model: string; effort: Effort } | null; // settings the live session was built with
  sawTextDeltaInTurn: boolean;
  sawThinkingDeltaInTurn: boolean;
}

export type TurnLifecycle =
  | 'accepted'
  | 'initializing'
  | 'sent'
  | 'streaming'
  | 'waiting_permission'
  | 'recovering'
  | 'done'
  | 'failed';

type ChatEventBase = { seq?: number; ts: number; turnId?: string };

export type ChatPermissionDecision = DebuggerExecutionPermissionDecision;

interface PendingExecutionPermission {
  id: string;
  command: string;
  normalizedCommand: string;
  toolName: string;
  input: Record<string, unknown>;
  workspace: DebuggerWorkspace;
  resolve: (decision: DebuggerExecutionPermissionDecision) => void;
}

export type ChatEvent =
  | { kind: 'turn-start'; seq?: number; turnId: string; message: string; ts: number }
  | (ChatEventBase & { kind: 'user-message'; text: string })
  | (ChatEventBase & { kind: 'turn-status'; status: TurnLifecycle; message: string })
  | (ChatEventBase & { kind: 'text-delta'; text: string })
  | (ChatEventBase & { kind: 'thinking-delta'; text: string })
  | (ChatEventBase & { kind: 'thinking-stop' })
  | (ChatEventBase & { kind: 'tool-use'; tool: string; input: unknown; toolId: string })
  | (ChatEventBase & { kind: 'tool-result'; toolId: string; output: string; isError: boolean })
  | (ChatEventBase & { kind: 'rate-limit'; status: string; summary: string })
  | (ChatEventBase & {
      kind: 'task-event';
      taskId: string;
      status: string;
      summary: string;
      toolUseId?: string;
    })
  | (ChatEventBase & {
      kind: 'permission-request';
      permissionId: string;
      tool: string;
      command: string;
      input: unknown;
      title: string;
      description: string;
    })
  | (ChatEventBase & {
      kind: 'permission-resolved';
      permissionId: string;
      decision: ChatPermissionDecision;
      command: string;
    })
  | (ChatEventBase & { kind: 'background-task'; taskId: string; status: 'completed' | 'failed' | 'stopped'; summary: string })
  | (ChatEventBase & { kind: 'done'; cost?: number; durationMs?: number })
  | (ChatEventBase & { kind: 'error'; message: string });

let cachedArtSkillIndex: string | null = null;
let cachedDebuggerInstructions: string | null = null;

function extractFrontmatterValue(body: string, key: string): string | null {
  if (!body.startsWith('---')) return null;
  const end = body.indexOf('\n---', 3);
  if (end === -1) return null;
  const frontmatter = body.slice(3, end);
  const pattern = new RegExp(`^${key}:\\s*(.+)$`, 'm');
  const match = pattern.exec(frontmatter);
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, '') || null;
}

function firstUsefulLine(body: string): string | null {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '---' || trimmed.startsWith('#')) continue;
    if (/^(name|description):\s*/.test(trimmed)) continue;
    return trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
  }
  return null;
}

function loadArtSkillIndex(): string {
  if (cachedArtSkillIndex !== null) return cachedArtSkillIndex;
  if (!fs.existsSync(ART_SKILLS_DIR)) {
    cachedArtSkillIndex = 'No repo-local ART skill docs found.';
    return cachedArtSkillIndex;
  }

  const entries = fs
    .readdirSync(ART_SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const filePath = path.join(ART_SKILLS_DIR, entry.name, 'SKILL.md');
      if (!fs.existsSync(filePath)) return null;
      try {
        const body = fs.readFileSync(filePath, 'utf8').trim();
        const name = extractFrontmatterValue(body, 'name') ?? entry.name;
        const description =
          extractFrontmatterValue(body, 'description') ??
          firstUsefulLine(body) ??
          'No description found.';
        return `- ${name}: ${description} (${filePath})`;
      } catch {
        return null;
      }
    })
    .filter((doc): doc is string => !!doc)
    .sort((a, b) => a.localeCompare(b));

  cachedArtSkillIndex = entries.length
    ? entries.join('\n')
    : 'No repo-local ART skill docs found.';
  return cachedArtSkillIndex;
}

function loadDebuggerInstructions(): string {
  if (cachedDebuggerInstructions !== null) return cachedDebuggerInstructions;
  const parts: string[] = [];
  try {
    parts.push(fs.readFileSync(DEBUGGER_AGENT_PATH, 'utf8').trim());
  } catch {
    // Fall through to AGENTS.md or the built-in fallback below.
  }
  try {
    const agents = fs.readFileSync(DEBUGGER_AGENTS_PATH, 'utf8').trim();
    if (agents) parts.push(`## AGENTS.md companion context\n\n${agents}`);
  } catch {
    // AGENTS.md is a compatibility companion, not required.
  }
  cachedDebuggerInstructions = parts.length
    ? parts.join('\n\n')
    : 'You are the ART Pipeline Debugger. Debug only the loaded ART pipeline.';
  return cachedDebuggerInstructions;
}

function loadProjectMemory(workspace: DebuggerWorkspace): string {
  try {
    return fs.readFileSync(workspace.memoryPath, 'utf8').trim() || '(empty)';
  } catch {
    return '(memory file unavailable)';
  }
}

interface ProjectCommandPermissions {
  allowedBashCommands: string[];
}

function loadProjectCommandPermissions(workspace: DebuggerWorkspace): ProjectCommandPermissions {
  try {
    const raw = fs.readFileSync(workspace.permissionsPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ProjectCommandPermissions>;
    const allowedBashCommands = Array.isArray(parsed.allowedBashCommands)
      ? parsed.allowedBashCommands.filter((cmd): cmd is string => typeof cmd === 'string' && !!cmd.trim())
      : [];
    return { allowedBashCommands: [...new Set(allowedBashCommands.map(normalizeDebuggerCommand))].sort() };
  } catch {
    return { allowedBashCommands: [] };
  }
}

function saveProjectCommandPermissions(workspace: DebuggerWorkspace, permissions: ProjectCommandPermissions): void {
  const normalized = [...new Set(permissions.allowedBashCommands.map(normalizeDebuggerCommand))]
    .filter(Boolean)
    .sort();
  fs.writeFileSync(
    workspace.permissionsPath,
    `${JSON.stringify({ allowedBashCommands: normalized }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function isProjectCommandAllowed(workspace: DebuggerWorkspace, command: string): boolean {
  const normalized = normalizeDebuggerCommand(command);
  return loadProjectCommandPermissions(workspace).allowedBashCommands.includes(normalized);
}

function rememberProjectCommand(workspace: DebuggerWorkspace, command: string): void {
  const normalized = normalizeDebuggerCommand(command);
  if (!normalized) return;
  const permissions = loadProjectCommandPermissions(workspace);
  if (!permissions.allowedBashCommands.includes(normalized)) {
    permissions.allowedBashCommands.push(normalized);
    saveProjectCommandPermissions(workspace, permissions);
  }
}

function buildSessionContext(session: ChatSession, workspace: DebuggerWorkspace): string {
  const artSkillIndex = loadArtSkillIndex();
  return [
    `## Session context`,
    ``,
    `- Loaded project: \`${workspace.projectDir}\``,
    `- Read-only ART repo reference: \`${workspace.artRepoDir}\``,
    `- Pipeline file: \`${workspace.artDir}/PIPELINE.json\``,
    `- Writable debugger state: \`${workspace.debuggerDir}\``,
    `- Durable debugger memory: \`${workspace.memoryPath}\``,
    `- Direct writes are allowed only under \`${workspace.artDir}\`.`,
    `- Host filesystem reads are allowed as read-only context; prefer the loaded project and ART repo, and inspect other paths only when they are relevant to the user's pipeline task.`,
    `- Permission boundary: \`${workspace.artDir}\` supports read/write/execute; the rest of the host filesystem supports read/execute only.`,
    `- Bash policy: \`art run "$AER_ART_PROJECT_DIR"\` for this project and narrow read-only inspection commands over the loaded project or ART repo are auto-allowed. Unusual execution still asks the user; direct Docker/Podman/Udocker and localhost API calls are denied.`,
    `- If a Bash permission prompt appears, the user can choose Yes, Yes and allow this command for this project directory, or No. A project-level allow remembers the exact command for this loaded project.`,
    `- The ART repo lives at \`${workspace.artRepoDir}\` on this machine. Read it early when you need ART runtime/schema/app context.`,
    `- The ART repo and all non-\`__art__\` paths are reference context only for writes. Do not edit them. Avoid repo-maintenance/build commands in ART app/runtime unless explicitly asked and approved; report ART runtime/app issues to the user instead of changing files.`,
    `- If the user asks to create, fix, or debug a pipeline, proactively run \`art run "$AER_ART_PROJECT_DIR"\` in the background, inspect state/logs/results, edit under \`${workspace.artDir}\`, and repeat until verified success, app Stop/cancel, or a loud external blocker.`,
    `- Do not stop at inspection or ask "Want me to run it?" for pipeline debug/create requests. Running and iterating is part of the task.`,
    `- Do not use shell polling loops. Poll with separate bounded \`sleep\` plus read-only inspection commands so the GUI keeps receiving visible progress events.`,
    `- Silent fallbacks are never allowed: missing files/tools, skipped work, empty outputs, stale state, placeholders, and degraded behavior must fail loudly and be debugged.`,
    ``,
    `Run pipelines by invoking \`art run "$AER_ART_PROJECT_DIR"\` directly with`,
    `Bash (use \`run_in_background\` so you can poll state while it runs).`,
    `The GUI watches the project's \`__art__/.state/\` files so the right-panel graph`,
    `recolors automatically. Read live state from \`${workspace.artDir}/.state/PIPELINE_STATE.json\`,`,
    `logs from \`${workspace.artDir}/.state/logs/\`, and run manifests from`,
    `\`${workspace.artDir}/.state/runs/\`; you don't need to talk to any API.`,
    ``,
    `Background tasks survive across turns: when an \`art run\` you launched`,
    `earlier finishes, you'll receive a \`task_notification\` system message in`,
    `your transcript even if the user has typed something else in the meantime.`,
    ``,
    `## Repo-local ART skill index`,
    ``,
    `For faster startup, only this compact skill index from \`${ART_SKILLS_DIR}\``,
    `is embedded. Read the listed \`SKILL.md\` files on demand when they are`,
    `relevant to generating, rewriting, or debugging ART pipelines. If older`,
    `debugger instructions say full skill docs are embedded, this session`,
    `context supersedes that: use this index and read only what you need.`,
    `If a skill conflicts with your pipeline-debugger role, the role wins: do`,
    `not edit application/runtime files and do not follow repo-maintenance`,
    `instructions. Use broader filesystem reads only as context for the selected`,
    `pipeline task.`,
    ``,
    artSkillIndex,
  ].join('\n');
}

function buildBootstrapPrompt(session: ChatSession, workspace: DebuggerWorkspace, userText: string): string {
  return [
    `You are being launched by the ART app's isolated left-panel debugger.`,
    `The app cannot rely on Claude Code project/user settings here, so these instructions are embedded explicitly.`,
    ``,
    `## ART debugger instructions`,
    ``,
    loadDebuggerInstructions(),
    ``,
    buildSessionContext(session, workspace),
    ``,
    `## Current per-project debugger memory`,
    ``,
    `Path: \`${workspace.memoryPath}\``,
    ``,
    loadProjectMemory(workspace),
    ``,
    `## User message`,
    ``,
    userText,
  ].join('\n');
}

function buildFollowupPrompt(workspace: DebuggerWorkspace, userText: string): string {
  return [
    `Reminder for this ART debugger turn:`,
    `- Loaded project: \`${workspace.projectDir}\`.`,
    `- ART repo path: \`${workspace.artRepoDir}\`; read it early when ART context is needed.`,
    `- Read surface: host filesystem read-only. Prefer the loaded project and ART repo; inspect other paths only when relevant.`,
    `- Writable host surface: \`${workspace.artDir}\` only.`,
    `- Execution boundary: \`${workspace.artDir}\` is read/write/execute; other host paths are read/execute. \`art run "$AER_ART_PROJECT_DIR"\` and narrow read-only project/ART-repo inspection commands are auto-allowed; unusual execution still asks the user.`,
    `- The ART repo and all non-\`__art__\` paths are context only for writes; do not edit them. Avoid ART app/runtime maintenance commands unless explicitly asked and approved.`,
    `- For pipeline debug/create requests, run and iterate proactively with \`art run "$AER_ART_PROJECT_DIR"\`; do not ask the user to approve each run.`,
    `- Stop only on verified success, app Stop/cancel, or a loud external blocker requiring user action.`,
    `- Silent fallbacks are forbidden: no placeholders, fake success, hidden skipped work, or quiet degradation.`,
    `- Do not call localhost APIs or direct Docker.`,
    `- Runtime state lives at \`${workspace.artDir}/.state/PIPELINE_STATE.json\`.`,
    `- Runtime logs live under \`${workspace.artDir}/.state/logs/\`.`,
    `- Debug ART pipeline behavior, not the ART app or ART runtime implementation.`,
    ``,
    `User message:`,
    userText,
  ].join('\n');
}

function commandFromToolInput(input: unknown): string {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const command = (input as { command?: unknown }).command;
    if (typeof command === 'string') return command;
  }
  if (typeof input === 'string') return input;
  try {
    const json = JSON.stringify(input);
    if (json) return json;
  } catch {
    // fall through
  }
  return String(input ?? '');
}

function isArtRunTool(tool: string, input: unknown): boolean {
  const toolName = tool.toLowerCase();
  if (toolName && !/(bash|shell|run|exec|terminal)/.test(toolName)) return false;
  return /\bart\s+run\b/i.test(commandFromToolInput(input));
}

class ChatController extends EventEmitter {
  private sessions: Map<string, ChatSession> = new Map();

  create(projectDir: string, opts?: { model?: string; effort?: Effort }): ChatSession {
    const session: ChatSession = {
      id: randomUUID(),
      projectDir,
      v2: null,
      consumer: null,
      resumableSessionId: null,
      workspace: null,
      sentBootstrapContext: false,
      busy: false,
      activeTurnId: null,
      turnWatchdog: null,
      turnLastActivityAt: null,
      lastTurnStatus: null,
      debugLogPath: null,
      history: [],
      nextEventSeq: 0,
      pendingPermissions: new Map(),
      temporaryAllowedCommands: new Set(),
      model: opts?.model ?? DEFAULT_MODEL,
      effort: opts?.effort ?? DEFAULT_EFFORT,
      appliedSettings: null,
      sawTextDeltaInTurn: false,
      sawThinkingDeltaInTurn: false,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(chatId: string): ChatSession | undefined {
    return this.sessions.get(chatId);
  }

  setSettings(chatId: string, opts: { model?: string; effort?: Effort }): ChatSession | null {
    const s = this.sessions.get(chatId);
    if (!s) return null;
    if (opts.model) s.model = opts.model;
    if (opts.effort) s.effort = opts.effort;
    return s;
  }

  private turnId(session: ChatSession): string | undefined {
    return session.activeTurnId ?? undefined;
  }

  private async withTimeout<T>(
    session: ChatSession,
    label: string,
    promise: Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => {
            this.debug(session, 'operation-timeout', { label, timeoutMs });
            reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private pushTurnStatus(
    session: ChatSession,
    status: TurnLifecycle,
    message: string,
    turnId = this.turnId(session),
  ): void {
    if (session.lastTurnStatus === status && status !== 'waiting_permission') return;
    session.lastTurnStatus = status;
    this.push(session, {
      kind: 'turn-status',
      status,
      message,
      turnId,
      ts: Date.now(),
    });
  }

  private configureDebugLog(session: ChatSession, workspace: DebuggerWorkspace): void {
    session.debugLogPath = path.join(workspace.debugLogsDir, `app-chat-${session.id}.jsonl`);
  }

  private configureDebugLogForProject(session: ChatSession): void {
    if (session.debugLogPath) return;
    try {
      const logsDir = path.join(
        path.resolve(session.projectDir),
        ART_DIR_NAME,
        '.debugger',
        'logs',
      );
      fs.mkdirSync(logsDir, { recursive: true });
      session.debugLogPath = path.join(logsDir, `app-chat-${session.id}.jsonl`);
    } catch {
      // If the project is not prepared yet, workspace preparation will try again.
    }
  }

  private debug(session: ChatSession, event: string, fields: Record<string, unknown> = {}): void {
    const logPath = session.debugLogPath;
    if (!logPath) return;
    try {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        event,
        chatId: session.id,
        projectDir: session.projectDir,
        turnId: session.activeTurnId,
        sdkSessionId: session.resumableSessionId,
        ...fields,
      });
      fs.appendFileSync(logPath, `${line}\n`);
    } catch {
      // Debug logging must never affect the chat session.
    }
  }

  private clearTurnWatchdog(session: ChatSession): void {
    if (session.turnWatchdog) clearTimeout(session.turnWatchdog);
    session.turnWatchdog = null;
  }

  private recordTurnActivity(session: ChatSession, reason: string): void {
    if (!session.activeTurnId) return;
    session.turnLastActivityAt = Date.now();
    this.clearTurnWatchdog(session);
    if (!TURN_IDLE_TIMEOUT_ENABLED) {
      this.debug(session, 'turn-activity', { reason, idleTimeoutEnabled: false });
      return;
    }
    const turnId = session.activeTurnId;
    session.turnWatchdog = setTimeout(() => {
      this.handleTurnIdleTimeout(session, turnId);
    }, TURN_IDLE_TIMEOUT_MS);
    session.turnWatchdog.unref?.();
    this.debug(session, 'turn-activity', { reason });
  }

  private pauseTurnWatchdogForPermission(session: ChatSession, reason: string): void {
    if (!session.activeTurnId) return;
    session.turnLastActivityAt = Date.now();
    this.clearTurnWatchdog(session);
    this.debug(session, 'turn-activity', {
      reason,
      watchdogPaused: true,
      pendingPermissions: session.pendingPermissions.size,
    });
  }

  private handleTurnIdleTimeout(session: ChatSession, turnId: string | null): void {
    if (!turnId || session.activeTurnId !== turnId || !session.busy) return;
    if (session.pendingPermissions.size > 0) {
      this.debug(session, 'turn-idle-timeout-paused-for-permission', {
        pendingPermissions: session.pendingPermissions.size,
        idleMs: session.turnLastActivityAt ? Date.now() - session.turnLastActivityAt : null,
        timeoutMs: TURN_IDLE_TIMEOUT_MS,
      });
      this.pushTurnStatus(session, 'waiting_permission', 'Waiting for execution permission.', turnId);
      this.pauseTurnWatchdogForPermission(session, 'permission-still-pending');
      return;
    }
    const v2 = session.v2;
    this.debug(session, 'turn-idle-timeout', {
      idleMs: session.turnLastActivityAt ? Date.now() - session.turnLastActivityAt : null,
      timeoutMs: TURN_IDLE_TIMEOUT_MS,
    });
    this.pushTurnStatus(session, 'recovering', 'Debugger stopped producing events; recovering the Claude session.', turnId);
    try { v2?.close(); } catch { /* ignore */ }
    if (v2) this.detachLiveSession(session, v2);
    this.failActiveTurn(
      session,
      `Debugger session stopped responding for ${Math.round(TURN_IDLE_TIMEOUT_MS / 1000)}s. ` +
        'The live Claude process was recovered; send your message again to continue.',
    );
  }

  private failActiveTurn(session: ChatSession, message: string): void {
    const turnId = this.turnId(session);
    this.clearTurnWatchdog(session);
    this.clearPendingPermissions(session, message);
    session.temporaryAllowedCommands.clear();
    this.pushTurnStatus(session, 'failed', 'Debugger turn failed.', turnId);
    this.push(session, { kind: 'error', message, turnId, ts: Date.now() });
    if (session.busy || turnId) {
      this.push(session, { kind: 'done', turnId, ts: Date.now() });
    }
    session.busy = false;
    session.activeTurnId = null;
    session.turnLastActivityAt = null;
    session.sawTextDeltaInTurn = false;
    session.sawThinkingDeltaInTurn = false;
  }

  private completeActiveTurn(
    session: ChatSession,
    opts?: { cost?: number; durationMs?: number },
  ): void {
    const turnId = this.turnId(session);
    this.clearTurnWatchdog(session);
    session.temporaryAllowedCommands.clear();
    session.busy = false;
    session.activeTurnId = null;
    session.turnLastActivityAt = null;
    this.pushTurnStatus(session, 'done', 'Debugger turn complete.', turnId);
    this.push(session, {
      kind: 'done',
      turnId,
      ts: Date.now(),
      cost: opts?.cost,
      durationMs: opts?.durationMs,
    });
    session.sawTextDeltaInTurn = false;
    session.sawThinkingDeltaInTurn = false;
  }

  private detachLiveSession(session: ChatSession, v2?: SDKSession | null): void {
    if (v2 && session.v2 !== v2) return;
    session.v2 = null;
    session.appliedSettings = null;
    session.workspace = null;
    if (!session.resumableSessionId) session.sentBootstrapContext = false;
  }

  private executionPermissionController(
    session: ChatSession,
    workspace: DebuggerWorkspace,
  ): DebuggerExecutionPermissionController {
    return {
      isCommandAllowed: (command) => {
        const normalized = normalizeDebuggerCommand(command);
        return session.temporaryAllowedCommands.has(normalized) || isProjectCommandAllowed(workspace, normalized);
      },
      requestCommandPermission: (request) => this.requestCommandPermission(session, workspace, request),
    };
  }

  private debuggerHooks(
    session: ChatSession,
    workspace: DebuggerWorkspace,
  ): Partial<Record<'PreToolUse', HookCallbackMatcher[]>> {
    const hooks: HookCallbackMatcher[] = [{
      hooks: [async (input: HookInput): Promise<HookJSONOutput> => {
        if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') {
          return { continue: true };
        }

        const toolInput = input.tool_input && typeof input.tool_input === 'object' && !Array.isArray(input.tool_input)
          ? input.tool_input as Record<string, unknown>
          : {};
        const command = commandFromToolInput(toolInput);
        const permissionController = this.executionPermissionController(session, workspace);
        const commandPolicy = classifyDebuggerBashCommand(workspace, toolInput, {
          isRememberedAllowed: permissionController.isCommandAllowed,
        });
        if (commandPolicy.kind === 'deny') {
          this.debug(session, 'pre-tool-use-deny', {
            toolName: 'Bash',
            reason: commandPolicy.reason,
            command: commandPolicy.normalizedCommand,
          });
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: commandPolicy.message,
            },
          };
        }

        if (commandPolicy.kind === 'allow') {
          this.debug(session, 'pre-tool-use-auto-allow', {
            toolName: 'Bash',
            reason: commandPolicy.reason,
            command: commandPolicy.normalizedCommand,
            forcedBackground: commandPolicy.updatedInput.run_in_background === true,
          });
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
              permissionDecisionReason: commandPolicy.message,
              updatedInput: commandPolicy.updatedInput,
            },
          };
        }

        const decision = await this.requestCommandPermission(session, workspace, {
          toolName: 'Bash',
          input: commandPolicy.updatedInput,
          command,
          normalizedCommand: commandPolicy.normalizedCommand,
        });
        if (decision === 'deny') {
          this.debug(session, 'pre-tool-use-deny', {
            toolName: 'Bash',
            decision,
            command: commandPolicy.normalizedCommand,
          });
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: 'Execution denied by user.',
            },
          };
        }

        session.temporaryAllowedCommands.add(commandPolicy.normalizedCommand);
        this.debug(session, 'pre-tool-use-allow', {
          toolName: 'Bash',
          decision,
          command: commandPolicy.normalizedCommand,
        });
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason:
              decision === 'allow_project'
                ? 'Execution allowed for this project by user.'
                : 'Execution allowed once by user.',
            updatedInput: commandPolicy.updatedInput,
          },
        };
      }],
    }];

    return { PreToolUse: hooks };
  }

  private requestCommandPermission(
    session: ChatSession,
    workspace: DebuggerWorkspace,
    request: DebuggerExecutionPermissionRequest,
  ): Promise<DebuggerExecutionPermissionDecision> {
    const commandPolicy = classifyDebuggerBashCommand(workspace, request.input, {
      isRememberedAllowed: (command) => isProjectCommandAllowed(workspace, command),
    });
    const normalizedCommand = commandPolicy.normalizedCommand || normalizeDebuggerCommand(request.normalizedCommand || request.command);
    if (commandPolicy.kind === 'deny') {
      this.debug(session, 'permission-deny-policy', {
        toolName: request.toolName,
        reason: commandPolicy.reason,
        command: normalizedCommand,
      });
      return Promise.resolve('deny');
    }
    if (commandPolicy.kind === 'allow') {
      this.debug(session, 'permission-auto-allow', {
        toolName: request.toolName,
        reason: commandPolicy.reason,
        command: normalizedCommand,
      });
      return Promise.resolve(commandPolicy.reason === 'remembered-project-command' ? 'allow_project' : 'allow_once');
    }

    return new Promise((resolve) => {
      const permissionId = randomUUID();
      session.pendingPermissions.set(permissionId, {
        id: permissionId,
        command: request.command,
        normalizedCommand,
        toolName: request.toolName,
        input: request.input,
        workspace,
        resolve,
      });
      this.debug(session, 'permission-request', {
        permissionId,
        toolName: request.toolName,
        command: normalizedCommand,
      });
      this.pushTurnStatus(session, 'waiting_permission', 'Waiting for execution permission.');
      this.push(session, {
        kind: 'permission-request',
        permissionId,
        tool: request.toolName,
        command: request.command,
        input: request.input,
        title: 'Allow debugger execution?',
        description:
          'The debugger wants to execute this command. Host writes are limited to the selected project __art__ directory; other host paths are read/execute only.',
        turnId: this.turnId(session),
        ts: Date.now(),
      });
      this.pauseTurnWatchdogForPermission(session, 'permission-request');
    });
  }

  resolvePermission(
    chatId: string,
    permissionId: string,
    decision: ChatPermissionDecision,
  ): { ok: true } | { ok: false; error: string } {
    const session = this.sessions.get(chatId);
    if (!session) return { ok: false, error: 'unknown chatId' };
    const pending = session.pendingPermissions.get(permissionId);
    if (!pending) return { ok: false, error: 'unknown permissionId' };

    session.pendingPermissions.delete(permissionId);
    if (decision === 'allow_project') {
      rememberProjectCommand(pending.workspace, pending.normalizedCommand);
    }
    if (decision === 'allow_once' || decision === 'allow_project') {
      session.temporaryAllowedCommands.add(pending.normalizedCommand);
    }
    this.debug(session, 'permission-resolved', {
      permissionId,
      decision,
      command: pending.normalizedCommand,
    });
    this.push(session, {
      kind: 'permission-resolved',
      permissionId,
      decision,
      command: pending.command,
      turnId: this.turnId(session),
      ts: Date.now(),
    });
    if (decision === 'deny') {
      this.pushTurnStatus(session, 'streaming', 'Execution denied; returning control to Claude.');
    } else {
      this.pushTurnStatus(session, 'streaming', 'Execution allowed; waiting for tool result.');
    }
    this.recordTurnActivity(session, 'permission-resolved');
    pending.resolve(decision);
    return { ok: true };
  }

  private clearPendingPermissions(session: ChatSession, reason: string): void {
    if (session.pendingPermissions.size === 0) return;
    for (const pending of session.pendingPermissions.values()) {
      this.push(session, {
        kind: 'permission-resolved',
        permissionId: pending.id,
        decision: 'deny',
        command: pending.command,
        turnId: this.turnId(session),
        ts: Date.now(),
      });
      pending.resolve('deny');
    }
    this.debug(session, 'permission-clear', { reason });
    session.pendingPermissions.clear();
  }

  async cancel(chatId: string): Promise<void> {
    const s = this.sessions.get(chatId);
    if (!s) return;
    // Closing the V2 session ends the underlying CLI subprocess. Background
    // tools (like `Bash(art run …, run_in_background:true)`) that are running
    // as children of that CLI will receive SIGTERM. The whole point of
    // staying in streaming-input mode is that *normal* end-of-turn no longer
    // triggers this — only an explicit cancel does.
    const v2 = s.v2;
    this.clearTurnWatchdog(s);
    this.clearPendingPermissions(s, 'cancelled');
    s.temporaryAllowedCommands.clear();
    s.v2 = null;
    s.consumer = null;
    s.busy = false;
    const turnId = this.turnId(s);
    s.activeTurnId = null;
    s.appliedSettings = null;
    s.workspace = null;
    if (!s.resumableSessionId) s.sentBootstrapContext = false;
    try { v2?.close(); } catch { /* already closed */ }
    this.debug(s, 'cancel');
    this.pushTurnStatus(s, 'failed', 'Debugger turn cancelled.', turnId);
    this.push(s, { kind: 'error', message: 'Cancelled by user.', turnId, ts: Date.now() });
    this.push(s, { kind: 'done', turnId, ts: Date.now() });
    s.sawTextDeltaInTurn = false;
    s.sawThinkingDeltaInTurn = false;
  }

  destroy(chatId: string): void {
    const s = this.sessions.get(chatId);
    if (!s) return;
    this.clearTurnWatchdog(s);
    this.clearPendingPermissions(s, 'destroyed');
    s.temporaryAllowedCommands.clear();
    try { s.v2?.close(); } catch { /* ignore */ }
    this.sessions.delete(chatId);
  }

  acceptTurn(chatId: string, userText: string): { turnId: string } {
    const session = this.sessions.get(chatId);
    if (!session) throw new Error(`No chat session ${chatId}`);
    if (session.busy) throw new Error('A turn is already in progress for this session.');
    session.temporaryAllowedCommands.clear();

    const turnId = randomUUID();
    this.configureDebugLogForProject(session);
    session.activeTurnId = turnId;
    session.busy = true;
    session.lastTurnStatus = null;
    session.sawTextDeltaInTurn = false;
    session.sawThinkingDeltaInTurn = false;
    this.push(session, { kind: 'turn-start', turnId, message: userText, ts: Date.now() });
    this.push(session, { kind: 'user-message', text: userText, turnId, ts: Date.now() });
    this.pushTurnStatus(session, 'accepted', 'Debugger turn accepted.', turnId);
    this.recordTurnActivity(session, 'accepted');

    this.debug(session, 'turn-accepted');
    return { turnId };
  }

  startAcceptedTurn(chatId: string, turnId: string, userText: string): void {
    const session = this.sessions.get(chatId);
    if (!session || session.activeTurnId !== turnId || !session.busy) return;
    this.debug(session, 'turn-start-after-http-ack');
    void this.runTurn(session, turnId, userText);
  }

  private async runTurn(session: ChatSession, turnId: string, userText: string): Promise<void> {
    try {
      // If model/effort changed since the live session was built, recreate
      // (resuming the prior sessionId so transcript is preserved).
      if (session.v2 && session.appliedSettings) {
        const drift =
          session.appliedSettings.model !== session.model ||
          session.appliedSettings.effort !== session.effort;
        if (drift) {
          this.pushTurnStatus(session, 'recovering', 'Applying debugger model settings.', turnId);
          await this.recreateSession(session);
        }
      }

      this.pushTurnStatus(session, 'initializing', 'Starting Claude debugger session.', turnId);
      await this.ensureSession(session);
      if (session.activeTurnId !== turnId || !session.busy) return;
      const workspace = session.workspace;
      if (!workspace) throw new Error('Debugger workspace was not initialized.');

      const isBootstrap = !session.sentBootstrapContext;
      const prompt = isBootstrap
        ? buildBootstrapPrompt(session, workspace, userText)
        : buildFollowupPrompt(workspace, userText);

      this.debug(session, 'turn-send', {
        isBootstrap,
        model: session.model,
        effort: session.effort,
      });
      await this.withTimeout(
        session,
        'Claude debugger send',
        session.v2!.send(prompt),
        SEND_TIMEOUT_MS,
      );
      if (session.activeTurnId !== turnId || !session.busy) return;
      this.pushTurnStatus(session, 'sent', 'Message sent to Claude; waiting for response.', turnId);
      if (isBootstrap) session.sentBootstrapContext = true;
    } catch (err) {
      if (session.activeTurnId !== turnId) return;
      const failedV2 = session.v2;
      this.debug(session, 'turn-send-failed', { message: (err as Error).message });
      if (failedV2) {
        try { failedV2.close(); } catch { /* ignore */ }
        this.detachLiveSession(session, failedV2);
      }
      this.failActiveTurn(session, `send failed: ${(err as Error).message}`);
    }
  }

  private async ensureSession(session: ChatSession): Promise<void> {
    if (session.v2) {
      if (!session.consumer) this.startConsumer(session);
      return;
    }

    const workspace = prepareDebuggerWorkspace(session.projectDir, DEBUGGER_MEMORY_SEED_PATH);
    session.projectDir = workspace.projectDir;
    session.workspace = workspace;
    this.configureDebugLog(session, workspace);
    this.debug(session, 'workspace-ready', {
      debuggerDir: workspace.debuggerDir,
      resumed: !!session.resumableSessionId,
    });
    const auth = authStatus(workspace.projectDir);
    if (!auth.chatReady) {
      throw new Error(
        auth.chatError ??
          auth.error ??
          'Claude chat authentication is not configured for the embedded debugger.',
      );
    }
    const launch = buildDebuggerSandboxLaunch(workspace, {
      ...childProcessEnvForDebugger(workspace.projectDir),
    });

    const baseOptions = {
      model: session.model,
      cwd: workspace.projectDir,
      settingSources: [] as ('project' | 'user' | 'local')[],
      permissionMode: 'default' as const,
      disallowedTools: ['WebFetch', 'WebSearch', 'Task'],
      canUseTool: createDebuggerCanUseTool(workspace, this.executionPermissionController(session, workspace)),
      hooks: this.debuggerHooks(session, workspace),
      includePartialMessages: true,
      effort: session.effort,
      executable: launch.executable,
      executableArgs: launch.executableArgs,
      pathToClaudeCodeExecutable: DEBUGGER_CLAUDE_WRAPPER_PATH,
      env: launch.env,
    } as any;

    session.v2 = session.resumableSessionId
      ? unstable_v2_resumeSession(session.resumableSessionId, baseOptions)
      : unstable_v2_createSession(baseOptions);
    session.appliedSettings = { model: session.model, effort: session.effort };
    this.debug(session, session.resumableSessionId ? 'sdk-session-resume' : 'sdk-session-create');
    await this.withTimeout(
      session,
      'Claude SDK initialization',
      this.waitForSdkInitialization(session, session.v2),
      SDK_INITIALIZATION_TIMEOUT_MS,
    );

    this.startConsumer(session);
  }

  private async waitForSdkInitialization(session: ChatSession, v2: SDKSession): Promise<void> {
    const maybeInitialization = (v2 as unknown as {
      query?: { initialization?: unknown };
    }).query?.initialization;
    if (!maybeInitialization || typeof (maybeInitialization as Promise<unknown>).then !== 'function') {
      this.debug(session, 'sdk-initialize-unavailable');
      return;
    }
    this.debug(session, 'sdk-initialize-wait');
    await maybeInitialization;
    if (session.v2 === v2) this.debug(session, 'sdk-initialize-ready');
  }

  private startConsumer(session: ChatSession): void {
    if (!session.v2 || session.consumer) return;
    const v2 = session.v2;

    // Long-lived consumer: handles every SDKMessage for this session, including
    // task_notifications that arrive *between* user turns. V2 stream() returns
    // after a result; loop back so later sends still have a live consumer.
    const holder: { promise?: Promise<void> } = {};
    const consumer = (async () => {
      try {
        this.debug(session, 'stream-consumer-start');
        while (session.v2 === v2) {
          let sawMessage = false;
          for await (const msg of v2.stream()) {
            if (session.v2 !== v2) return;
            sawMessage = true;
            this.recordTurnActivity(session, `sdk:${msg.type}`);
            this.handleEvent(session, msg);
          }
          if (session.v2 !== v2) return;
          if (!sawMessage) {
            this.markSessionDead(session, v2, 'stream ended without messages');
            return;
          }
        }
      } catch (err) {
        this.markSessionDead(session, v2, `stream ended: ${(err as Error).message}`);
      } finally {
        this.debug(session, 'stream-consumer-stop');
        if (session.consumer === holder.promise) session.consumer = null;
      }
    })();

    holder.promise = consumer;
    session.consumer = consumer;
  }

  private markSessionDead(session: ChatSession, v2: SDKSession, errorMessage?: string): void {
    if (session.v2 !== v2) return;
    this.debug(session, 'sdk-session-dead', { errorMessage });
    if (session.busy) this.failActiveTurn(session, errorMessage ?? 'Debugger session ended before the turn finished.');
    else if (errorMessage) this.push(session, { kind: 'error', message: errorMessage, ts: Date.now() });
    // Mark dead so the next send() rebuilds, resuming if we have an id.
    this.detachLiveSession(session, v2);
  }

  private async recreateSession(session: ChatSession): Promise<void> {
    const v2 = session.v2;
    session.consumer = null;
    this.debug(session, 'sdk-session-recreate');
    this.detachLiveSession(session, v2);
    try { v2?.close(); } catch { /* ignore */ }
    // ensureSession() will resumeSession() with the captured sessionId.
  }

  private push(session: ChatSession, event: ChatEvent): void {
    event.seq = ++session.nextEventSeq;
    session.history.push(event);
    this.debug(session, 'push-event', { kind: event.kind, eventSeq: event.seq, eventTurnId: event.turnId });
    this.emit('event', { chatId: session.id, event });
  }

  private resultErrorMessage(msg: SDKMessage): string | null {
    if (msg.type !== 'result') return null;
    const result = msg as SDKMessage & {
      subtype?: string;
      is_error?: boolean;
      errors?: string[];
      result?: string;
    };
    if (!result.is_error && result.subtype === 'success') return null;
    const detail =
      Array.isArray(result.errors) && result.errors.length > 0
        ? result.errors.join('\n')
        : typeof result.result === 'string' && result.result.trim()
          ? result.result.trim()
          : 'Claude returned an error result.';
    return `Claude turn failed (${result.subtype ?? 'unknown'}): ${detail}`;
  }

  private handleEvent(session: ChatSession, msg: SDKMessage): void {
    const ts = Date.now();

    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          // Capture sessionId for resume across settings changes.
          if (typeof msg.session_id === 'string') {
            session.resumableSessionId = msg.session_id;
            this.debug(session, 'sdk-init', { sdkSessionId: msg.session_id });
          }
        } else if (msg.subtype === 'task_notification') {
          this.push(session, {
            kind: 'background-task',
            taskId: msg.task_id,
            status: msg.status,
            summary: msg.summary ?? '',
            ts,
          });
          this.debug(session, 'task-notification', {
            taskId: msg.task_id,
            status: msg.status,
          });
        } else if (msg.subtype === 'task_started') {
          const task = msg as SDKMessage & {
            task_id?: string;
            tool_use_id?: string;
            description?: string;
            prompt?: string;
          };
          this.push(session, {
            kind: 'task-event',
            taskId: task.task_id ?? '',
            toolUseId: task.tool_use_id,
            status: 'started',
            summary: task.description ?? task.prompt ?? 'Background task started.',
            turnId: this.turnId(session),
            ts,
          });
        } else if (msg.subtype === 'task_progress') {
          const task = msg as SDKMessage & {
            task_id?: string;
            tool_use_id?: string;
            description?: string;
            summary?: string;
          };
          this.push(session, {
            kind: 'task-event',
            taskId: task.task_id ?? '',
            toolUseId: task.tool_use_id,
            status: 'progress',
            summary: task.summary ?? task.description ?? 'Background task progress.',
            turnId: this.turnId(session),
            ts,
          });
        } else if (msg.subtype === 'task_updated') {
          const task = msg as SDKMessage & {
            task_id?: string;
            patch?: { status?: string; description?: string; error?: string };
          };
          this.push(session, {
            kind: 'task-event',
            taskId: task.task_id ?? '',
            status: task.patch?.status ?? 'updated',
            summary: task.patch?.error ?? task.patch?.description ?? 'Background task updated.',
            turnId: this.turnId(session),
            ts,
          });
        }
        // Other system subtypes (status, compact_boundary, session_state_changed,
        // task_started, task_progress, task_updated, mirror_error, …) are
        // ignored for the chat UI but don't crash us.
        return;
      }
      case 'stream_event': {
        this.pushTurnStatus(session, 'streaming', 'Claude is responding.');
        // Partial message events: text and thinking deltas while Claude is still typing.
        const ev = (msg as {
          event?: {
            type?: string;
            content_block?: { type?: string };
            delta?: { type?: string; text?: string; thinking?: string };
          };
        }).event;
        if (ev?.type === 'content_block_delta') {
          if (ev.delta?.type === 'text_delta') {
            session.sawTextDeltaInTurn = true;
            this.push(session, { kind: 'text-delta', text: ev.delta.text ?? '', turnId: this.turnId(session), ts });
          } else if (ev.delta?.type === 'thinking_delta') {
            session.sawThinkingDeltaInTurn = true;
            this.push(session, { kind: 'thinking-delta', text: ev.delta.thinking ?? '', turnId: this.turnId(session), ts });
          }
          // signature_delta carries the cryptographic signature for the
          // thinking block — opaque, not human-readable; ignore.
        } else if (ev?.type === 'content_block_start' && ev.content_block?.type === 'redacted_thinking') {
          // Redacted thinking blocks have no deltas; the data is opaque.
          this.push(session, { kind: 'thinking-delta', text: '[encrypted thinking]', turnId: this.turnId(session), ts });
          this.push(session, { kind: 'thinking-stop', turnId: this.turnId(session), ts });
        } else if (ev?.type === 'content_block_stop') {
          // Idempotent on the frontend: only an open thinking bubble responds.
          this.push(session, { kind: 'thinking-stop', turnId: this.turnId(session), ts });
        }
        return;
      }
      case 'rate_limit_event': {
        const rate = msg as SDKMessage & {
          rate_limit_info?: {
            status?: string;
            rateLimitType?: string;
            utilization?: number;
            resetsAt?: number;
          };
        };
        const info = rate.rate_limit_info ?? {};
        const parts = [
          info.status ? `status=${info.status}` : null,
          info.rateLimitType ? `type=${info.rateLimitType}` : null,
          typeof info.utilization === 'number' ? `utilization=${Math.round(info.utilization * 100)}%` : null,
          typeof info.resetsAt === 'number' ? `resets=${new Date(info.resetsAt).toLocaleTimeString()}` : null,
        ].filter(Boolean);
        this.push(session, {
          kind: 'rate-limit',
          status: info.status ?? 'unknown',
          summary: parts.length ? parts.join(', ') : 'Claude rate limit status changed.',
          turnId: this.turnId(session),
          ts,
        });
        return;
      }
      case 'assistant': {
        this.pushTurnStatus(session, 'streaming', 'Claude is responding.');
        // Full assistant message — surface tool_use blocks. Text usually
        // arrives as stream_event deltas; if it did not, emit it here so the
        // chat never appears silent.
        const content = msg.message.content;
        const blocks = (Array.isArray(content) ? content : []) as unknown as Array<Record<string, unknown>>;
        for (const b of blocks) {
          if (b.type === 'text' && !session.sawTextDeltaInTurn) {
            const text = typeof b.text === 'string' ? b.text : '';
            if (text) this.push(session, { kind: 'text-delta', text, turnId: this.turnId(session), ts });
          } else if (b.type === 'thinking' && !session.sawThinkingDeltaInTurn) {
            const thinking = typeof b.thinking === 'string' ? b.thinking : '';
            if (thinking) {
              this.push(session, { kind: 'thinking-delta', text: thinking, turnId: this.turnId(session), ts });
              this.push(session, { kind: 'thinking-stop', turnId: this.turnId(session), ts });
            }
          } else if (b.type === 'tool_use') {
            const tool = String(b.name ?? '');
            const input = b.input;
            if (isArtRunTool(tool, input)) {
              runController.markExternalRunStarting(session.projectDir);
            }
            this.push(session, {
              kind: 'tool-use',
              tool,
              input,
              toolId: String(b.id ?? ''),
              turnId: this.turnId(session),
              ts,
            });
          }
        }
        return;
      }
      case 'user': {
        this.pushTurnStatus(session, 'streaming', 'Claude returned a tool result.');
        // Tool results echoed back in user-role message blocks.
        const content = msg.message.content;
        const blocks = (Array.isArray(content) ? content : []) as unknown as Array<Record<string, unknown>>;
        for (const b of blocks) {
          if (b.type === 'tool_result') {
            const c = b.content;
            const out = typeof c === 'string'
              ? c
              : Array.isArray(c)
                ? (c as Array<{ text?: string }>).map((x) => x.text ?? '').join('')
                : JSON.stringify(c);
            this.push(session, {
              kind: 'tool-result',
              toolId: String(b.tool_use_id ?? ''),
              output: out.slice(0, 2000),
              isError: !!b.is_error,
              turnId: this.turnId(session),
              ts,
            });
          }
        }
        return;
      }
      case 'result': {
        const errorMessage = this.resultErrorMessage(msg);
        const turnId = this.turnId(session);
        if (errorMessage) {
          this.push(session, { kind: 'error', message: errorMessage, turnId, ts });
        }
        this.debug(session, 'turn-result', {
          subtype: (msg as { subtype?: string }).subtype,
          isError: (msg as { is_error?: boolean }).is_error,
          errorMessage,
          durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : undefined,
          cost: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined,
        });
        this.completeActiveTurn(session, {
          cost: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined,
          durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : undefined,
        });
        if (errorMessage && session.v2) {
          const failedV2 = session.v2;
          try { failedV2.close(); } catch { /* ignore */ }
          this.detachLiveSession(session, failedV2);
        }
        return;
      }
      default:
        return;
    }
  }
}

export const chatController = new ChatController();
