import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
export function getPromptDbPath() {
    const configured = process.env.ART_PROMPT_DB_PATH?.trim();
    if (configured)
        return path.resolve(configured);
    return path.join(os.homedir(), '.config', 'aer-art', 'prompt-db.json');
}
function loadPromptDbFile(dbPath = getPromptDbPath()) {
    if (!fs.existsSync(dbPath)) {
        throw new Error(`Prompt DB not found at ${dbPath}. Set ART_PROMPT_DB_PATH or create the file first.`);
    }
    const raw = fs.readFileSync(dbPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.prompts)) {
        throw new Error(`Prompt DB at ${dbPath} must contain a "prompts" array.`);
    }
    for (const prompt of parsed.prompts) {
        if (!prompt ||
            typeof prompt.id !== 'string' ||
            typeof prompt.content !== 'string') {
            throw new Error(`Prompt DB at ${dbPath} contains an invalid prompt entry.`);
        }
    }
    return { prompts: parsed.prompts };
}
export function listPrompts(dbPath = getPromptDbPath()) {
    return loadPromptDbFile(dbPath).prompts;
}
export function getPromptById(id, dbPath = getPromptDbPath()) {
    return listPrompts(dbPath).find((prompt) => prompt.id === id) ?? null;
}
export function queryPrompts(query, dbPath = getPromptDbPath()) {
    const needle = query.trim().toLowerCase();
    if (!needle)
        return listPrompts(dbPath);
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
export function resolvePromptIds(ids, dbPath = getPromptDbPath()) {
    const prompts = listPrompts(dbPath);
    return ids.map((id) => {
        const match = prompts.find((prompt) => prompt.id === id);
        if (!match) {
            throw new Error(`Prompt "${id}" not found in DB ${dbPath}.`);
        }
        return match;
    });
}
export function resolveStagePrompt(stage, dbPath = getPromptDbPath()) {
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
export function promptPreview(record, maxLen = 100) {
    const singleLine = record.content.replace(/\s+/g, ' ').trim();
    if (singleLine.length <= maxLen)
        return singleLine;
    return `${singleLine.slice(0, maxLen - 3)}...`;
}
//# sourceMappingURL=prompt-store.js.map