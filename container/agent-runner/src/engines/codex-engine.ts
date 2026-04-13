import fs from 'fs';
import { Codex } from '@openai/codex-sdk';

import { AgentEngine, NormalizedEvent, RunTurnInput } from './types.js';

function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) cleaned[key] = value;
  }
  return cleaned;
}

function buildPrompt(basePrompt: string, ephemeralAppend?: string): string {
  const globalDocPathCandidates = [
    '/workspace/global/AGENTS.md',
    '/workspace/global/CLAUDE.md',
  ];
  let globalDoc = '';
  for (const candidate of globalDocPathCandidates) {
    if (fs.existsSync(candidate)) {
      globalDoc = fs.readFileSync(candidate, 'utf-8');
      break;
    }
  }

  const contextBlocks = [globalDoc, ephemeralAppend].filter(Boolean);
  if (contextBlocks.length === 0) return basePrompt;
  return [
    'The following context is system-level guidance for this turn. Treat it as higher priority than the user request.',
    '',
    '<system_context>',
    contextBlocks.join('\n\n'),
    '</system_context>',
    '',
    basePrompt,
  ].join('\n');
}

function collectExtraDirs(): string[] {
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (!fs.existsSync(extraBase)) return extraDirs;
  for (const entry of fs.readdirSync(extraBase)) {
    const fullPath = `${extraBase}/${entry}`;
    if (fs.statSync(fullPath).isDirectory()) {
      extraDirs.push(fullPath);
    }
  }
  return extraDirs;
}

export class CodexEngine implements AgentEngine {
  async *runTurn(input: RunTurnInput): AsyncGenerator<NormalizedEvent> {
    const codex = new Codex({
      baseUrl: input.sdkEnv.OPENAI_BASE_URL,
      env: cleanEnv(input.sdkEnv),
    });

    const threadOptions = {
      workingDirectory: '/workspace',
      additionalDirectories: collectExtraDirs(),
      sandboxMode: 'danger-full-access' as const,
      approvalPolicy: 'never' as const,
      skipGitRepoCheck: true,
      networkAccessEnabled: true,
    };
    const thread = input.sessionId
      ? codex.resumeThread(input.sessionId, threadOptions)
      : codex.startThread(threadOptions);
    const prompt = buildPrompt(input.prompt, input.ephemeralAppend);
    const { events } = await thread.runStreamed(prompt);

    let finalResponse: string | null = null;
    let lastMessageId: string | undefined;

    for await (const event of events) {
      if (event.type === 'thread.started') {
        yield { type: 'session.started', sessionId: event.thread_id };
        continue;
      }

      if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
        const { item } = event;
        if (item.type === 'agent_message') {
          finalResponse = item.text;
          lastMessageId = item.id;
          if (event.type === 'item.completed') {
            yield { type: 'assistant.text', text: item.text };
            yield { type: 'assistant.checkpoint', messageId: item.id };
          }
          continue;
        }

        if (item.type === 'command_execution') {
          if (event.type === 'item.started') {
            yield {
              type: 'tool.started',
              id: item.id,
              name: 'Bash',
              preview: item.command,
              input: { command: item.command },
            };
          } else if (event.type === 'item.completed') {
            yield {
              type: 'tool.result',
              id: item.id,
              isError: item.status === 'failed',
              errorText:
                item.status === 'failed'
                  ? item.aggregated_output.slice(-4000)
                  : undefined,
            };
          }
          continue;
        }

        if (item.type === 'mcp_tool_call') {
          if (event.type === 'item.started') {
            yield {
              type: 'tool.started',
              id: item.id,
              name: `${item.server}__${item.tool}`,
              preview: `${item.server}/${item.tool}`,
              input: item.arguments,
            };
          } else if (event.type === 'item.completed') {
            yield {
              type: 'tool.result',
              id: item.id,
              isError: item.status === 'failed',
              errorText: item.error?.message,
            };
          }
        }
      } else if (event.type === 'turn.completed') {
        yield { type: 'assistant.checkpoint', messageId: lastMessageId };
        yield { type: 'turn.result', result: finalResponse };
      } else if (event.type === 'turn.failed') {
        yield { type: 'turn.error', error: event.error.message };
      } else if (event.type === 'error') {
        yield { type: 'turn.error', error: event.message };
      }
    }
  }
}
