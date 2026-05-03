import fs from 'node:fs';
import path from 'node:path';

import type { NodeLogLine, PipelineConfig, PipelineStage, PipelineState } from './types.ts';

interface NodeLogContext {
  knownStages: Set<string>;
}

function stagesFromSnapshot(
  config: PipelineConfig | null,
  state: PipelineState | null,
): PipelineStage[] {
  return [
    ...(config?.stages ?? []),
    ...(state?.insertedStages ?? []),
  ];
}

export function buildNodeLogContext(
  config: PipelineConfig | null,
  state: PipelineState | null,
): NodeLogContext {
  return {
    knownStages: new Set(stagesFromSnapshot(config, state).map((stage) => stage.name)),
  };
}

export function resolveNodeLogStage(alias: string, context: NodeLogContext): string {
  if (context.knownStages.has(alias)) return alias;

  if (alias.startsWith('pipeline-')) {
    const stripped = alias.slice('pipeline-'.length);
    if (context.knownStages.has(stripped)) return stripped;
  }

  return alias;
}

function splitLogTag(tag: string): { alias: string; kind: 'stdout' | 'stderr' } {
  const separator = tag.lastIndexOf(':');
  if (separator === -1) return { alias: tag, kind: 'stdout' };

  const suffix = tag.slice(separator + 1);
  if (suffix !== 'stderr' && suffix !== 'stdout') {
    return { alias: tag, kind: 'stdout' };
  }

  return {
    alias: tag.slice(0, separator),
    kind: suffix,
  };
}

function parseStageHeader(line: string): string | null {
  const stageStart = /^=== Stage: (.+?) ===$/.exec(line);
  if (stageStart) return stageStart[1];

  const commandStart = /^=== Command Stage: (.+?) ===$/.exec(line);
  if (commandStart) return commandStart[1];

  const stageExit = /^=== Stage (.+?) exited:/.exec(line);
  if (stageExit) return stageExit[1];

  const commandExit = /^=== Command Stage (.+?) exited:/.exec(line);
  if (commandExit) return commandExit[1];

  return null;
}

export function parseNodeLogLine(
  line: string,
  context: NodeLogContext,
  sourceFile?: string,
): NodeLogLine | null {
  const prefixMatch = /^\[([^\]\r\n]+)\]\s?(.*)$/.exec(line);
  if (prefixMatch) {
    const { alias, kind } = splitLogTag(prefixMatch[1]);
    return {
      stage: resolveNodeLogStage(alias, context),
      kind,
      line,
      sourceFile,
    };
  }

  const headerAlias = parseStageHeader(line);
  if (!headerAlias) return null;

  return {
    stage: resolveNodeLogStage(headerAlias, context),
    kind: 'stdout',
    line,
    sourceFile,
  };
}

export function listPipelineLogFiles(logsDir: string): string[] {
  if (!fs.existsSync(logsDir)) return [];

  const files: string[] = [];
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile() && entry.name.startsWith('pipeline-') && entry.name.endsWith('.log')) {
        files.push(fullPath);
      }
    }
  };

  visit(logsDir);
  return files;
}

