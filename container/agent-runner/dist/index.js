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
import { fileURLToPath } from 'url';
import { ClaudeEngine } from './engines/claude-engine.js';
const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
async function readStdin() {
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
function writeOutput(output) {
    console.log(OUTPUT_START_MARKER);
    console.log(JSON.stringify(output));
    console.log(OUTPUT_END_MARKER);
}
function log(message) {
    console.error(`[agent-runner] ${message}`);
}
function getSessionSummary(sessionId, transcriptPath) {
    const projectDir = path.dirname(transcriptPath);
    const indexPath = path.join(projectDir, 'sessions-index.json');
    if (!fs.existsSync(indexPath)) {
        log(`Sessions index not found at ${indexPath}`);
        return null;
    }
    try {
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        const entry = index.entries.find(e => e.sessionId === sessionId);
        if (entry?.summary) {
            return entry.summary;
        }
    }
    catch (err) {
        log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
}
/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName) {
    return async (input, _toolUseId, _context) => {
        const preCompact = input;
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
            const conversationsDir = '/workspace/conversations';
            fs.mkdirSync(conversationsDir, { recursive: true });
            const date = new Date().toISOString().split('T')[0];
            const filename = `${date}-${name}.md`;
            const filePath = path.join(conversationsDir, filename);
            const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
            fs.writeFileSync(filePath, markdown);
            log(`Archived conversation to ${filePath}`);
        }
        catch (err) {
            log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
        }
        return {};
    };
}
function sanitizeFilename(summary) {
    return summary
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50);
}
function generateFallbackName() {
    const time = new Date();
    return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}
