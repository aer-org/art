import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { ART_DIR_NAME } from '../config.js';
import { STAGE_TEMPLATES } from '../stage-templates.js';
import { resolveAuthToken } from './auth.js';
import { initChat, sendMessage, advancePhase, getChatState } from './llm-chat.js';
const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
};
function readBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', () => resolve(body));
    });
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
    const port = 5173;
    const url = `http://localhost:${port}?mode=${mode}`;
    const server = http.createServer(async (req, res) => {
        const method = req.method ?? 'GET';
        const reqUrl = req.url ?? '/';
        const parsed = new URL(reqUrl, `http://localhost:${port}`);
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
        // ── Chat API endpoints ──
        // GET /api/chat/state — check auth and current phase
        if (method === 'GET' && parsed.pathname === '/api/chat/state') {
            const token = resolveAuthToken();
            const state = getChatState(resolvedProjectDir, !!token);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(state));
            return;
        }
        // POST /api/chat/init — scan codebase + stream first analysis (SSE)
        if (method === 'POST' && parsed.pathname === '/api/chat/init') {
            const token = resolveAuthToken();
            if (!token) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No API key configured' }));
                return;
            }
            initChat(token, resolvedProjectDir, res).catch(() => res.end());
            return;
        }
        // POST /api/chat/message — send user message + stream response (SSE)
        if (method === 'POST' && parsed.pathname === '/api/chat/message') {
            const token = resolveAuthToken();
            if (!token) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No API key configured' }));
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
                sendMessage(token, resolvedProjectDir, message, res).catch(() => res.end());
            }
            catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            }
            return;
        }
        // POST /api/chat/advance — advance phase + save files
        if (method === 'POST' && parsed.pathname === '/api/chat/advance') {
            const result = advancePhase(resolvedProjectDir, artDir);
            res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
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
    server.listen(port, () => {
        console.log(`Opening pipeline editor for ${path.dirname(artDir)}`);
        console.log(`  ${url}\n`);
        // Open browser
        const openCmd = process.platform === 'darwin'
            ? 'open'
            : process.platform === 'win32'
                ? 'start'
                : 'xdg-open';
        spawn(openCmd, [url], { stdio: 'ignore', detached: true }).unref();
    });
    // Graceful shutdown
    const cleanup = () => {
        server.close();
        process.exit(0);
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
    await startEditorServer(artDir, 'single');
}
//# sourceMappingURL=compose.js.map