import { ChildProcess } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

import { ART_DIR_NAME } from '../config.js';
import { STAGE_TEMPLATES } from '../stage-templates.js';
import { ensureAuth } from './auth.js';
import { setupEngine } from './engine-setup.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// Sentinel markers (must match container agent-runner)
const OUTPUT_START_MARKER = '---AER_ART_OUTPUT_START---';
const OUTPUT_END_MARKER = '---AER_ART_OUTPUT_END---';

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
  });
}

/** SSE helpers */
function sseHeaders(res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

function sseWrite(
  res: http.ServerResponse,
  event: Record<string, unknown>,
): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export async function startEditorServer(
  artDir: string,
  mode: 'single' | 'init',
  projectDir?: string,
): Promise<void> {
  const pipelineFile = path.join(artDir, 'PIPELINE.json');
  const resolvedProjectDir = projectDir ?? path.dirname(artDir);

  // Resolve the team-editor/dist directory relative to this package
  const thisFile = fileURLToPath(import.meta.url);
  const packageRoot = path.resolve(path.dirname(thisFile), '..', '..');
  const distDir = path.join(packageRoot, 'team-editor', 'dist');

  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    console.error(
      'team-editor/dist/ not found. Ensure the package is installed correctly.',
    );
    process.exit(1);
  }

  // ── Agent lifecycle state ──
  let agentProcess: ChildProcess | null = null;
  let agentRunning = false;
  let ipcInputDir = '';
  let parseBuffer = '';
  // SSE clients waiting for agent output
  const sseClients: Set<http.ServerResponse> = new Set();

  // Spawn the container agent
  async function spawnAgent(): Promise<void> {
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
    const prompt =
      mode === 'init'
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
    };

    agentRunning = true;
    parseBuffer = '';

    // Start the credential proxy for container auth
    const { startCredentialProxy } = await import('../credential-proxy.js');
    const { getCredentialProxyPort } = await import('../config.js');
    try {
      await startCredentialProxy(getCredentialProxyPort(), '0.0.0.0');
    } catch {
      // May already be running if reused
    }

    // Fire and forget — the container runs in the background
    runContainerAgent(
      group,
      input,
      (proc: ChildProcess) => {
        agentProcess = proc;

        // Parse stdout for output markers and relay to SSE clients
        proc.stdout?.on('data', (data: Buffer) => {
          const chunk = data.toString();
          relayAgentOutput(chunk);
        });

        proc.stderr?.on('data', (data: Buffer) => {
          // Log stderr for debugging
          const lines = data.toString().trim().split('\n');
          for (const line of lines) {
            if (line) console.error(`[agent] ${line}`);
          }
        });

        proc.on('close', () => {
          agentRunning = false;
          agentProcess = null;
          // Notify all SSE clients that agent has stopped
          for (const client of sseClients) {
            sseWrite(client, { type: 'agent_stopped' });
            client.end();
          }
          sseClients.clear();
        });
      },
      // onOutput callback for streaming results
      async (output) => {
        if (output.result) {
          for (const client of sseClients) {
            sseWrite(client, { type: 'result', content: output.result });
          }
        }
      },
    ).catch((err) => {
      console.error('[agent] Container agent error:', err);
      agentRunning = false;
    });
  }

  /**
   * Parse agent stdout for text between output markers and relay as SSE.
   * Text outside markers is treated as raw agent console output (streamed as text_delta).
   */
  function relayAgentOutput(chunk: string): void {
    parseBuffer += chunk;

    // Stream text that appears OUTSIDE of output markers as text_delta events.
    // Output markers contain structured JSON results (handled by onOutput callback).
    let cursor = 0;
    while (cursor < parseBuffer.length) {
      const startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER, cursor);
      if (startIdx === -1) {
        // No more markers — everything from cursor to end is plain text
        const text = parseBuffer.slice(cursor);
        if (text) {
          for (const client of sseClients) {
            sseWrite(client, { type: 'text_delta', content: text });
          }
        }
        parseBuffer = '';
        return;
      }

      // Text before the marker
      if (startIdx > cursor) {
        const text = parseBuffer.slice(cursor, startIdx);
        for (const client of sseClients) {
          sseWrite(client, { type: 'text_delta', content: text });
        }
      }

      // Find end marker
      const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
      if (endIdx === -1) {
        // Incomplete marker pair — keep in buffer
        parseBuffer = parseBuffer.slice(startIdx);
        return;
      }

      // Skip the marker pair (structured output is handled by onOutput)
      cursor = endIdx + OUTPUT_END_MARKER.length;
    }

    parseBuffer = '';
  }

  const port = 5173;
  const url = `http://localhost:${port}?mode=${mode}`;

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const reqUrl = req.url ?? '/';
    const parsed = new URL(reqUrl, `http://localhost:${port}`);

    // CORS headers for API endpoints
    if (parsed.pathname.startsWith('/api/')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to read PIPELINE.json' }));
      }
      return;
    }

    // API: write pipeline
    if (method === 'POST' && parsed.pathname === '/api/pipeline') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          // Validate JSON
          JSON.parse(body);
          fs.writeFileSync(pipelineFile, body, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
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
            let files: string[] = [];
            try {
              files = fs.readdirSync(dirPath).filter((f) => !f.startsWith('.'));
            } catch {
              /* empty or unreadable */
            }
            return { name: e.name, files };
          });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(dirs));
      } catch {
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
          .filter(
            (e) => !e.name.startsWith('.') && e.name !== path.basename(artDir),
          )
          .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(files));
      } catch {
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
      req.on('data', (chunk: Buffer) => {
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
        } catch {
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
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          fs.mkdirSync(path.dirname(resolved), { recursive: true });
          fs.writeFileSync(resolved, body, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
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
      } catch {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File not found' }));
      }
      return;
    }

    // ── Agent Chat API endpoints ──

    // GET /api/chat/state — check if agent is running
    if (method === 'GET' && parsed.pathname === '/api/chat/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ agentRunning }));
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

        // Write IPC input file for the container agent to pick up
        const filename = `${Date.now()}-msg.json`;
        fs.writeFileSync(
          path.join(ipcInputDir, filename),
          JSON.stringify({ type: 'message', text: message }),
        );

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
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

      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    // POST /api/chat/close — gracefully stop the agent
    if (method === 'POST' && parsed.pathname === '/api/chat/close') {
      if (agentRunning && ipcInputDir) {
        // Write _close sentinel to signal the agent to exit
        fs.writeFileSync(path.join(ipcInputDir, '_close'), '');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
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
    } catch {
      // SPA fallback: serve index.html for unknown routes
      try {
        const index = fs.readFileSync(path.join(distDir, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(index);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    }
  });

  server.listen(port, () => {
    console.log(`Opening pipeline editor for ${path.dirname(artDir)}`);
    console.log(`  ${url}\n`);

    // Open browser
    const openCmd =
      process.platform === 'darwin'
        ? 'open'
        : process.platform === 'win32'
          ? 'start'
          : 'xdg-open';
    spawn(openCmd, [url], { stdio: 'ignore', detached: true }).unref();

    // Spawn the container agent after server is listening
    spawnAgent().catch((err) => {
      console.error('Failed to spawn agent:', err);
    });
  });

  // Graceful shutdown
  const cleanup = () => {
    // Stop the agent if running
    if (agentRunning && ipcInputDir) {
      try {
        fs.writeFileSync(path.join(ipcInputDir, '_close'), '');
      } catch {
        // best effort
      }
    }
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Keep alive until server closes
  await new Promise<void>((resolve) => {
    server.on('close', () => resolve());
  });
}

export async function compose(targetDir: string): Promise<void> {
  const projectDir = path.resolve(targetDir);
  const artDir = path.join(projectDir, ART_DIR_NAME);

  if (!fs.existsSync(artDir)) {
    console.error(
      `No ${ART_DIR_NAME}/ found in ${projectDir}. Run 'art init .' first.`,
    );
    process.exit(1);
  }

  const pipelineFile = path.join(artDir, 'PIPELINE.json');
  if (!fs.existsSync(pipelineFile)) {
    console.error(
      `No PIPELINE.json found in ${artDir}. Run 'art init .' first.`,
    );
    process.exit(1);
  }

  // Setup auth + engine for container agent
  await ensureAuth();
  await setupEngine({ projectDir, artDir });

  await startEditorServer(artDir, 'single', projectDir);
}
