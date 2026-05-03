import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';

import { APP_ROOT, ART_DIR_NAME } from './config.ts';

const execFileP = promisify(execFile);
const BWRAP_BIN = 'bwrap';
const DEBUGGER_DIR_NAME = '.debugger';
const CLAUDE_CONFIG_DIR_NAME = 'claude-config';
const TMP_DIR_NAME = 'tmp';
const DEBUG_LOGS_DIR_NAME = 'logs';
const ART_RUNTIME_DIR_NAME = 'art-runtime';
const ART_RUNTIME_GROUPS_DIR_NAME = 'groups';
const MEMORY_FILE_NAME = 'MEMORY.md';
const PERMISSIONS_FILE_NAME = 'permissions.json';
export const DEBUGGER_CLAUDE_WRAPPER_PATH = fileURLToPath(import.meta.url);
const ART_RUN_PRELOAD_PATH = path.join(APP_ROOT, 'server', 'art-runtime-fs-redirect.mjs');
const ART_RUN_PRELOAD_SPECIFIER = pathToFileURL(ART_RUN_PRELOAD_PATH).href;

export interface DebuggerSandboxStatus {
  present: boolean;
  executable?: string;
  error?: string;
}

export interface DebuggerWorkspace {
  projectDir: string;
  artRepoDir: string;
  artDir: string;
  debuggerDir: string;
  claudeConfigDir: string;
  tmpDir: string;
  debugLogsDir: string;
  artRuntimeDir: string;
  runtimeGroupsDir: string;
  memoryPath: string;
  permissionsPath: string;
}

export interface DebuggerSandboxLaunch {
  executable: string;
  executableArgs: string[];
  env: NodeJS.ProcessEnv;
}

export type DebuggerExecutionPermissionDecision = 'allow_once' | 'allow_project' | 'deny';

export interface DebuggerExecutionPermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  command: string;
  normalizedCommand: string;
}

export interface DebuggerExecutionPermissionController {
  isCommandAllowed(command: string): boolean;
  requestCommandPermission(request: DebuggerExecutionPermissionRequest): Promise<DebuggerExecutionPermissionDecision>;
}

export type DebuggerBashPolicyKind = 'allow' | 'ask' | 'deny';
export type DebuggerBashPolicyReason =
  | 'auto-art-run'
  | 'auto-read-only'
  | 'auto-art-write'
  | 'remembered-project-command'
  | 'needs-user-approval'
  | 'missing-command'
  | 'other-art-run-target'
  | 'direct-container-runtime'
  | 'localhost-api'
  | 'unsafe-shell-form';

export interface DebuggerBashCommandPolicy {
  kind: DebuggerBashPolicyKind;
  reason: DebuggerBashPolicyReason;
  message: string;
  command: string;
  normalizedCommand: string;
  updatedInput: Record<string, unknown>;
}

export interface DebuggerBashCommandPolicyOptions {
  isRememberedAllowed?: (normalizedCommand: string) => boolean;
}

function pathEntries(): string[] {
  return (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
}

function findExecutable(bin: string): string | null {
  if (bin.includes(path.sep)) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return bin;
    } catch {
      return null;
    }
  }

  for (const entry of pathEntries()) {
    const candidate = path.join(entry, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // try next PATH entry
    }
  }
  return null;
}

export function requireBubblewrap(): string {
  const executable = findExecutable(BWRAP_BIN);
  if (!executable) {
    throw new Error(
      'Debugger sandbox is unavailable: bubblewrap (`bwrap`) was not found on PATH. ' +
        'The left-panel debugger refuses to run without hard filesystem isolation.',
    );
  }
  return executable;
}

export async function debuggerSandboxStatus(): Promise<DebuggerSandboxStatus> {
  const executable = findExecutable(BWRAP_BIN);
  if (!executable) {
    return {
      present: false,
      error: 'bubblewrap (`bwrap`) not found on PATH',
    };
  }

  try {
    await execFileP(
      executable,
      ['--ro-bind', '/', '/', '--dev', '/dev', '--tmpfs', '/tmp', '--die-with-parent', '--', '/bin/true'],
      { timeout: 5000, maxBuffer: 128 * 1024 },
    );
    return { present: true, executable };
  } catch (e) {
    return {
      present: false,
      executable,
      error: `bubblewrap probe failed: ${(e as Error).message}`,
    };
  }
}