export function findLatestPipelineLogFile(logsDir: string): string | null {
  const files = listPipelineLogFiles(logsDir);
  if (files.length === 0) return null;

  return files
    .map((file) => {
      try {
        return { file, mtimeMs: fs.statSync(file).mtimeMs };
      } catch {
        return { file, mtimeMs: 0 };
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file))[0].file;
}

export function tailNodeLogLines(
  filePath: string,
  stageName: string,
  context: NodeLogContext,
  maxLines: number,
): NodeLogLine[] {
  try {
    const sourceFile = path.basename(filePath);
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw
      .split('\n')
      .map((line) => parseNodeLogLine(line, context, sourceFile))
      .filter((line): line is NodeLogLine => line !== null && line.stage === stageName)
      .slice(-maxLines);
  } catch {
    return [];
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stringifyCompact(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function textFromClaudeContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return stringifyCompact(content);

  return content
    .map((part) => {
      if (!isPlainRecord(part)) return stringifyCompact(part);
      const type = asString(part.type) ?? 'content';
      if (type === 'text') return asString(part.text) ?? '';
      if (type === 'thinking') return asString(part.thinking) ?? '';
      if (type === 'tool_use') {
        const name = asString(part.name) ?? 'tool';
        return `${name} ${stringifyCompact(part.input ?? {})}`;
      }
      if (type === 'tool_result') return textFromClaudeContent(part.content);
      return stringifyCompact(part);
    })
    .filter(Boolean)
    .join('\n');
}

function formatClaudeJsonlRecord(raw: string): string[] {
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    return [`[claude:jsonl] ${raw}`];
  }
  if (!isPlainRecord(record)) return [`[claude:jsonl] ${stringifyCompact(record)}`];

  if (record.type === 'queue-operation' && record.operation === 'enqueue') {
    const content = asString(record.content) ?? stringifyCompact(record.content);
    return [`[claude:prompt] ${content}`];
  }

  if (record.type === 'user' && isPlainRecord(record.message)) {
    return [`[claude:user] ${textFromClaudeContent(record.message.content)}`];
  }

  if (record.type === 'assistant' && isPlainRecord(record.message)) {
    const message = record.message;
    const content = Array.isArray(message.content) ? message.content : [];
    const lines: string[] = [];
    for (const part of content) {
      if (!isPlainRecord(part)) {
        lines.push(`[claude:assistant] ${stringifyCompact(part)}`);
        continue;
      }

      if (part.type === 'thinking') {
        lines.push(`[claude:thinking] ${asString(part.thinking) ?? ''}`);
      } else if (part.type === 'text') {
        lines.push(`[claude:assistant] ${asString(part.text) ?? ''}`);
      } else if (part.type === 'tool_use') {
        const name = asString(part.name) ?? 'tool';
        lines.push(`[claude:tool_use] ${name} ${stringifyCompact(part.input ?? {})}`);
      } else {
        lines.push(`[claude:assistant:${String(part.type ?? 'content')}] ${stringifyCompact(part)}`);
      }
    }
    return lines.length > 0 ? lines : [`[claude:assistant] ${stringifyCompact(message)}`];
  }

  if (isPlainRecord(record.toolUseResult)) {
    const stdout = asString(record.toolUseResult.stdout);
    const stderr = asString(record.toolUseResult.stderr);
    const lines: string[] = [];
    if (stdout) lines.push(`[claude:tool_stdout] ${stdout}`);
    if (stderr) lines.push(`[claude:tool_stderr] ${stderr}`);
    if (lines.length > 0) return lines;
  }

  if (record.type === 'last-prompt') {
    return [`[claude:last-prompt] ${asString(record.lastPrompt) ?? ''}`];
  }

  return [`[claude:${String(record.type ?? 'event')}] ${stringifyCompact(record)}`];
}

function findStageSessionDirs(artDir: string, stageName: string): string[] {
  const sessionsDir = path.join(artDir, '.tmp', 'sessions');
  if (!fs.existsSync(sessionsDir)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const suffix = `__pipeline_${stageName}`;
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(suffix))
    .map((entry) => path.join(sessionsDir, entry.name));
}

function listClaudeJsonlFiles(sessionDir: string): string[] {
  const projectsDir = path.join(sessionDir, '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return [];

  const files: string[] = [];
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(fullPath);
    }
  };

  visit(projectsDir);
  return files;
}

function latestMtime(files: string[]): number {
  let latest = 0;
  for (const file of files) {
    try {
      latest = Math.max(latest, fs.statSync(file).mtimeMs);
    } catch {
      // ignore
    }
  }
  return latest;
}

function latestClaudeSessionFiles(sessionDir: string): string[] {
  const files = listClaudeJsonlFiles(sessionDir);
  const mainFiles = files.filter((file) => !file.includes(`${path.sep}subagents${path.sep}`));
  const latestMain = mainFiles
    .map((file) => ({ file, mtimeMs: latestMtime([file]) }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file;

  if (!latestMain) return [];

  const sessionId = path.basename(latestMain, '.jsonl');
  const sessionDirPath = path.join(path.dirname(latestMain), sessionId);
  return [
    latestMain,
    ...files.filter((file) => file.startsWith(`${sessionDirPath}${path.sep}`)),
  ];
}

export function tailStageClaudeTranscriptLines(
  artDir: string,
  stageName: string,
  maxLines: number,
): NodeLogLine[] {
  const sessions = findStageSessionDirs(artDir, stageName)
    .map((dir) => ({ dir, files: latestClaudeSessionFiles(dir) }))
    .filter((session) => session.files.length > 0)
    .map((session) => ({ ...session, mtimeMs: latestMtime(session.files) }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const latestSession = sessions[0];
  if (!latestSession) return [];

  const lines: NodeLogLine[] = [];
  for (const file of latestSession.files.sort()) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const sourceFile = path.basename(file);
    for (const rawLine of raw.split('\n')) {
      if (!rawLine.trim()) continue;
      for (const line of formatClaudeJsonlRecord(rawLine)) {
        lines.push({
          stage: stageName,
          kind: line.startsWith('[claude:tool_stderr]') ? 'stderr' : 'stdout',
          line,
          sourceFile,
        });
      }
    }
  }

  return lines.slice(-maxLines);
}
