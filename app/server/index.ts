import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

import { ART_DIR_NAME, PORT, WEB_DIST } from './config.ts';
import { loadLastProject } from './last-project.ts';
import { preflight, terminateClaudeSetupToken } from './preflight.ts';
import { projectState } from './project-state.ts';
import { registerBrowseRoutes } from './routes/browse.ts';
import { registerDebugRoutes } from './routes/debug.ts';
import { registerLoadRoutes } from './routes/load.ts';
import { registerStateRoutes } from './routes/state.ts';
import { registerRunRoutes } from './routes/run.ts';
import { registerStageRoutes } from './routes/stage.ts';
import { registerPipelineRoutes } from './routes/pipeline.ts';
import { registerChatRoutes } from './routes/chat.ts';
import { registerPreflightRoutes } from './routes/preflight.ts';
import { registerRunsRoutes } from './routes/runs.ts';

async function main() {
  const app = Fastify({ logger: { level: 'info' } });

  registerBrowseRoutes(app);
  registerDebugRoutes(app);
  registerLoadRoutes(app);
  registerStateRoutes(app);
  registerRunRoutes(app);
  registerStageRoutes(app);
  registerPipelineRoutes(app);
  registerChatRoutes(app);
  registerPreflightRoutes(app);
  registerRunsRoutes(app);

  if (fs.existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, {
      root: WEB_DIST,
      prefix: '/',
      wildcard: false,
    });
    // SPA fallback: any non-/api path falls back to index.html
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.get('/', async () => ({
      message: 'Frontend not built. Run `cd web && npm run build` (or use ./run.sh).',
    }));
  }

  // Kick off preflight in background so the cache is warm.
  preflight().catch(() => {});

  // Restore the most recently opened project. Skipped silently if the
  // saved path no longer points at a valid __art__ directory — the
  // user will just see the picker as usual.
  const last = loadLastProject();
  if (last) {
    const pipelinePath = path.join(last, ART_DIR_NAME, 'PIPELINE.json');
    if (fs.existsSync(pipelinePath)) {
      try {
        await projectState.load(last);
        console.log(`Restored last project: ${last}`);
      } catch (err) {
        console.error('Failed to restore last project:', err);
      }
    }
  }

  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`AerArt Debug UI listening on http://localhost:${PORT}`);

  let shuttingDown = false;
  async function shutdown(signal: NodeJS.Signals) {
    if (shuttingDown) {
      process.exit(1);
    }
    shuttingDown = true;
    terminateClaudeSetupToken(signal);
    try {
      await app.close();
    } catch {
      // Exit anyway; Ctrl-C should never hang behind setup-token cleanup.
    }
    process.exit(0);
  }

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