function parseTranscript(content) {
    const messages = [];
    for (const line of content.split('\n')) {
        if (!line.trim())
            continue;
        try {
            const entry = JSON.parse(line);
            if (entry.type === 'user' && entry.message?.content) {
                const text = typeof entry.message.content === 'string'
                    ? entry.message.content
                    : entry.message.content.map((c) => c.text || '').join('');
                if (text)
                    messages.push({ role: 'user', content: text });
            }
            else if (entry.type === 'assistant' && entry.message?.content) {
                const textParts = entry.message.content
                    .filter((c) => c.type === 'text')
                    .map((c) => c.text);
                const text = textParts.join('');
                if (text)
                    messages.push({ role: 'assistant', content: text });
            }
        }
        catch {
        }
    }
    return messages;
}
function formatTranscriptMarkdown(messages, title, assistantName) {
    const now = new Date();
    const formatDateTime = (d) => d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    });
    const lines = [];
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
function shouldClose() {
    if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
        try {
            fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
        }
        catch { /* ignore */ }
        return true;
    }
    return false;
}
/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput() {
    try {
        fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
        const files = fs.readdirSync(IPC_INPUT_DIR)
            .filter(f => f.endsWith('.json'))
            .sort();
        const messages = [];
        for (const file of files) {
            const filePath = path.join(IPC_INPUT_DIR, file);
            try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                fs.unlinkSync(filePath);
                if (data.type === 'message' && data.text) {
                    messages.push(data.text);
                }
            }
            catch (err) {
                log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
                try {
                    fs.unlinkSync(filePath);
                }
                catch { /* ignore */ }
            }
        }
        return messages;
    }
    catch (err) {
        log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
        return [];
    }
}
/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage() {
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
 */
async function runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt, endOnResult, ephemeralAppend) {
    const provider = containerInput.provider || 'claude';
    const engine = provider === 'codex'
        ? new (await import('./engines/codex-engine.js')).CodexEngine()
        : new ClaudeEngine();
    let newSessionId;
    let lastAssistantUuid;
    let resultCount = 0;
    const resultTexts = [];
    let closedDuringQuery = false;
    const pendingToolUses = new Map();
    const erroredHashes = new Set();
    const stageName = containerInput.assistantName || 'unknown';
    let eventCount = 0;
    for await (const event of engine.runTurn({
        prompt,
        sessionId,
        mcpServerPath,
        containerInput,
        sdkEnv,
        resumeAt,
        ephemeralAppend,
        onCloseRequested: () => {
            if (shouldClose()) {
                log('Close sentinel detected during query');
                closedDuringQuery = true;
                return true;
            }
            return false;
        },
        pollIpcMessages: () => {
            const messages = drainIpcInput();
            for (const text of messages) {
                log(`Piping IPC message into active ${provider} turn (${text.length} chars)`);
            }
            return messages;
        },
        preCompactHookFactory: createPreCompactHook,
    })) {
        eventCount++;
        log(`[event #${eventCount}] provider=${provider} type=${event.type}`);
        handleNormalizedEvent(event, pendingToolUses, erroredHashes, stageName, resultTexts, endOnResult, (value) => {
            newSessionId = value;
        }, () => newSessionId, (value) => {
            lastAssistantUuid = value;
        }, () => {
            resultCount++;
        });
    }
    log(`Query done. Provider: ${provider}, events: ${eventCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
    return { newSessionId, lastAssistantUuid, closedDuringQuery, resultTexts };
}
// (FSM helpers removed — pipeline FSM is now host-side)
// (Stage prompts and FSM removed — now managed by host-side pipeline-runner.ts)
function handleNormalizedEvent(event, pendingToolUses, erroredHashes, stageName, resultTexts, endOnResult, setSessionId, getSessionId, setLastAssistantUuid, incrementResultCount) {
    switch (event.type) {
        case 'session.started':
            setSessionId(event.sessionId);
            log(`Session initialized: ${event.sessionId}`);
            return;
        case 'assistant.text':
            process.stdout.write(event.text);
            return;
        case 'tool.started':
            pendingToolUses.set(event.id, {
                name: event.name,
                input: event.input,
                assistantText: event.assistantText || '',
            });
            process.stdout.write(TOOL_START_MARKER +
                '\n' +
                JSON.stringify({
                    id: event.id,
                    name: event.name,
                    input_preview: event.preview || event.name,
                }) +
                '\n' +
                TOOL_END_MARKER +
                '\n');
            return;
        case 'tool.result': {
            const pending = pendingToolUses.get(event.id);
            if (pending) {
                const inputHash = computeInputHash(pending.name, pending.input);
                if (event.isError) {
                    erroredHashes.add(inputHash);
                    try {
                        writeIpcTask({
                            type: 'report_issue',
                            stage: stageName,
                            tool: pending.name,
                            toolUseId: event.id,
                            input: JSON.stringify(pending.input).slice(0, 2000),
                            inputHash,
                            errorContent: (event.errorText || '').slice(0, 4000),
                            assistantContext: pending.assistantText,
                        });
                    }
                    catch (err) {
                        log(`Failed to write report_issue IPC: ${err instanceof Error ? err.message : String(err)}`);
                    }
                }
                else if (erroredHashes.has(inputHash)) {
                    try {
                        writeIpcTask({
                            type: 'resolve_issue',
                            stage: stageName,
                            inputHash,
                        });
                    }
                    catch (err) {
                        log(`Failed to write resolve_issue IPC: ${err instanceof Error ? err.message : String(err)}`);
                    }
                }
            }
            pendingToolUses.delete(event.id);
            return;
        }
        case 'assistant.checkpoint':
            setLastAssistantUuid(event.messageId);
            return;
        case 'task.notification':
            log(`Task notification: task=${event.taskId} status=${event.status} summary=${event.summary}`);
            return;
        case 'turn.result':
            incrementResultCount();
            if (event.result)
                resultTexts.push(event.result);
            writeOutput({
                status: 'success',
                result: event.result,
                newSessionId: getSessionId(),
            });
            if (endOnResult) {
                log('endOnResult: turn finished');
            }
            return;
        case 'turn.error':
            throw new Error(event.error);
    }
}
const IPC_TASKS_DIR = '/workspace/ipc/tasks';
function writeIpcTask(data) {
    fs.mkdirSync(IPC_TASKS_DIR, { recursive: true });
    const filename = `${Date.now()}-${data.type}.json`;
    const filepath = path.join(IPC_TASKS_DIR, filename);
    const tmp = filepath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, filepath); // atomic
}
function computeInputHash(tool, input) {
    return crypto
        .createHash('md5')
        .update(tool + ':' + JSON.stringify(input))
        .digest('hex')
        .slice(0, 16);
}
async function main() {
    let containerInput;
    try {
        // File-based input (udocker, or any runtime where stdin is unavailable)
        const inputFilePath = '/workspace/ipc/_initial_input.json';
        let stdinData;
        if (fs.existsSync(inputFilePath)) {
            stdinData = fs.readFileSync(inputFilePath, 'utf-8');
            fs.unlinkSync(inputFilePath); // consume once
            log('Input read from IPC file');
        }
        else {
            stdinData = await readStdin();
            log('Input read from stdin');
        }
        containerInput = JSON.parse(stdinData);
        try {
            fs.unlinkSync('/tmp/input.json');
        }
        catch { /* may not exist */ }
        log(`Received input for group: ${containerInput.groupFolder}`);
    }
    catch (err) {
        writeOutput({
            status: 'error',
            result: null,
            error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
        });
        process.exit(1);
    }
    // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
    // No real secrets exist in the container environment.
    const sdkEnv = { ...process.env };
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
        }
        catch (err) {
            log(`Failed to detect Vivado: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');
    let sessionId = containerInput.sessionId;
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    // Clean up stale _close sentinel from previous container runs
    try {
        fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    }
    catch { /* ignore */ }
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
        if (!msg)
            return;
        prompt = msg;
    }
    // Query loop: run query → wait for IPC message → run new query → repeat
    let resumeAt;
    // One-shot system-prompt append: consumed by the first query only, then cleared
    // so subsequent IPC-driven queries don't re-inject it.
    let pendingEphemeral = containerInput.ephemeralSystemPrompt;
    try {
        while (true) {
            log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'}${pendingEphemeral ? ', ephemeral system prompt attached' : ''})...`);
            const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt, containerInput.endOnFirstResult, pendingEphemeral);
            pendingEphemeral = undefined;
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
    }
    catch (err) {
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