export function prepareDebuggerWorkspace(projectDir: string, seedMemoryPath: string): DebuggerWorkspace {
  const canonicalProjectDir = fs.realpathSync(projectDir);
  const artRepoDir = fs.realpathSync(path.resolve(APP_ROOT, '..'));
  const artDir = path.join(canonicalProjectDir, ART_DIR_NAME);
  const debuggerDir = path.join(artDir, DEBUGGER_DIR_NAME);
  const claudeConfigDir = path.join(debuggerDir, CLAUDE_CONFIG_DIR_NAME);
  const tmpDir = path.join(debuggerDir, TMP_DIR_NAME);
  const debugLogsDir = path.join(debuggerDir, DEBUG_LOGS_DIR_NAME);
  const artRuntimeDir = path.join(debuggerDir, ART_RUNTIME_DIR_NAME);
  const runtimeGroupsDir = path.join(artRuntimeDir, ART_RUNTIME_GROUPS_DIR_NAME);
  const memoryPath = path.join(debuggerDir, MEMORY_FILE_NAME);
  const permissionsPath = path.join(debuggerDir, PERMISSIONS_FILE_NAME);

  fs.mkdirSync(artDir, { recursive: true });
  fs.mkdirSync(debuggerDir, { recursive: true });
  fs.mkdirSync(claudeConfigDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(debugLogsDir, { recursive: true });
  fs.mkdirSync(runtimeGroupsDir, { recursive: true });

  if (!fs.existsSync(memoryPath)) {
    let seed = '# Debugger Memory\n\nNo entries yet.\n';
    try {
      seed = fs.readFileSync(seedMemoryPath, 'utf8');
    } catch {
      // The seed is only a convenience; the per-project memory file is what matters.
    }
    fs.writeFileSync(memoryPath, seed);
  }

  return {
    projectDir: canonicalProjectDir,
    artRepoDir,
    artDir,
    debuggerDir,
    claudeConfigDir,
    tmpDir,
    debugLogsDir,
    artRuntimeDir,
    runtimeGroupsDir,
    memoryPath,
    permissionsPath,
  };
}

export function buildDebuggerSandboxLaunch(
  workspace: DebuggerWorkspace,
  env: NodeJS.ProcessEnv,
): DebuggerSandboxLaunch {
  const executable = requireBubblewrap();
  const executableArgs = [
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--bind',
    workspace.artDir,
    workspace.artDir,
    '--tmpfs',
    '/tmp',
    '--unshare-pid',
    '--proc',
    '/proc',
    '--die-with-parent',
    '--',
    process.execPath,
    '--experimental-strip-types',
  ];

  return {
    executable,
    executableArgs,
    env: {
      ...env,
      AER_ART_PROJECT_DIR: workspace.projectDir,
      CLAUDE_CONFIG_DIR: workspace.claudeConfigDir,
      CLAUDE_CODE_DEBUG_LOGS_DIR: workspace.debugLogsDir,
      TMPDIR: workspace.tmpDir,
      TEMP: workspace.tmpDir,
      TMP: workspace.tmpDir,
    },
  };
}

function withTilde(p: string): string {
  const home = os.homedir();
  return p.startsWith(home + path.sep) ? `~/${p.slice(home.length + 1)}` : p;
}

function isInsidePath(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeShell(command: string): string {
  return command
    .replace(/\\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeDebuggerCommand(command: string): string {
  return normalizeShell(command);
}

interface ShellTokenizeResult {
  tokens: string[];
  sawControl: boolean;
  sawCommandSubstitution: boolean;
  sawUnknownExpansion: boolean;
  unclosedQuote: boolean;
}

const READ_ONLY_COMMANDS = new Set([
  'cat',
  'find',
  'git',
  'grep',
  'head',
  'kill',
  'ls',
  'pwd',
  'rg',
  'sed',
  'sleep',
  'sort',
  'stat',
  'tail',
  'true',
  'wc',
]);

const READ_ONLY_ECHO_COMMANDS = new Set(['echo', 'false', 'printf', 'true']);

const XARGS_READ_ONLY_COMMANDS = new Set(['cat', 'head', 'tail', 'wc']);
const XARGS_PATH_PRODUCER_COMMANDS = new Set(['find', 'ls', 'rg']);

const ART_WRITE_COMMANDS = new Set([
  'mkdir',
  'rm',
  'rmdir',
  'touch',
]);

const DIRECT_CONTAINER_COMMANDS = new Set([
  'colima',
  'container',
  'docker',
  'docker-compose',
  'docker_rm',
  'nerdctl',
  'podman',
  'udocker',
]);

const DIRECT_SCRIPTING_COMMANDS = new Set([
  'node',
  'perl',
  'php',
  'python',
  'python3',
  'ruby',
]);

function policy(
  kind: DebuggerBashPolicyKind,
  reason: DebuggerBashPolicyReason,
  message: string,
  command: string,
  updatedInput: Record<string, unknown>,
): DebuggerBashCommandPolicy {
  return {
    kind,
    reason,
    message,
    command,
    normalizedCommand: normalizeDebuggerCommand(command),
    updatedInput,
  };
}

function tokenizeShell(command: string): ShellTokenizeResult {
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let sawControl = false;
  let sawCommandSubstitution = false;
  let sawUnknownExpansion = false;

  const push = () => {
    if (current.length === 0) return;
    tokens.push(current);
    current = '';
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];

    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === '\\' && next !== undefined) {
        current += next;
        i += 1;
      } else {
        if (ch === '$' && !isAllowedProjectExpansion(command, i)) {
          sawUnknownExpansion = true;
        }
        if (ch === '$' && next === '(') {
          sawCommandSubstitution = true;
        }
        current += ch;
      }
      continue;
    }

    if (/\s/.test(ch)) {
      push();
      continue;
    }
    if (ch === "'") {
      quote = "'";
      continue;
    }
    if (ch === '"') {
      quote = '"';
      continue;
    }
    if (ch === '\\' && next !== undefined) {
      current += next;
      i += 1;
      continue;
    }
    if (';|<>&`'.includes(ch)) {
      sawControl = true;
    }
    if (ch === '$') {
      if (next === '(') sawCommandSubstitution = true;
      if (!isAllowedProjectExpansion(command, i)) sawUnknownExpansion = true;
    }
    current += ch;
  }
  push();

  return {
    tokens,
    sawControl,
    sawCommandSubstitution,
    sawUnknownExpansion,
    unclosedQuote: quote !== null,
  };
}

function isAllowedProjectExpansion(command: string, index: number): boolean {
  return (
    command.startsWith('$AER_ART_PROJECT_DIR', index) ||
    command.startsWith('${AER_ART_PROJECT_DIR}', index)
  );
}

function commandName(token: string | undefined): string {
  if (!token) return '';
  return path.basename(token).toLowerCase();
}

function isDirectContainerRuntime(tokens: string[]): boolean {
  const first = commandName(tokens[0]);
  const second = commandName(tokens[1]);
  return DIRECT_CONTAINER_COMMANDS.has(first) || (first === 'sudo' && DIRECT_CONTAINER_COMMANDS.has(second));
}

function isDirectScriptingRuntime(tokens: string[]): boolean {
  const first = commandName(tokens[0]);
  const second = commandName(tokens[1]);
  return DIRECT_SCRIPTING_COMMANDS.has(first) || (first === 'sudo' && DIRECT_SCRIPTING_COMMANDS.has(second));
}

function targetsLocalhostApi(command: string): boolean {
  return (
    /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)(?::\d+)?(?:\/|\b)/i.test(command) ||
    /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+\b/i.test(command)
  );
}

