import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'fs';
import path from 'path';

import { AgentEngine, NormalizedEvent, RunTurnInput } from './types.js';

function summarizeToolInput(name: string, input: any): string {
  if (!input) return name;
  switch (name) {
    case 'Bash':
      return typeof input.command === 'string' ? input.command.slice(0, 80) : name;
    case 'Read':
    case 'Write':
    case 'Edit':
      return typeof input.file_path === 'string' ? input.file_path : name;
    case 'Grep':
    case 'Glob':
      return typeof input.pattern === 'string' ? input.pattern : name;
    default:
      return name;
  }
}

class MessageStream {
  private queue: Array<{
    type: 'user';
    message: { role: 'user'; content: string };
    parent_tool_use_id: null;
    session_id: string;
  }> = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<{
    type: 'user';
    message: { role: 'user'; content: string };
    parent_tool_use_id: null;
    session_id: string;
  }> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
      this.waiting = null;
    }
  }
}

export class ClaudeEngine implements AgentEngine {
  async *runTurn(input: RunTurnInput): AsyncGenerator<NormalizedEvent> {
    const stream = new MessageStream();
    stream.push(input.prompt);

    let ipcPolling = true;
    let closedDuringQuery = false;
    const pollIpcDuringQuery = () => {
      if (!ipcPolling) return;
      if (input.onCloseRequested()) {
        closedDuringQuery = true;
        stream.end();
        ipcPolling = false;
        return;
      }
      const messages = input.pollIpcMessages?.() || [];
      for (const text of messages) {
        stream.push(text);
      }
      setTimeout(pollIpcDuringQuery, 500);
    };
    setTimeout(pollIpcDuringQuery, 500);

    const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
    let globalClaudeMd: string | undefined;
    if (!input.containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
      globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
    }

    const extraDirs: string[] = [];
    const extraBase = '/workspace/extra';
    if (fs.existsSync(extraBase)) {
      for (const entry of fs.readdirSync(extraBase)) {
        const fullPath = path.join(extraBase, entry);
        if (fs.statSync(fullPath).isDirectory()) {
          extraDirs.push(fullPath);
        }
      }
    }

    for await (const message of query({
      prompt: stream,
      options: {
        cwd: '/workspace',
        additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
        resume: input.sessionId,
        resumeSessionAt: input.resumeAt,
        systemPrompt: (() => {
          const appendParts = [globalClaudeMd, input.ephemeralAppend].filter(Boolean) as string[];
          if (appendParts.length === 0) return undefined;
          return {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: appendParts.join('\n\n'),
          };
        })(),
        allowedTools: [
          'Bash',
          'Read', 'Write', 'Edit', 'Glob', 'Grep',
          'WebSearch', 'WebFetch',
          'Task', 'TaskOutput', 'TaskStop',
          'TeamCreate', 'TeamDelete', 'SendMessage',
          'TodoWrite', 'ToolSearch', 'Skill',
          'NotebookEdit',
          'mcp__aer-art__*',
        ],
        env: input.sdkEnv,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: {
          'aer-art': {
            command: 'node',
            args: [input.mcpServerPath],
          },
        },
        hooks: input.preCompactHookFactory
          ? {
              PreCompact: [
                { hooks: [input.preCompactHookFactory(input.containerInput.assistantName)] },
              ],
            }
          : {},
      },
    })) {
      if (message.type === 'assistant' && 'message' in message) {
        const msg = (message as any).message;
        if (msg?.content && Array.isArray(msg.content)) {
          const textParts = msg.content
            .filter((part: any) => part.type === 'text' && part.text)
            .map((part: any) => part.text as string);
          const assistantText = textParts.join('\n').slice(0, 1000);

          for (const part of msg.content) {
            if (part.type === 'text' && part.text) {
              yield { type: 'assistant.text', text: part.text };
            } else if (part.type === 'tool_use') {
              yield {
                type: 'tool.started',
                id: part.id,
                name: part.name,
                preview: summarizeToolInput(part.name, part.input),
                input: part.input,
                assistantText,
              };
            }
          }
        }
      }

      if (message.type === 'user' && 'message' in message) {
        const msg = (message as any).message;
        if (msg?.content && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              let errorText = '';
              if (block.is_error) {
                if (typeof block.content === 'string') {
                  errorText = block.content;
                } else if (Array.isArray(block.content)) {
                  errorText = block.content.map((c: any) => c.text || '').join('');
                }
              }
              yield {
                type: 'tool.result',
                id: block.tool_use_id,
                isError: !!block.is_error,
                errorText: errorText || undefined,
              };
            }
          }
        }
      }

      if (message.type === 'assistant' && 'uuid' in message) {
        yield {
          type: 'assistant.checkpoint',
          messageId: (message as { uuid: string }).uuid,
        };
      }

      if (message.type === 'system' && message.subtype === 'init') {
        yield { type: 'session.started', sessionId: message.session_id };
      }

      if (
        message.type === 'system' &&
        (message as { subtype?: string }).subtype === 'task_notification'
      ) {
        const task = message as { task_id: string; status: string; summary: string };
        yield {
          type: 'task.notification',
          taskId: task.task_id,
          status: task.status,
          summary: task.summary,
        };
      }

      if (message.type === 'result') {
        const textResult = 'result' in message ? (message as { result?: string }).result : null;
        yield { type: 'turn.result', result: textResult || null };
      }
    }
    ipcPolling = false;
  }
}
