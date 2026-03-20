import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { ART_DIR_NAME } from '../config.js';
import { loadImageRegistry, saveImageRegistry } from '../image-registry.js';
import { readCurrentRun, removeCurrentRun, listRunManifests, readRunManifest, isPidAlive, } from '../pipeline-runner.js';
import { STAGE_TEMPLATES } from '../stage-templates.js';
import { ensureAuth } from './auth.js';
import { setupEngine } from './engine-setup.js';
const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
};
// Sentinel markers (must match container agent-runner)
const OUTPUT_START_MARKER = '---AER_ART_OUTPUT_START---';
const OUTPUT_END_MARKER = '---AER_ART_OUTPUT_END---';
const TOOL_START_MARKER = '---AER_ART_TOOL_START---';
const TOOL_END_MARKER = '---AER_ART_TOOL_END---';
function readBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
        });
        req.on('end', () => resolve(body));
    });
}
/** SSE helpers */
function sseHeaders(res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
}
function sseWrite(res, event) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
}
export async function startEditorServer(artDir, mode, projectDir) {
    const pipelineFile = path.join(artDir, 'PIPELINE.json');
    const resolvedProjectDir = projectDir ?? path.dirname(artDir);
    // Resolve the team-editor/dist directory relative to this package
    const thisFile = fileURLToPath(import.meta.url);
    const packageRoot = path.resolve(path.dirname(thisFile), '..', '..');
    const distDir = path.join(packageRoot, 'team-editor', 'dist');
    if (!fs.existsSync(path.join(distDir, 'index.html'))) {
        console.error('team-editor/dist/ not found. Ensure the package is installed correctly.');
        process.exit(1);
    }
    // ── Agent lifecycle state ──
    let agentProcess = null;
    let agentContainerName = '';
    let agentRunning = false;
    let ipcInputDir = '';
    let parseBuffer = '';
    // SSE clients waiting for agent output
    const sseClients = new Set();
    // ── Session & chat history state ──
    let savedSessionId;
    const chatHistory = [];
    let lastSegmentIsText = false;
    /** Mark all running tool segments as done */
    function markRunningToolsDone() {
        for (const seg of chatHistory) {
            if (seg.type === 'tool' && seg.tool.status === 'running') {
                seg.tool.status = 'done';
            }
        }
    }
    // ── Run lifecycle state ──
    let runProcess = null;
    const runSseClients = new Set();
    // Spawn the container agent
    async function spawnAgent() {
        // Dynamic imports to access engine modules (must be after setupEngine)
        const { DATA_DIR } = await import('../config.js');
        const { runContainerAgent } = await import('../container-runner.js');
        const { getImageForStage } = await import('../image-registry.js');
        const folderName = `art-${path.basename(resolvedProjectDir).replace(/[^A-Za-z0-9_-]/g, '-')}`;
        ipcInputDir = path.join(DATA_DIR, 'ipc', folderName, 'input');
        fs.mkdirSync(ipcInputDir, { recursive: true });
        // Empty dir used as shadow mount to hide __art__/ inside the container
        const emptyDir = path.join(DATA_DIR, 'empty');
        fs.mkdirSync(emptyDir, { recursive: true });
        // Build the initial prompt based on mode
        const prompt = mode === 'init'
            ? `You are an expert software architect. Explore the project at /workspace/project/ (read-only).

Write your analysis to /workspace/group/plan/ANALYSIS.md with sections:
1. Project purpose and type
2. Tech stack and dependencies
3. Architecture overview
4. Code quality observations
5. Areas for improvement

Then write /workspace/group/plan/PLAN.md with:
1. Recommended improvement direction
2. Specific first tasks
3. Success metrics

After writing both files, summarize your findings in 2-3 sentences. The user can then discuss and ask you to modify either file. Continue the conversation — do not exit until the user is done.

Use Korean if the project contains Korean documentation, otherwise use English. You can mix both naturally.`
            : `You are an expert software architect. The project is mounted at /workspace/project/ (read-only).

The current plan is at /workspace/group/plan/PLAN.md (if it exists).
The user wants to discuss and modify the plan. Help them refine it.

When the user asks for changes, update /workspace/group/plan/PLAN.md accordingly.
Continue the conversation until the user is done.

Use Korean if the project contains Korean documentation, otherwise use English.`;
        // Mount project dir as read-only, only plan/ is writable.
        // __art__/ itself is NOT exposed to the container.
        const planDir = path.join(artDir, 'plan');
        fs.mkdirSync(planDir, { recursive: true });
        const group = {
            name: 'art',
            folder: folderName,
            trigger: '',
            added_at: new Date().toISOString(),
            requiresTrigger: false,
            isMain: false,
            containerConfig: {
                image: getImageForStage(),
                groupReadonly: true,
                internalMounts: [
                    {
                        hostPath: resolvedProjectDir,
                        containerPath: '/workspace/project',
                        readonly: true,
                    },
                    {
                        hostPath: emptyDir,
                        containerPath: `/workspace/project/${ART_DIR_NAME}`,
                        readonly: true,
                    },
                    {
                        hostPath: planDir,
                        containerPath: '/workspace/group/plan',
                        readonly: false,
                    },
                ],
            },
        };
        const input = {
            prompt,
            groupFolder: folderName,
            chatJid: `art://${resolvedProjectDir}`,
            isMain: false,
            endOnFirstResult: false, // keep alive for conversation
            sessionId: savedSessionId,
        };
        agentRunning = true;
        parseBuffer = '';
        lastSegmentIsText = false;
        // Start the credential proxy for container auth
        const { startCredentialProxy } = await import('../credential-proxy.js');
        const { setCredentialProxyPort } = await import('../config.js');
        try {
            const { port: actualPort } = await startCredentialProxy(0, '0.0.0.0');
            setCredentialProxyPort(actualPort);
        }
        catch {
            // May already be running if reused
        }
        // Fire and forget — the container runs in the background
        runContainerAgent(group, input, (proc, containerName) => {
            agentProcess = proc;
            agentContainerName = containerName;
            // Parse stdout for output markers and relay to SSE clients
            proc.stdout?.on('data', (data) => {
                const chunk = data.toString();
                relayAgentOutput(chunk);
            });
            proc.stderr?.on('data', (data) => {
                // Log stderr for debugging
                const lines = data.toString().trim().split('\n');
                for (const line of lines) {
                    if (line)
                        console.error(`[agent] ${line}`);
                }
            });
            proc.on('close', () => {
                agentRunning = false;
                agentProcess = null;
                agentContainerName = '';
                markRunningToolsDone();
                // Notify all SSE clients that agent has stopped
                for (const client of sseClients) {
                    sseWrite(client, { type: 'agent_stopped' });
                }
                // Don't close/clear SSE clients — they may reconnect for history
            });
        }, 
        // onOutput callback for streaming results
        async (output) => {
            if (output.newSessionId) {
                savedSessionId = output.newSessionId;
            }
            if (output.result) {
                markRunningToolsDone();
                lastSegmentIsText = false;
                for (const client of sseClients) {
                    sseWrite(client, { type: 'result', content: output.result });
                }
            }
        }).catch((err) => {
            console.error('[agent] Container agent error:', err);
            agentRunning = false;
        });
    }
    /**
     * Parse agent stdout for text between output/tool markers and relay as SSE.
     * Text outside markers is treated as raw agent console output (streamed as text_delta).
     */
    function relayAgentOutput(chunk) {
        parseBuffer += chunk;
        // Process all marker types: OUTPUT and TOOL
        let cursor = 0;
        while (cursor < parseBuffer.length) {
            // Find the nearest marker of any type
            const outputIdx = parseBuffer.indexOf(OUTPUT_START_MARKER, cursor);
            const toolIdx = parseBuffer.indexOf(TOOL_START_MARKER, cursor);
            // Determine which marker comes first
            let nearestIdx = -1;
            let markerType = 'output';
            if (outputIdx !== -1 && (toolIdx === -1 || outputIdx <= toolIdx)) {
                nearestIdx = outputIdx;
                markerType = 'output';
            }
            else if (toolIdx !== -1) {
                nearestIdx = toolIdx;
                markerType = 'tool';
            }
            if (nearestIdx === -1) {
                // No more markers — everything from cursor to end is plain text
                const text = parseBuffer.slice(cursor);
                if (text) {
                    if (lastSegmentIsText) {
                        const last = chatHistory[chatHistory.length - 1];
                        if (last && last.type === 'text')
                            last.content += text;
                    }
                    else {
                        chatHistory.push({ type: 'text', content: text });
                        lastSegmentIsText = true;
                    }
                    for (const client of sseClients) {
                        sseWrite(client, { type: 'text_delta', content: text });
                    }
                }
                parseBuffer = '';
                return;
            }
            // Text before the marker
            if (nearestIdx > cursor) {
                const text = parseBuffer.slice(cursor, nearestIdx);
                if (lastSegmentIsText) {
                    const last = chatHistory[chatHistory.length - 1];
                    if (last && last.type === 'text')
                        last.content += text;
                }
                else {
                    chatHistory.push({ type: 'text', content: text });
                    lastSegmentIsText = true;
                }
                for (const client of sseClients) {
                    sseWrite(client, { type: 'text_delta', content: text });
                }
            }
            if (markerType === 'output') {
                const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, nearestIdx);
                if (endIdx === -1) {
                    parseBuffer = parseBuffer.slice(nearestIdx);
                    return;
                }
                cursor = endIdx + OUTPUT_END_MARKER.length;
            }
            else {
                // Tool marker
                const endIdx = parseBuffer.indexOf(TOOL_END_MARKER, nearestIdx);
                if (endIdx === -1) {
                    parseBuffer = parseBuffer.slice(nearestIdx);
                    return;
                }
                // Parse tool info
                const jsonStr = parseBuffer
                    .slice(nearestIdx + TOOL_START_MARKER.length, endIdx)
                    .trim();
                try {
                    const info = JSON.parse(jsonStr);
                    markRunningToolsDone();
                    const tool = {
                        id: info.id,
                        name: info.name,
                        input_preview: info.input_preview,
                        status: 'running',
                    };
                    chatHistory.push({ type: 'tool', tool });
                    lastSegmentIsText = false;
                    for (const client of sseClients) {
                        sseWrite(client, {
                            type: 'tool_start',
                            id: info.id,
                            name: info.name,
                            input_preview: info.input_preview,
                        });
                    }
                }
                catch {
                    // Malformed tool info, skip
                }
                cursor = endIdx + TOOL_END_MARKER.length;
            }
        }
        parseBuffer = '';
    }
    /** Kill the agent container, waiting for it to exit. */
    async function killAgent() {
        // Capture before the close event handler can clear them (race condition
        // when SIGINT is delivered to both parent and child simultaneously).
        const name = agentContainerName;
        const proc = agentProcess;
        if (name) {
            // Stop the container directly by name — this is the only reliable way.
            // Sending SIGTERM to the docker run CLI process just disconnects it;
            // the container itself keeps running.
            const { getRuntimeBin } = await import('../container-runtime.js');
            const bin = getRuntimeBin();
            await new Promise((resolve) => {
                const stop = spawn(bin, ['stop', '-t', '3', name], {
                    stdio: 'ignore',
                });
                stop.on('close', () => resolve());
            });
        }
        else if (proc) {
            // No container name yet (still starting) — kill the process directly
            proc.kill('SIGTERM');
        }
    }
    const server = http.createServer(async (req, res) => {
        const method = req.method ?? 'GET';
        const reqUrl = req.url ?? '/';
        const parsed = new URL(reqUrl, `http://localhost`);
        // CORS headers for API endpoints
        if (parsed.pathname.startsWith('/api/')) {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            if (method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }
        }
        // API: read pipeline
        if (method === 'GET' && parsed.pathname === '/api/pipeline') {
            try {
                const data = fs.readFileSync(pipelineFile, 'utf-8');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(data);
            }
            catch {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to read PIPELINE.json' }));
            }
            return;
        }
        // API: write pipeline
        if (method === 'POST' && parsed.pathname === '/api/pipeline') {
            let body = '';
            req.on('data', (chunk) => {
                body += chunk.toString();
            });
            req.on('end', () => {
                try {
                    // Validate JSON
                    JSON.parse(body);
                    fs.writeFileSync(pipelineFile, body, 'utf-8');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                }
                catch {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid JSON' }));
                }
            });
            return;
        }
        // API: list directories and their files in __art__/
        if (method === 'GET' && parsed.pathname === '/api/dirs') {
            try {
                const entries = fs.readdirSync(artDir, { withFileTypes: true });
                const dirs = entries
                    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
                    .map((e) => {
                    const dirPath = path.join(artDir, e.name);
                    let files = [];
                    try {
                        files = fs.readdirSync(dirPath).filter((f) => !f.startsWith('.'));
                    }
                    catch {
                        /* empty or unreadable */
                    }
                    return { name: e.name, files };
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(dirs));
            }
            catch {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to read directories' }));
            }
            return;
        }
        // API: list project files (parent of __art__/, excluding __art__ and dotfiles)
        if (method === 'GET' && parsed.pathname === '/api/project-files') {
            try {
                const projectDir = path.dirname(artDir);
                const entries = fs.readdirSync(projectDir, { withFileTypes: true });
                const files = entries
                    .filter((e) => !e.name.startsWith('.') && e.name !== path.basename(artDir))
                    .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(files));
            }
            catch {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to read project files' }));
            }
            return;
        }
        // API: stage descriptions (for onboarding)
        if (method === 'GET' && parsed.pathname === '/api/stage-descriptions') {
            const descriptions = Object.values(STAGE_TEMPLATES).map((t) => ({
                name: t.name,
                description: t.description,
                mounts: t.mounts,
                transitions: t.transitions.map((tr) => ({
                    marker: tr.marker,
                    next: tr.next,
                    prompt: tr.prompt,
                })),
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(descriptions));
            return;
        }
        // API: save plan text
        if (method === 'POST' && parsed.pathname === '/api/plan') {
            let body = '';
            req.on('data', (chunk) => {
                body += chunk.toString();
            });
            req.on('end', () => {
                try {
                    const planDir = path.join(artDir, 'plan');
                    fs.mkdirSync(planDir, { recursive: true });
                    const planPath = path.join(planDir, 'PLAN.md');
                    fs.writeFileSync(planPath, body, 'utf-8');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                }
                catch {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Failed to write PLAN.md' }));
                }
            });
            return;
        }
        // API: write file to artDir (relative path, with traversal protection)
        if (method === 'PUT' && parsed.pathname === '/api/file') {
            const relPath = parsed.searchParams.get('path');
            if (!relPath) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing "path" query parameter' }));
                return;
            }
            const resolved = path.resolve(artDir, relPath);
            if (!resolved.startsWith(artDir + path.sep) && resolved !== artDir) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Path traversal not allowed' }));
                return;
            }
            let body = '';
            req.on('data', (chunk) => {
                body += chunk.toString();
            });
            req.on('end', () => {
                try {
                    fs.mkdirSync(path.dirname(resolved), { recursive: true });
                    fs.writeFileSync(resolved, body, 'utf-8');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                }
                catch {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Failed to write file' }));
                }
            });
            return;
        }
        // API: read file from artDir (relative path, with traversal protection)
        if (method === 'GET' && parsed.pathname === '/api/file') {
            const relPath = parsed.searchParams.get('path');
            if (!relPath) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing "path" query parameter' }));
                return;
            }
            const resolved = path.resolve(artDir, relPath);
            if (!resolved.startsWith(artDir + path.sep) && resolved !== artDir) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Path traversal not allowed' }));
                return;
            }
            try {
                const data = fs.readFileSync(resolved, 'utf-8');
                res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(data);
            }
            catch {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'File not found' }));
            }
            return;
        }
        // ── Agent Chat API endpoints ──
        // GET /api/chat/state — check if agent is running
        if (method === 'GET' && parsed.pathname === '/api/chat/state') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                agentRunning,
                hasSession: !!savedSessionId,
                hasHistory: chatHistory.length > 0,
            }));
            return;
        }
        // POST /api/chat/message — send user message to agent via IPC
        if (method === 'POST' && parsed.pathname === '/api/chat/message') {
            if (!agentRunning || !ipcInputDir) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Agent not running' }));
                return;
            }
            const body = await readBody(req);
            try {
                const { message } = JSON.parse(body);
                if (!message || typeof message !== 'string') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing "message" field' }));
                    return;
                }
                // Mark any running tools as done before recording user message
                markRunningToolsDone();
                chatHistory.push({ type: 'user', content: message });
                lastSegmentIsText = false;
                // Write IPC input file for the container agent to pick up
                const filename = `${Date.now()}-msg.json`;
                fs.writeFileSync(path.join(ipcInputDir, filename), JSON.stringify({ type: 'message', text: message }));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            }
            catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            }
            return;
        }
        // GET /api/chat/stream — SSE stream of agent output
        if (method === 'GET' && parsed.pathname === '/api/chat/stream') {
            sseHeaders(res);
            sseClients.add(res);
            // Send initial state
            sseWrite(res, { type: 'connected', agentRunning });
            // Replay chat history as segments
            for (const seg of chatHistory) {
                if (seg.type === 'user') {
                    sseWrite(res, {
                        type: 'history_segment',
                        segmentType: 'user',
                        content: seg.content,
                    });
                }
                else if (seg.type === 'text') {
                    sseWrite(res, {
                        type: 'history_segment',
                        segmentType: 'text',
                        content: seg.content,
                    });
                }
                else if (seg.type === 'tool') {
                    sseWrite(res, {
                        type: 'history_segment',
                        segmentType: 'tool',
                        tool: seg.tool,
                    });
                }
            }
            // If the agent is still streaming text, tell the client
            if (agentRunning && lastSegmentIsText) {
                sseWrite(res, { type: 'history_streaming' });
            }
            sseWrite(res, { type: 'history_end' });
            req.on('close', () => {
                sseClients.delete(res);
            });
            return;
        }
        // POST /api/chat/close — gracefully stop the agent and reset session
        if (method === 'POST' && parsed.pathname === '/api/chat/close') {
            if (agentRunning) {
                // Write _close sentinel as a hint, then kill the process directly
                if (ipcInputDir) {
                    try {
                        fs.writeFileSync(path.join(ipcInputDir, '_close'), '');
                    }
                    catch {
                        // best effort
                    }
                }
                killAgent().catch(() => { });
            }
            // Reset session so next spawnAgent() starts fresh
            savedSessionId = undefined;
            chatHistory.length = 0;
            lastSegmentIsText = false;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        // POST /api/chat/start — re-spawn agent (resume session if available)
        if (method === 'POST' && parsed.pathname === '/api/chat/start') {
            if (agentRunning) {
                res.writeHead(409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Agent already running' }));
                return;
            }
            spawnAgent().catch((err) => {
                console.error('Failed to spawn agent:', err);
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        // ── Run API endpoints ──
        // GET /api/runs — list run history
        if (method === 'GET' && parsed.pathname === '/api/runs') {
            try {
                const runs = listRunManifests(artDir);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(runs));
            }
            catch {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to list runs' }));
            }
            return;
        }
        // GET /api/runs/current — check currently running pipeline
        if (method === 'GET' && parsed.pathname === '/api/runs/current') {
            const current = readCurrentRun(artDir);
            if (current && isPidAlive(current.pid)) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(current));
            }
            else {
                // If PID is dead, clean up stale _current.json
                if (current)
                    removeCurrentRun(artDir);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('null');
            }
            return;
        }
        // POST /api/runs/start — spawn `art run .` as a child process
        if (method === 'POST' && parsed.pathname === '/api/runs/start') {
            const current = readCurrentRun(artDir);
            if (current && isPidAlive(current.pid)) {
                res.writeHead(409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Run already in progress',
                    runId: current.runId,
                }));
                return;
            }
            // Clean up stale _current.json if PID is dead
            if (current)
                removeCurrentRun(artDir);
            // Spawn art run as a child process
            const artBin = process.argv[1]; // path to the running CLI
            const childEnv = {
                ...process.env,
                FORCE_COLOR: '1',
            };
            // WSL: credential proxy must bind 0.0.0.0 so containers on the
            // Docker bridge can reach it (127.0.0.1 is host-only in WSL).
            if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) {
                childEnv.CREDENTIAL_PROXY_HOST = '0.0.0.0';
            }
            const child = spawn(process.execPath, [artBin, 'run', resolvedProjectDir], {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: childEnv,
                detached: false,
            });
            runProcess = child;
            // Save stdout/stderr to a log file for history replay
            const outputLogsDir = path.join(artDir, 'logs');
            fs.mkdirSync(outputLogsDir, { recursive: true });
            const outputTs = new Date().toISOString().replace(/[:.]/g, '-');
            const outputLogPath = path.join(outputLogsDir, `output-${outputTs}.log`);
            const outputLogStream = fs.createWriteStream(outputLogPath);
            child.stdout?.on('data', (data) => {
                const chunk = data.toString();
                outputLogStream.write(chunk);
                for (const client of runSseClients) {
                    sseWrite(client, { type: 'stdout', content: chunk });
                }
            });
            child.stderr?.on('data', (data) => {
                const chunk = data.toString();
                outputLogStream.write(chunk);
                for (const client of runSseClients) {
                    sseWrite(client, { type: 'stderr', content: chunk });
                }
            });
            child.on('close', (code) => {
                runProcess = null;
                outputLogStream.end();
                // Attach output log to the run manifest
                try {
                    const runsDir = path.join(artDir, 'runs');
                    const manifestFiles = fs
                        .readdirSync(runsDir)
                        .filter((f) => f.startsWith('run-') && f.endsWith('.json'))
                        .sort()
                        .reverse();
                    if (manifestFiles.length > 0) {
                        const latestPath = path.join(runsDir, manifestFiles[0]);
                        const manifest = JSON.parse(fs.readFileSync(latestPath, 'utf-8'));
                        manifest.outputLogFile = `logs/output-${outputTs}.log`;
                        fs.writeFileSync(latestPath, JSON.stringify(manifest, null, 2));
                    }
                }
                catch {
                    /* best effort */
                }
                for (const client of runSseClients) {
                    sseWrite(client, { type: 'run_stopped', code });
                    client.end();
                }
                runSseClients.clear();
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, pid: child.pid }));
            return;
        }
        // POST /api/runs/stop — stop currently running pipeline
        if (method === 'POST' && parsed.pathname === '/api/runs/stop') {
            const current = readCurrentRun(artDir);
            if (current && isPidAlive(current.pid)) {
                try {
                    process.kill(current.pid, 'SIGTERM');
                }
                catch {
                    /* already dead */
                }
            }
            if (runProcess) {
                try {
                    runProcess.kill('SIGTERM');
                }
                catch {
                    /* already dead */
                }
                runProcess = null;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        // GET /api/runs/stream — SSE stream of run output
        if (method === 'GET' && parsed.pathname === '/api/runs/stream') {
            sseHeaders(res);
            runSseClients.add(res);
            sseWrite(res, { type: 'connected', running: !!runProcess });
            req.on('close', () => {
                runSseClients.delete(res);
            });
            return;
        }
        // GET /api/runs/:id/log — read log file for a past run
        if (method === 'GET' &&
            parsed.pathname.startsWith('/api/runs/') &&
            parsed.pathname.endsWith('/log')) {
            const parts = parsed.pathname.split('/');
            const runId = parts[3]; // /api/runs/{runId}/log
            if (!runId || !runId.startsWith('run-')) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid run ID' }));
                return;
            }
            const manifest = readRunManifest(artDir, runId);
            if (!manifest || !manifest.logFile) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Run or log not found' }));
                return;
            }
            const logPath = path.join(artDir, manifest.logFile);
            try {
                const data = fs.readFileSync(logPath, 'utf-8');
                res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(data);
            }
            catch {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Log file not found' }));
            }
            return;
        }
        // GET /api/runs/:id/output — read output (stdout/stderr) log for a past run
        if (method === 'GET' &&
            parsed.pathname.startsWith('/api/runs/') &&
            parsed.pathname.endsWith('/output')) {
            const parts = parsed.pathname.split('/');
            const runId = parts[3]; // /api/runs/{runId}/output
            if (!runId || !runId.startsWith('run-')) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid run ID' }));
                return;
            }
            const manifest = readRunManifest(artDir, runId);
            if (!manifest || !manifest.outputLogFile) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Output log not found' }));
                return;
            }
            const logPath = path.join(artDir, manifest.outputLogFile);
            try {
                const data = fs.readFileSync(logPath, 'utf-8');
                res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(data);
            }
            catch {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Output log file not found' }));
            }
            return;
        }
        // GET /api/pipeline-state — current pipeline execution state
        if (method === 'GET' && parsed.pathname === '/api/pipeline-state') {
            const statePath = path.join(artDir, 'PIPELINE_STATE.json');
            try {
                const data = fs.readFileSync(statePath, 'utf-8');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(data);
            }
            catch {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('null');
            }
            return;
        }
        // GET /api/runs/live-log — SSE stream tailing the latest pipeline log file
        if (method === 'GET' && parsed.pathname === '/api/runs/live-log') {
            // Find the latest pipeline log
            const logsDir = path.join(artDir, 'logs');
            let logPath = null;
            try {
                const files = fs
                    .readdirSync(logsDir)
                    .filter((f) => f.startsWith('pipeline-') && f.endsWith('.log'))
                    .sort()
                    .reverse();
                if (files.length > 0) {
                    logPath = path.join(logsDir, files[0]);
                }
            }
            catch {
                /* no logs dir */
            }
            if (!logPath) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No pipeline log found' }));
                return;
            }
            sseHeaders(res);
            // Send existing content
            let offset = 0;
            try {
                const existing = fs.readFileSync(logPath, 'utf-8');
                if (existing) {
                    sseWrite(res, { type: 'log', content: existing });
                    offset = existing.length;
                }
            }
            catch {
                /* file may not exist yet */
            }
            // Poll for new content (fs.watch is unreliable across platforms)
            const tailInterval = setInterval(() => {
                try {
                    const stat = fs.statSync(logPath);
                    if (stat.size > offset) {
                        const fd = fs.openSync(logPath, 'r');
                        const buf = Buffer.alloc(stat.size - offset);
                        fs.readSync(fd, buf, 0, buf.length, offset);
                        fs.closeSync(fd);
                        offset = stat.size;
                        const chunk = buf.toString('utf-8');
                        if (chunk) {
                            sseWrite(res, { type: 'log', content: chunk });
                        }
                    }
                }
                catch {
                    /* file may be gone */
                }
            }, 500);
            req.on('close', () => {
                clearInterval(tailInterval);
            });
            return;
        }
        // ── Image Registry API endpoints ──
        // GET /api/images — list registered images
        if (method === 'GET' && parsed.pathname === '/api/images') {
            try {
                const registry = loadImageRegistry();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(registry));
            }
            catch {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to load image registry' }));
            }
            return;
        }
        // POST /api/images — add a new image (with optional build)
        if (method === 'POST' && parsed.pathname === '/api/images') {
            const body = await readBody(req);
            try {
                const { key, baseImage, hasAgent } = JSON.parse(body);
                if (!key || typeof key !== 'string') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing "key" field' }));
                    return;
                }
                if (key === 'default') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Cannot modify default image' }));
                    return;
                }
                if (!baseImage || typeof baseImage !== 'string') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing "baseImage" field' }));
                    return;
                }
                // Register in image registry — actual build happens at `art run .`
                const registry = loadImageRegistry();
                const image = hasAgent ? `aer-art-agent-${key}:latest` : baseImage;
                registry[key] = { image, hasAgent: !!hasAgent, baseImage };
                saveImageRegistry(registry);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            }
            catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            }
            return;
        }
        // DELETE /api/images — remove image by key
        if (method === 'DELETE' && parsed.pathname === '/api/images') {
            const key = parsed.searchParams.get('key');
            if (!key) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing "key" query parameter' }));
                return;
            }
            if (key === 'default') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Cannot delete default image' }));
                return;
            }
            try {
                const registry = loadImageRegistry();
                delete registry[key];
                saveImageRegistry(registry);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            }
            catch {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to delete image' }));
            }
            return;
        }
        // Static file serving
        let filePath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
        const fullPath = path.join(distDir, filePath);
        // Prevent directory traversal
        if (!fullPath.startsWith(distDir)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }
        try {
            const data = fs.readFileSync(fullPath);
            const ext = path.extname(fullPath);
            const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
        }
        catch {
            // SPA fallback: serve index.html for unknown routes
            try {
                const index = fs.readFileSync(path.join(distDir, 'index.html'));
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(index);
            }
            catch {
                res.writeHead(404);
                res.end('Not found');
            }
        }
    });
    const EDITOR_PORT = parseInt(process.env.ART_EDITOR_PORT || '4800', 10);
    const onListening = () => {
        const addr = server.address();
        const port = addr.port;
        const url = `http://localhost:${port}?mode=${mode}`;
        console.log(`Opening pipeline editor for ${path.dirname(artDir)}`);
        console.log(`  ${url}\n`);
        // Open browser
        const openCmd = process.platform === 'darwin'
            ? 'open'
            : process.platform === 'win32'
                ? 'start'
                : 'xdg-open';
        spawn(openCmd, [url], { stdio: 'ignore', detached: true }).unref();
        // Spawn the container agent after server is listening
        spawnAgent().catch((err) => {
            console.error('Failed to spawn agent:', err);
        });
    };
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`Port ${EDITOR_PORT} in use, using random port`);
            server.listen(0, onListening);
        }
        else {
            throw err;
        }
    });
    server.listen(EDITOR_PORT, onListening);
    // Graceful shutdown
    let cleaningUp = false;
    const cleanup = () => {
        if (cleaningUp)
            return;
        cleaningUp = true;
        server.close();
        // Kill the agent container, then exit
        const forceExitTimer = setTimeout(() => process.exit(1), 5000);
        killAgent()
            .catch(() => { })
            .finally(() => {
            clearTimeout(forceExitTimer);
            process.exit(0);
        });
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    // Keep alive until server closes
    await new Promise((resolve) => {
        server.on('close', () => resolve());
    });
}
export async function compose(targetDir) {
    const projectDir = path.resolve(targetDir);
    const artDir = path.join(projectDir, ART_DIR_NAME);
    if (!fs.existsSync(artDir)) {
        console.error(`No ${ART_DIR_NAME}/ found in ${projectDir}. Run 'art init .' first.`);
        process.exit(1);
    }
    const pipelineFile = path.join(artDir, 'PIPELINE.json');
    if (!fs.existsSync(pipelineFile)) {
        console.error(`No PIPELINE.json found in ${artDir}. Run 'art init .' first.`);
        process.exit(1);
    }
    // Setup auth + engine for container agent
    await ensureAuth();
    await setupEngine({ projectDir, artDir });
    await startEditorServer(artDir, 'single', projectDir);
}
//# sourceMappingURL=compose.js.map