function hasLongRunningShellLoop(command: string): boolean {
  return /\b(?:until|while|for)\b[\s\S]*\bdo\b[\s\S]*\bdone\b/i.test(command);
}

interface ShellListResult {
  segments: string[];
  unsafe: boolean;
}

function splitReadOnlyShellList(command: string): ShellListResult {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let unsafe = false;

  const push = () => {
    const trimmed = current.trim();
    if (!trimmed) {
      unsafe = true;
    } else {
      segments.push(trimmed);
    }
    current = '';
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];

    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = null;
      continue;
    }

    if (quote === '"') {
      current += ch;
      if (ch === '"') quote = null;
      else if (ch === '\\' && next !== undefined) {
        current += next;
        i += 1;
      }
      continue;
    }

    if (ch === "'") {
      quote = "'";
      current += ch;
      continue;
    }
    if (ch === '"') {
      quote = '"';
      current += ch;
      continue;
    }
    if (ch === '\\' && next !== undefined) {
      current += ch + next;
      i += 1;
      continue;
    }
    if (ch === '`' || ch === '(' || ch === ')') {
      unsafe = true;
      current += ch;
      continue;
    }
    if (ch === ';') {
      push();
      continue;
    }
    if (ch === '&') {
      if (next === '&') {
        push();
        i += 1;
        continue;
      }
      if (next === '>' || current.endsWith('>') || current.endsWith('<')) {
        current += ch;
        continue;
      }
      unsafe = true;
      current += ch;
      continue;
    }
    if (ch === '|') {
      if (next === '|') {
        push();
        i += 1;
      } else {
        push();
      }
      continue;
    }
    current += ch;
  }

  if (quote !== null) unsafe = true;
  push();
  return { segments, unsafe };
}

function unsafeReadOnlyArgs(name: string, tokens: string[]): boolean {
  const args = tokens.slice(1);
  if (name === 'find') {
    return args.some((arg) => ['-delete', '-exec', '-execdir', '-ok', '-okdir'].includes(arg));
  }
  if (name === 'sed') {
    return args.some((arg) => arg === '-i' || arg.startsWith('-i') || arg === '--in-place');
  }
  if (name === 'tail') {
    return args.some((arg) => arg === '-f' || arg === '-F' || arg === '--follow' || arg.startsWith('--follow='));
  }
  if (name === 'rg') {
    return args.some((arg) => arg === '--pre' || arg.startsWith('--pre='));
  }
  if (name === 'sleep') {
    if (args.length !== 1) return true;
    const seconds = Number(args[0]);
    return !Number.isFinite(seconds) || seconds < 0 || seconds > 60;
  }
  if (name === 'kill') {
    return args.length !== 2 || args[0] !== '-0' || !/^[1-9][0-9]*$/.test(args[1]);
  }
  if (name === 'true' || name === 'false') {
    return args.length > 0;
  }
  if (name === 'git') {
    return unsafeGitReadOnlyArgs(args);
  }
  return false;
}

