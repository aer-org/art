import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPromptById, getPromptDbPath, listPrompts, queryPrompts, resolvePromptIds, resolveStagePrompt, } from './prompt-store.js';
describe('prompt-store', () => {
    let tmpDir;
    let dbPath;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-prompts-'));
        dbPath = path.join(tmpDir, 'prompt-db.json');
        process.env.ART_PROMPT_DB_PATH = dbPath;
        fs.writeFileSync(dbPath, JSON.stringify({
            prompts: [
                {
                    id: 'db_id_1',
                    title: 'Planner Core',
                    content: 'You are the planning core.',
                    updated_at: '2026-04-14T00:00:00Z',
                    tags: ['planner', 'core'],
                },
                {
                    id: 'db_id_2',
                    title: 'Cookbook Rules',
                    content: 'Read the cookbook before acting.',
                    tags: ['cookbook'],
                },
            ],
        }, null, 2));
    });
    afterEach(() => {
        delete process.env.ART_PROMPT_DB_PATH;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    it('uses ART_PROMPT_DB_PATH when set', () => {
        expect(getPromptDbPath()).toBe(dbPath);
    });
    it('lists prompts from the DB', () => {
        expect(listPrompts()).toHaveLength(2);
    });
    it('gets prompt by id', () => {
        expect(getPromptById('db_id_1')?.title).toBe('Planner Core');
        expect(getPromptById('missing')).toBeNull();
    });
    it('queries prompts by title and content', () => {
        expect(queryPrompts('planner')).toHaveLength(1);
        expect(queryPrompts('cookbook')).toHaveLength(1);
    });
    it('resolves prompt ids in order', () => {
        const resolved = resolvePromptIds(['db_id_2', 'db_id_1']);
        expect(resolved.map((prompt) => prompt.id)).toEqual(['db_id_2', 'db_id_1']);
    });
    it('composes stage prompts from DB ids and prompt_append', () => {
        const resolved = resolveStagePrompt({
            prompts: ['db_id_1', 'db_id_2'],
            prompt_append: 'Target module is fixed to VPU.',
        });
        expect(resolved.promptIds).toEqual(['db_id_1', 'db_id_2']);
        expect(resolved.text).toContain('You are the planning core.');
        expect(resolved.text).toContain('Read the cookbook before acting.');
        expect(resolved.text).toContain('Target module is fixed to VPU.');
        expect(resolved.promptHash).toBeTruthy();
    });
    it('falls back to legacy prompt when prompts is absent', () => {
        const resolved = resolveStagePrompt({
            prompt: 'Legacy prompt body',
            prompt_append: 'Extra',
        });
        expect(resolved.promptIds).toEqual([]);
        expect(resolved.promptHash).toBeNull();
        expect(resolved.text).toBe('Legacy prompt body\n\nExtra');
    });
});
//# sourceMappingURL=prompt-store.test.js.map