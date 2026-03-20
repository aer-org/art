/**
 * AerArt Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  endOnFirstResult?: boolean;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
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

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---AER_ART_OUTPUT_START---';
const OUTPUT_END_MARKER = '---AER_ART_OUTPUT_END---';
const TOOL_START_MARKER = '---AER_ART_TOOL_START---';
const TOOL_END_MARKER = '---AER_ART_TOOL_END---';

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
      return typeof input.pattern === 'string' ? input.pattern : name;
    case 'Glob':
      return typeof input.pattern === 'string' ? input.pattern : name;
    default:
      return name;
  }
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
  endOnResult?: boolean,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean; resultTexts: string[] }> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  const resultTexts: string[] = [];

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
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
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  // Issue tracking: map tool_use IDs to their metadata, track errored input hashes
  const pendingToolUses = new Map<string, { name: string; input: unknown; assistantText: string }>();
  const erroredHashes = new Set<string>();
  const stageName = containerInput.assistantName || 'unknown';

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
        : undefined,
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'mcp__aer-art__*'
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        'aer-art': {
          command: 'node',
          args: [mcpServerPath],
          env: {
            AER_ART_CHAT_JID: containerInput.chatJid,
            AER_ART_GROUP_FOLDER: containerInput.groupFolder,
            AER_ART_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
      },
    }
  })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;

    // Detailed logging for debugging
    let detail = '';
    if (message.type === 'assistant' && 'message' in message) {
      const msg = (message as any).message;
      if (msg?.content) {
        const parts = Array.isArray(msg.content) ? msg.content : [msg.content];
        const summary = parts.map((p: any) => {
          if (p.type === 'tool_use') {
            const input = p.input ? JSON.stringify(p.input).slice(0, 150) : '';
            return `tool_use:${p.name}(${input})`;
          }
          if (p.type === 'text' && p.text) return `text:${p.text.slice(0, 80)}`;
          return p.type || '?';
        }).join(', ');
        detail = ` [${summary}]`;
      }
    }
    if (message.type === 'user' && 'message' in message) {
      const msg = (message as any).message;
      if (msg?.content) {
        const parts = Array.isArray(msg.content) ? msg.content : [msg.content];
        const summary = parts.map((p: any) => {
          if (p.type === 'tool_result') {
            const content = Array.isArray(p.content) ? p.content.map((c: any) => c.text || '').join('') : (p.content || '');
            const preview = typeof content === 'string' ? content.slice(0, 200) : JSON.stringify(content).slice(0, 200);
            return `tool_result(${p.tool_use_id?.slice(-8) || '?'}):${preview}`;
          }
          if (p.type === 'text' && p.text) return `text:${p.text.slice(0, 80)}`;
          return p.type || '?';
        }).join(', ');
        detail = ` [${summary}]`;
      }
    }
    log(`[msg #${messageCount}] type=${msgType}${detail}`);

    // Stream assistant text and tool_use info to stdout so compose.ts relays as SSE.
    if (message.type === 'assistant' && 'message' in message) {
      const msg = (message as any).message;
      if (msg?.content) {
        const parts = Array.isArray(msg.content) ? msg.content : [msg.content];
        for (const p of parts) {
          if (p.type === 'text' && p.text) {
            process.stdout.write(p.text);
          } else if (p.type === 'tool_use') {
            const info = { id: p.id, name: p.name, input_preview: summarizeToolInput(p.name, p.input) };
            process.stdout.write(TOOL_START_MARKER + '\n' + JSON.stringify(info) + '\n' + TOOL_END_MARKER + '\n');
          }
        }
      }
    }

    // --- Issue tracking: capture tool_use from assistant, detect errors from tool_result ---
    if (message.type === 'assistant' && 'message' in message) {
      const msg = (message as any).message;
      if (msg?.content && Array.isArray(msg.content)) {
        // Collect text blocks for assistantContext
        const textParts = msg.content
          .filter((p: any) => p.type === 'text' && p.text)
          .map((p: any) => p.text as string);
        const assistantText = textParts.join('\n').slice(0, 1000);

        // Record pending tool_use blocks
        for (const block of msg.content) {
          if (block.type === 'tool_use' && block.id && block.name) {
            pendingToolUses.set(block.id, {
              name: block.name,
              input: block.input,
              assistantText,
            });
          }
        }
      }
    }

    if (message.type === 'user' && 'message' in message) {
      const msg = (message as any).message;
      if (msg?.content && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type !== 'tool_result' || !block.tool_use_id) continue;

          const pending = pendingToolUses.get(block.tool_use_id);
          if (!pending) continue;

          const inputHash = computeInputHash(pending.name, pending.input);

          if (block.is_error) {
            // Extract error content from tool_result
            let errorContent = '';
            if (typeof block.content === 'string') {
              errorContent = block.content;
            } else if (Array.isArray(block.content)) {
              errorContent = block.content.map((c: any) => c.text || '').join('');
            }
            errorContent = errorContent.slice(0, 4000);

            erroredHashes.add(inputHash);

            try {
              writeIpcTask({
                type: 'report_issue',
                stage: stageName,
                tool: pending.name,
                toolUseId: block.tool_use_id,
                input: JSON.stringify(pending.input).slice(0, 2000),
                inputHash,
                errorContent,
                assistantContext: pending.assistantText,
                turnIndex: messageCount,
              });
            } catch (err) {
              log(`Failed to write report_issue IPC: ${err instanceof Error ? err.message : String(err)}`);
            }
          } else if (erroredHashes.has(inputHash)) {
            // Previously errored command now succeeded → resolve
            try {
              writeIpcTask({
                type: 'resolve_issue',
                stage: stageName,
                inputHash,
              });
            } catch (err) {
              log(`Failed to write resolve_issue IPC: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          // Clean up processed tool_use
          pendingToolUses.delete(block.tool_use_id);
        }
      }
    }

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      if (textResult) resultTexts.push(textResult);
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId
      });
      if (endOnResult) {
        log('endOnResult: closing stream after result');
        stream.end();
        ipcPolling = false;
      }
    }
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery, resultTexts };
}

// (FSM helpers removed — pipeline FSM is now host-side)

// (Stage prompts and FSM removed — now managed by host-side pipeline-runner.ts)

const IPC_TASKS_DIR = '/workspace/ipc/tasks';

function writeIpcTask(data: Record<string, unknown>): void {
  fs.mkdirSync(IPC_TASKS_DIR, { recursive: true });
  const filename = `${Date.now()}-${data.type}.json`;
  const filepath = path.join(IPC_TASKS_DIR, filename);
  const tmp = filepath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, filepath);  // atomic
}

function computeInputHash(tool: string, input: unknown): string {
  return crypto
    .createHash('md5')
    .update(tool + ':' + JSON.stringify(input))
    .digest('hex')
    .slice(0, 16);
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    // File-based input (udocker, or any runtime where stdin is unavailable)
    const inputFilePath = '/workspace/ipc/_initial_input.json';
    let stdinData: string;
    if (fs.existsSync(inputFilePath)) {
      stdinData = fs.readFileSync(inputFilePath, 'utf-8');
      fs.unlinkSync(inputFilePath); // consume once
      log('Input read from IPC file');
    } else {
      stdinData = await readStdin();
      log('Input read from stdin');
    }
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  // Auto-detect Xilinx/Vivado and add to PATH
  const xilinxBase = '/workspace/extra/Xilinx';
  if (fs.existsSync(xilinxBase)) {
    try {
      const versions = fs.readdirSync(xilinxBase).filter(v => /^\d/.test(v)).sort().reverse();
      if (versions.length > 0) {
        const ver = versions[0];
        const vivadoBin = path.join(xilinxBase, ver, 'Vivado', 'bin');
        if (fs.existsSync(vivadoBin)) {
          sdkEnv.PATH = `${vivadoBin}:${sdkEnv.PATH || ''}`;
          sdkEnv.XILINX_VIVADO = path.join(xilinxBase, ver, 'Vivado');
          // xelab linker needs multiarch lib path for crt1.o/crti.o
          sdkEnv.LIBRARY_PATH = `/usr/lib/x86_64-linux-gnu:${sdkEnv.LIBRARY_PATH || ''}`;
          log(`Vivado ${ver} added to PATH: ${vivadoBin}`);
        }
      }
    } catch (err) {
      log(`Failed to detect Vivado: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Resume mode: if prompt is empty and we have a session, skip initial query
  if (!prompt.trim() && sessionId) {
    log(`Resuming session ${sessionId}, waiting for IPC message...`);
    writeOutput({ status: 'success', result: null, newSessionId: sessionId });
    const msg = await waitForIpcMessage();
    if (!msg) return;
    prompt = msg;
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerPath,
        containerInput,
        sdkEnv,
        resumeAt,
        containerInput.endOnFirstResult,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // One-shot mode (used by pipeline debug sessions): stop after the
      // first result instead of entering the long-lived IPC wait loop.
      if (containerInput.endOnFirstResult) {
        log('One-shot mode complete, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