function unsafeGitReadOnlyArgs(args: string[]): boolean {
  if (args.some((arg) => arg === '-c' || arg.startsWith('-c') || arg === '--exec-path' || arg.startsWith('--exec-path='))) {
    return true;
  }
  let commandIndex = 0;
  for (; commandIndex < args.length; commandIndex += 1) {
    const arg = args[commandIndex];
    if (!arg.startsWith('-')) break;
    if (!['-C'].includes(arg)) return true;
    commandIndex += 1;
  }
  const subcommand = args[commandIndex];
  const rest = args.slice(commandIndex + 1);
  if (subcommand === 'status') {
    return rest.some((arg) => (
      arg.startsWith('-') &&
      ![
        '--branch',
        '--ignored',
        '--ignored=matching',
        '--ignored=traditional',
        '--ignored=no',
        '--long',
        '--porcelain',
        '--porcelain=v1',
        '--porcelain=v2',
        '--short',
        '--show-stash',
        '--untracked-files',
        '--untracked-files=all',
        '--untracked-files=no',
        '--untracked-files=normal',
        '-b',
        '-s',
        '-u',
        '-uno',
      ].includes(arg)
    ));
  }
  if (subcommand === 'diff') {
    return rest.some((arg) => arg === '--output' || arg.startsWith('--output='));
  }
  if (['log', 'ls-files', 'rev-parse', 'show'].includes(subcommand)) return false;
  return true;
}

function stripAllowedRedirections(tokens: string[], workspace: DebuggerWorkspace): string[] | null {
  const stripped: string[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const next = tokens[i + 1];

    if (/^(?:[0-9]?>|[0-9]?>>|&>)\/dev\/null$/.test(token)) {
      continue;
    }
    if (/^[0-9]?>&[0-9]$/.test(token)) {
      continue;
    }
    if (/^(?:[0-9]?>|[0-9]?>>|&>)$/.test(token)) {
      if (next !== '/dev/null') return null;
      i += 1;
      continue;
    }

    const inlineInput = /^(?:[0-9]?<)(.+)$/.exec(token);
    if (inlineInput) {
      if (!isAllowedReadPath(inlineInput[1], workspace)) return null;
      continue;
    }
    if (/^[0-9]?</.test(token)) {
      if (!next || !isAllowedReadPath(next, workspace)) return null;
      i += 1;
      continue;
    }

    if (token.includes('>') || token.includes('<')) return null;
    stripped.push(token);
  }

  return stripped;
}

function isPathLikeToken(token: string): boolean {
  if (!token || token.startsWith('-')) return false;
  return (
    token.includes('/') ||
    token.startsWith('.') ||
    token.startsWith('~') ||
    token.startsWith('$AER_ART_PROJECT_DIR') ||
    token.startsWith('${AER_ART_PROJECT_DIR}')
  );
}

function stripFileUrlPrefix(value: string): string {
  return value.startsWith('file://') ? value.slice('file://'.length) : value;
}

function isAllowedReadPath(token: string, workspace: DebuggerWorkspace): boolean {
  const expanded = stripFileUrlPrefix(expandShellPathRefs(token, workspace.projectDir));
  const resolved = resolvePossiblyMissingPath(
    workspace.projectDir,
    path.isAbsolute(expanded) ? expanded : path.resolve(workspace.projectDir, expanded),
  );
  return (
    isInsidePath(resolved, workspace.projectDir) ||
    isInsidePath(resolved, workspace.artRepoDir) ||
    isAllowedDebuggerHostReadPath(resolved)
  );
}

function isAllowedDebuggerHostReadPath(resolved: string): boolean {
  const aerConfigDir = path.join(os.homedir(), '.config', 'aer-art');
  return [
    path.join(aerConfigDir, 'mount-allowlist.json'),
    path.join(aerConfigDir, 'images.json'),
    path.join(aerConfigDir, 'mcp-registry.json'),
  ].some((allowed) => resolved === allowed);
}

