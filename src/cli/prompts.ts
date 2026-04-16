import fs from 'fs';
import path from 'path';

import {
  getPromptById,
  getPromptDbPath,
  listPrompts,
  promptPreview,
  queryPrompts,
  resolvePromptIds,
} from '../prompt-store.js';

interface PipelineStageLike {
  name: string;
  prompts?: string[];
  prompt_append?: string;
}

interface PipelineConfigLike {
  stages?: PipelineStageLike[];
}

function readPipelineFile(inputPath?: string): {
  path: string;
  config: PipelineConfigLike;
} {
  const requested = inputPath ? path.resolve(inputPath) : process.cwd();
  const stats = fs.existsSync(requested) ? fs.statSync(requested) : null;
  const pipelinePath =
    stats?.isDirectory() || !stats
      ? path.join(requested, '__art__', 'PIPELINE.json')
      : requested;

  if (!fs.existsSync(pipelinePath)) {
    throw new Error(`PIPELINE.json not found at ${pipelinePath}`);
  }

  const config = JSON.parse(
    fs.readFileSync(pipelinePath, 'utf-8'),
  ) as PipelineConfigLike;
  if (!Array.isArray(config.stages)) {
    throw new Error(`Invalid PIPELINE.json at ${pipelinePath}`);
  }
  return { path: pipelinePath, config };
}

export async function promptsCli(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  const dbPath = getPromptDbPath();

  switch (subcommand) {
    case 'list': {
      const prompts = listPrompts(dbPath);
      if (prompts.length === 0) {
        console.log(`No prompts found in ${dbPath}`);
        return;
      }
      for (const prompt of prompts) {
        const title = prompt.title ? ` | ${prompt.title}` : '';
        const updated = prompt.updated_at ? ` | ${prompt.updated_at}` : '';
        console.log(`${prompt.id}${title}${updated}`);
      }
      return;
    }
    case 'get': {
      const id = rest[0];
      if (!id) throw new Error('Usage: art prompts get <db_id>');
      const prompt = getPromptById(id, dbPath);
      if (!prompt) throw new Error(`Prompt "${id}" not found in ${dbPath}`);

      console.log(`id: ${prompt.id}`);
      if (prompt.title) console.log(`title: ${prompt.title}`);
      if (prompt.updated_at) console.log(`updated_at: ${prompt.updated_at}`);
      if (prompt.tags?.length) console.log(`tags: ${prompt.tags.join(', ')}`);
      console.log('');
      console.log(prompt.content);
      return;
    }
    case 'query': {
      const term = rest.join(' ').trim();
      if (!term) throw new Error('Usage: art prompts query <text>');
      const prompts = queryPrompts(term, dbPath);
      if (prompts.length === 0) {
        console.log(`No prompts matched "${term}" in ${dbPath}`);
        return;
      }
      for (const prompt of prompts) {
        const title = prompt.title ?? '(untitled)';
        console.log(`${prompt.id} | ${title}`);
        console.log(`  ${promptPreview(prompt)}`);
      }
      return;
    }
    case 'pipeline': {
      const { path: pipelinePath, config } = readPipelineFile(rest[0]);
      console.log(`pipeline: ${pipelinePath}`);
      console.log(`prompt_db: ${dbPath}`);
      console.log('');

      for (const stage of config.stages ?? []) {
        console.log(`[${stage.name}]`);
        const ids = stage.prompts ?? [];
        if (ids.length === 0) {
          console.log('  prompts: (none)');
        } else {
          const prompts = resolvePromptIds(ids, dbPath);
          for (const prompt of prompts) {
            const title = prompt.title ?? '(untitled)';
            console.log(`  ${prompt.id} | ${title}`);
          }
        }
        if (stage.prompt_append?.trim()) {
          console.log(`  append: ${stage.prompt_append}`);
        }
        console.log('');
      }
      return;
    }
    default:
      console.log(`Usage:
  art prompts list
  art prompts get <db_id>
  art prompts query <text>
  art prompts pipeline [project-dir|PIPELINE.json]`);
  }
}
