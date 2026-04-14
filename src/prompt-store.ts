import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface PromptRecord {
  id: string;
  title?: string;
  content: string;
  updated_at?: string;
  tags?: string[];
}

interface PromptDbFile {
  prompts: PromptRecord[];
}

export interface StagePromptSource {
  prompt?: string;
  prompts?: string[];
  prompt_append?: string;
}

export interface ResolvedStagePrompt {
  text: string;
  promptIds: string[];
  promptHash: string | null;
}

export function getPromptDbPath(): string {
  const configured = process.env.ART_PROMPT_DB_PATH?.trim();
  if (configured) return path.resolve(configured);
  return path.join(os.homedir(), '.config', 'aer-art', 'prompt-db.json');
}

function loadPromptDbFile(dbPath = getPromptDbPath()): PromptDbFile {
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `Prompt DB not found at ${dbPath}. Set ART_PROMPT_DB_PATH or create the file first.`,
    );
  }

  const raw = fs.readFileSync(dbPath, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<PromptDbFile>;
  if (!Array.isArray(parsed.prompts)) {
    throw new Error(`Prompt DB at ${dbPath} must contain a "prompts" array.`);
  }

  for (const prompt of parsed.prompts) {
    if (
      !prompt ||
      typeof prompt.id !== 'string' ||
      typeof prompt.content !== 'string'
    ) {
      throw new Error(
        `Prompt DB at ${dbPath} contains an invalid prompt entry.`,
      );
    }
  }

  return { prompts: parsed.prompts as PromptRecord[] };
}

export function listPrompts(dbPath = getPromptDbPath()): PromptRecord[] {
  return loadPromptDbFile(dbPath).prompts;
}

export function getPromptById(
  id: string,
  dbPath = getPromptDbPath(),
): PromptRecord | null {
  return listPrompts(dbPath).find((prompt) => prompt.id === id) ?? null;
}

export function queryPrompts(
  query: string,
  dbPath = getPromptDbPath(),
): PromptRecord[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return listPrompts(dbPath);

  return listPrompts(dbPath).filter((prompt) => {
    const haystacks = [
      prompt.id,
      prompt.title ?? '',
      prompt.content,
      ...(prompt.tags ?? []),
    ];
    return haystacks.some((value) => value.toLowerCase().includes(needle));
  });
}

export function resolvePromptIds(
  ids: string[],
  dbPath = getPromptDbPath(),
): PromptRecord[] {
  const prompts = listPrompts(dbPath);
  return ids.map((id) => {
    const match = prompts.find((prompt) => prompt.id === id);
    if (!match) {
      throw new Error(`Prompt "${id}" not found in DB ${dbPath}.`);
    }
    return match;
  });
}

export function resolveStagePrompt(
  stage: StagePromptSource,
  dbPath = getPromptDbPath(),
): ResolvedStagePrompt {
  const ids = stage.prompts ?? [];

  if (ids.length === 0) {
    return {
      text: [stage.prompt ?? '', stage.prompt_append ?? '']
        .filter((part) => part.trim().length > 0)
        .join('\n\n'),
      promptIds: [],
      promptHash: null,
    };
  }

  const records = resolvePromptIds(ids, dbPath);
  const parts = records.map((record) => record.content);
  if (stage.prompt_append?.trim()) {
    parts.push(stage.prompt_append);
  }

  const text = parts.join('\n\n');
  return {
    text,
    promptIds: ids,
    promptHash: crypto.createHash('sha256').update(text).digest('hex'),
  };
}

export function promptPreview(record: PromptRecord, maxLen = 100): string {
  const singleLine = record.content.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxLen) return singleLine;
  return `${singleLine.slice(0, maxLen - 3)}...`;
}