function isAutoReadOnlySegment(command: string, workspace: DebuggerWorkspace): boolean {
  const parsed = tokenizeShell(command);
  if (
    parsed.unclosedQuote ||
    parsed.sawCommandSubstitution ||
    parsed.sawUnknownExpansion ||
    parsed.tokens.length === 0
  ) {
    return false;
  }

  const tokens = stripAllowedRedirections(parsed.tokens, workspace);
  if (!tokens || tokens.length === 0) return false;

  const name = commandName(tokens[0]);
  if (!READ_ONLY_COMMANDS.has(name) && !READ_ONLY_ECHO_COMMANDS.has(name)) return false;
  if (unsafeReadOnlyArgs(name, tokens)) return false;
  if (READ_ONLY_ECHO_COMMANDS.has(name)) return true;

  for (const token of tokens.slice(1)) {
    if (!isPathLikeToken(token)) continue;
    if (!isAllowedReadPath(token, workspace)) return false;
  }
  return true;
}

function strippedReadOnlyTokens(command: string, workspace: DebuggerWorkspace): string[] | null {
  const parsed = tokenizeShell(command);
  if (
    parsed.unclosedQuote ||
    parsed.sawCommandSubstitution ||
    parsed.sawUnknownExpansion ||
    parsed.tokens.length === 0
  ) {
    return null;
  }
  return stripAllowedRedirections(parsed.tokens, workspace);
}

function readOnlySegmentName(command: string, workspace: DebuggerWorkspace): string {
  const tokens = strippedReadOnlyTokens(command, workspace);
  return tokens ? commandName(tokens[0]) : '';
}

function isAutoReadOnlyXargsSegment(
  command: string,
  priorSegments: string[],
  workspace: DebuggerWorkspace,
): boolean {
  const producerSeen = priorSegments
    .map((segment) => readOnlySegmentName(segment, workspace))
    .some((name) => XARGS_PATH_PRODUCER_COMMANDS.has(name));
  if (!producerSeen) return false;

  const tokens = strippedReadOnlyTokens(command, workspace);
  if (!tokens || commandName(tokens[0]) !== 'xargs') return false;

  let commandIndex = 1;
  for (; commandIndex < tokens.length; commandIndex += 1) {
    const arg = tokens[commandIndex];
    if (!arg.startsWith('-')) break;
    if (!['-0', '-r', '--null', '--no-run-if-empty'].includes(arg)) return false;
  }

  const name = commandName(tokens[commandIndex]);
  if (!XARGS_READ_ONLY_COMMANDS.has(name)) return false;
  const delegatedTokens = tokens.slice(commandIndex);
  if (unsafeReadOnlyArgs(name, delegatedTokens)) return false;

  for (const token of delegatedTokens.slice(1)) {
    if (!isPathLikeToken(token)) continue;
    if (!isAllowedReadPath(token, workspace)) return false;
  }
  return true;
}

function isAutoReadOnlyCommand(command: string, workspace: DebuggerWorkspace): boolean {
  const shellList = splitReadOnlyShellList(command);
  if (shellList.unsafe || shellList.segments.length === 0) return false;
  const acceptedSegments: string[] = [];
  for (const segment of shellList.segments) {
    if (isAutoReadOnlySegment(segment, workspace)) {
      acceptedSegments.push(segment);
      continue;
    }
    if (isAutoReadOnlyXargsSegment(segment, acceptedSegments, workspace)) {
      acceptedSegments.push(segment);
      continue;
    }
    return false;
  }
  return true;
}

function isSafeArtWriteOption(name: string, arg: string): boolean {
  if (name === 'mkdir') return ['-p', '-v', '--parents', '--verbose'].includes(arg);
  if (name === 'touch') return ['-a', '-c', '-m', '-v', '--no-create', '--verbose'].includes(arg);
  if (name === 'rmdir') {
    return ['-p', '-v', '--parents', '--verbose', '--ignore-fail-on-non-empty'].includes(arg);
  }
  if (name === 'rm') {
    return [
      '-d',
      '-f',
      '-fr',
      '-rf',
      '-r',
      '-R',
      '-v',
      '--dir',
      '--force',
      '--recursive',
      '--verbose',
      '--one-file-system',
      '--preserve-root',
    ].includes(arg);
  }
  return false;
}

function resolveShellPathToken(token: string, workspace: DebuggerWorkspace): string {
  const expanded = stripFileUrlPrefix(expandShellPathRefs(token, workspace.projectDir));
  return resolvePossiblyMissingPath(
    workspace.projectDir,
    path.isAbsolute(expanded) ? expanded : path.resolve(workspace.projectDir, expanded),
  );
}

function isVolatileArtRuntimePath(resolved: string, workspace: DebuggerWorkspace): boolean {
  return [
    path.join(workspace.artDir, '.state'),
    path.join(workspace.artDir, '.tmp'),
    workspace.artRuntimeDir,
  ].some((base) => isInsidePath(resolved, base));
}

function isAllowedArtWritePath(resolved: string, workspace: DebuggerWorkspace, name: string): boolean {
  if (!isInsidePath(resolved, workspace.artDir)) return false;
  if (resolved === workspace.artDir) return false;
  if (name === 'rm' || name === 'rmdir') return isVolatileArtRuntimePath(resolved, workspace);
  return true;
}

function isAutoArtWriteCommand(command: string, workspace: DebuggerWorkspace): boolean {
  const parsed = tokenizeShell(command);
  if (
    parsed.unclosedQuote ||
    parsed.sawControl ||
    parsed.sawCommandSubstitution ||
    parsed.sawUnknownExpansion ||
    parsed.tokens.length === 0
  ) {
    return false;
  }

  const name = commandName(parsed.tokens[0]);
  if (!ART_WRITE_COMMANDS.has(name)) return false;

  const pathTokens: string[] = [];
  let endOfOptions = false;
  for (const arg of parsed.tokens.slice(1)) {
    if (!endOfOptions && arg === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && arg.startsWith('-')) {
      if (!isSafeArtWriteOption(name, arg)) return false;
      continue;
    }
    pathTokens.push(arg);
  }
  if (pathTokens.length === 0) return false;

  return pathTokens.every((token) => {
    const resolved = resolveShellPathToken(token, workspace);
    return isAllowedArtWritePath(resolved, workspace, name);
  });
}

function hasDirectContainerRuntime(command: string): boolean {
  const shellList = splitReadOnlyShellList(command);
  const segments = shellList.segments.length ? shellList.segments : [command];
  return segments.some((segment) => isDirectContainerRuntime(tokenizeShell(segment).tokens));
}

function hasDirectScriptingRuntime(command: string): boolean {
  const shellList = splitReadOnlyShellList(command);
  const segments = shellList.segments.length ? shellList.segments : [command];
  return segments.some((segment) => isDirectScriptingRuntime(tokenizeShell(segment).tokens));
}

function debuggerArtRunCommand(command: string, workspace: DebuggerWorkspace): string {
  const skipPreflight = /\bart\s+run\s+--skip-preflight\b/.test(command);
  const preload = `--import=${ART_RUN_PRELOAD_SPECIFIER}`;
  return [
    `cd ${shellSingleQuote(workspace.projectDir)}`,
    '&&',
    'env',
    `AER_ART_DEBUGGER_ART_REPO_DIR=${shellSingleQuote(workspace.artRepoDir)}`,
    `AER_ART_DEBUGGER_RUNTIME_GROUPS_DIR=${shellSingleQuote(workspace.runtimeGroupsDir)}`,
    `AER_ART_DEBUGGER_RUNTIME_GIT_DIR=${shellSingleQuote(path.join(workspace.artRuntimeDir, 'project.git'))}`,
    `NODE_OPTIONS=${shellSingleQuote(preload)}`,
    `art run ${skipPreflight ? '--skip-preflight ' : ''}.`,
  ].join(' ');
}

function isDebuggerArtRunWrapper(command: string, workspace: DebuggerWorkspace): boolean {
  const normalized = normalizeShell(command);
  return [
    debuggerArtRunCommand('art run "$AER_ART_PROJECT_DIR"', workspace),
    debuggerArtRunCommand('art run --skip-preflight "$AER_ART_PROJECT_DIR"', workspace),
  ].some((candidate) => normalizeShell(candidate) === normalized);
}

function artRunUpdatedInput(
  input: Record<string, unknown>,
  command: string,
  workspace: DebuggerWorkspace,
): Record<string, unknown> {
  const updated: Record<string, unknown> = {
    ...input,
    command: isDebuggerArtRunWrapper(command, workspace)
      ? normalizeShell(command)
      : debuggerArtRunCommand(command, workspace),
    run_in_background: true,
  };
  if (typeof updated.description !== 'string' || !updated.description.trim()) {
    updated.description = 'Run the loaded ART pipeline in the background';
  }
  return updated;
}

function expandProjectEnvRefs(value: string, projectDir: string): string {
  return value
    .replace(/\$\{AER_ART_PROJECT_DIR\}/g, projectDir)
    .replace(/\$AER_ART_PROJECT_DIR/g, projectDir);
}

function expandShellPathRefs(value: string, projectDir: string): string {
  const home = os.homedir();
  return expandProjectEnvRefs(value, projectDir)
    .replace(/(^|[\s"'=:,(])~(?=\/|\s|$)/g, `$1${home}`);
}

function resolvePossiblyMissingPath(cwd: string, inputPath: string): string {
  const abs = path.resolve(cwd, inputPath);
  let cursor = abs;
  const missing: string[] = [];

  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }

  let realBase = cursor;
  try {
    realBase = fs.realpathSync(cursor);
  } catch {
    realBase = path.resolve(cursor);
  }
  return path.join(realBase, ...missing);
}

function toolPathEntry(input: Record<string, unknown>): { key: string; value: string } | null {
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return { key, value };
  }
  return null;
}

function expandToolPathInput(
  input: Record<string, unknown>,
  entry: { key: string; value: string },
  projectDir: string,
): { pathValue: string; updatedInput: Record<string, unknown> } {
  const pathValue = expandShellPathRefs(entry.value, projectDir);
  return pathValue === entry.value
    ? { pathValue, updatedInput: input }
    : { pathValue, updatedInput: { ...input, [entry.key]: pathValue } };
}

function bashCommand(input: Record<string, unknown>): string {
  const command = input.command;
  return typeof command === 'string' ? command : '';
}

function deny(message: string): PermissionResult {
  return { behavior: 'deny', message, interrupt: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
  return isRecord(input) ? input : {};
}

function allow(updatedInput: unknown): PermissionResult {
  // Claude Code's permission bridge currently validates `allow` responses as
  // requiring an object-valued updatedInput. Returning `{ behavior: 'allow' }`
  // can poison the turn with a tool permission ZodError.
  return { behavior: 'allow', updatedInput: normalizeToolInput(updatedInput) };
}

function isWriteTool(toolName: string): boolean {
  return /^(Edit|MultiEdit|Write|NotebookEdit)$/i.test(toolName);
}

function isReadTool(toolName: string): boolean {
  return /^(Read|Glob|Grep|LS|NotebookRead)$/i.test(toolName);
}

function projectRefPattern(projectDir: string): string {
  return [
    projectDir,
    JSON.stringify(projectDir),
    shellSingleQuote(projectDir),
  ].map(escapeRegex).join('|');
}

function isAllowedArtRun(command: string, projectDir: string): boolean {
  const normalized = normalizeShell(command);
  if (!/\bart\s+run\b/.test(normalized)) return false;
  if (/[;|<>`]/.test(normalized) || normalized.includes('$(')) return false;

  const envRef = String.raw`(?:"\$AER_ART_PROJECT_DIR"|'\$AER_ART_PROJECT_DIR'|\$AER_ART_PROJECT_DIR)`;
  const projectRef = projectRefPattern(projectDir);
  const cdTarget = String.raw`(?:${envRef}|${projectRef})`;
  const runTarget = String.raw`(?:\.|${envRef}|${projectRef})`;
  const pattern = new RegExp(
    String.raw`^(?:cd\s+${cdTarget}\s*&&\s*)?art\s+run\s+(?:--skip-preflight\s+)?${runTarget}\s*$`,
  );
  return pattern.test(normalized);
}

export function classifyDebuggerBashCommand(
  workspace: DebuggerWorkspace,
  input: Record<string, unknown>,
  opts: DebuggerBashCommandPolicyOptions = {},
): DebuggerBashCommandPolicy {
  const command = bashCommand(input);
  const normalizedCommand = normalizeDebuggerCommand(command);
  const normalizedInput =
    command === normalizedCommand ? input : { ...input, command: normalizedCommand };

  if (!normalizedCommand) {
    return policy(
      'deny',
      'missing-command',
      'Bash command denied because no command was provided.',
      normalizedCommand,
      normalizedInput,
    );
  }

  const parsed = tokenizeShell(normalizedCommand);
  if (parsed.unclosedQuote) {
    return policy(
      'ask',
      'unsafe-shell-form',
      'This shell command needs user approval because it contains an unclosed quote.',
      normalizedCommand,
      normalizedInput,
    );
  }

  if (hasLongRunningShellLoop(normalizedCommand)) {
    return policy(
      'deny',
      'unsafe-shell-form',
      'Shell polling loops are denied in the ART pipeline debugger. Use bounded `sleep` plus read-only inspection commands instead.',
      normalizedCommand,
      normalizedInput,
    );
  }

  if (hasDirectContainerRuntime(normalizedCommand)) {
    return policy(
      'deny',
      'direct-container-runtime',
      'Direct container/runtime control is denied in the ART pipeline debugger. Use `art run` so ART owns container policy.',
      normalizedCommand,
      normalizedInput,
    );
  }

  if (hasDirectScriptingRuntime(normalizedCommand)) {
    return policy(
      'deny',
      'unsafe-shell-form',
      'Direct scripting runtimes are denied in the ART pipeline debugger. Read files directly instead of running ad hoc Python/Node/Perl/Ruby/PHP.',
      normalizedCommand,
      normalizedInput,
    );
  }

  if (targetsLocalhostApi(normalizedCommand)) {
    return policy(
      'deny',
      'localhost-api',
      'Localhost API calls are denied in the ART pipeline debugger. The GUI watches filesystem state; run `art` directly instead.',
      normalizedCommand,
      normalizedInput,
    );
  }

  if (/\bart\s+run\b/.test(normalizedCommand)) {
    if (
      isAllowedArtRun(normalizedCommand, workspace.projectDir) ||
      isDebuggerArtRunWrapper(normalizedCommand, workspace)
    ) {
      return policy(
        'allow',
        'auto-art-run',
        '`art run` for the loaded project is auto-allowed, forced to run in the background, and kept inside the selected project __art__ runtime area.',
        normalizedCommand,
        artRunUpdatedInput(normalizedInput, normalizedCommand, workspace),
      );
    }
    return policy(
      'deny',
      'other-art-run-target',
      '`art run` is denied unless it targets the currently loaded project.',
      normalizedCommand,
      normalizedInput,
    );
  }

  if (opts.isRememberedAllowed?.(normalizedCommand)) {
    return policy(
      'allow',
      'remembered-project-command',
      'Execution was already allowed for this project.',
      normalizedCommand,
      normalizedInput,
    );
  }

  if (isAutoReadOnlyCommand(normalizedCommand, workspace)) {
    return policy(
      'allow',
      'auto-read-only',
      'Read-only inspection of the loaded project or ART repo is auto-allowed.',
      normalizedCommand,
      normalizedInput,
    );
  }

  if (isAutoArtWriteCommand(normalizedCommand, workspace)) {
    return policy(
      'allow',
      'auto-art-write',
      'Conservative writes under the selected project __art__ runtime area are auto-allowed.',
      normalizedCommand,
      normalizedInput,
    );
  }

  return policy(
    'ask',
    'needs-user-approval',
    'This debugger command needs user approval.',
    normalizedCommand,
    normalizedInput,
  );
}

export function createDebuggerCanUseTool(
  workspace: DebuggerWorkspace,
  executionPermissions?: DebuggerExecutionPermissionController,
): CanUseTool {
  const projectDir = workspace.projectDir;
  const artDir = workspace.artDir;

  return async (toolName, input) => {
    const toolInput = normalizeToolInput(input);
    const pathEntry = toolPathEntry(toolInput);

    if (isWriteTool(toolName)) {
      if (!pathEntry) {
        return deny(`${toolName} is denied because no target path was provided.`);
      }
      const { pathValue, updatedInput } = expandToolPathInput(toolInput, pathEntry, projectDir);
      const resolved = resolvePossiblyMissingPath(projectDir, pathValue);
      if (!isInsidePath(resolved, artDir)) {
        return deny(
          `${toolName} is denied for ${withTilde(resolved)}. ` +
            `The debugger may write only under ${withTilde(artDir)}.`,
        );
      }
      return allow(updatedInput);
    }

    if (isReadTool(toolName)) {
      if (!pathEntry) return allow(toolInput);
      const { updatedInput } = expandToolPathInput(toolInput, pathEntry, projectDir);
      return allow(updatedInput);
    }

    if (/^Bash$/i.test(toolName)) {
      const command = bashCommand(toolInput);
      const commandPolicy = classifyDebuggerBashCommand(workspace, toolInput, {
        isRememberedAllowed: executionPermissions?.isCommandAllowed,
      });
      if (commandPolicy.kind === 'deny') {
        return deny(commandPolicy.message);
      }
      if (commandPolicy.kind === 'allow') {
        return {
          ...allow(commandPolicy.updatedInput),
          decisionClassification:
            commandPolicy.reason === 'remembered-project-command'
              ? 'user_permanent'
              : 'user_temporary',
        };
      }
      if (!executionPermissions) {
        return deny('Bash command denied because no execution permission controller is configured.');
      }
      const decision = await executionPermissions.requestCommandPermission({
        toolName,
        input: commandPolicy.updatedInput,
        command,
        normalizedCommand: commandPolicy.normalizedCommand,
      });
      if (decision === 'deny') {
        return {
          ...deny('Execution denied by user.'),
          decisionClassification: 'user_reject',
        };
      }
      return {
        ...allow(commandPolicy.updatedInput),
        decisionClassification: decision === 'allow_project' ? 'user_permanent' : 'user_temporary',
      };
    }

    return deny(`${toolName} is not available in the isolated ART debugger.`);
  };
}

function findNativeClaudeExecutable(): string {
  const anthropicDir = path.join(APP_ROOT, 'node_modules', '@anthropic-ai');
  const candidates = fs
    .readdirSync(anthropicDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('claude-agent-sdk-'))
    .map((entry) => path.join(anthropicDir, entry.name, 'claude'));

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // try next SDK native package
    }
  }

  throw new Error(`No packaged Claude native executable found under ${anthropicDir}.`);
}

function isWrapperEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(DEBUGGER_CLAUDE_WRAPPER_PATH);
  } catch {
    return path.resolve(entry) === DEBUGGER_CLAUDE_WRAPPER_PATH;
  }
}

if (isWrapperEntrypoint()) {
  const child = spawn(findNativeClaudeExecutable(), process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  child.on('error', (err) => {
    console.error(`Failed to start packaged Claude executable: ${err.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}
