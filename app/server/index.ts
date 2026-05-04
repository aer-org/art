import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

import { PORT, WEB_DIST } from './config.ts';
import { preflight, terminateClaudeSetupToken } from './preflight.ts';
import { registerBrowseRoutes } from './routes/browse.ts';
import { registerLoadRoutes } from './routes/load.ts';
import { registerStateRoutes } from './routes/state.ts';
import { registerRunRoutes } from './routes/run.ts';
import { registerStageRoutes } from './routes/stage.ts';
import { registerPipelineRoutes } from './routes/pipeline.ts';
import { registerChatRoutes } from './routes/chat.ts';
import { registerPreflightRoutes } from './routes/preflight.ts';

async function main() {
  const app = Fastify({ logger: { level: 'info' } });

  registerBrowseRoutes(app);
  registerLoadRoutes(app);
  registerStateRoutes(app);
  registerRunRoutes(app);
  registerStageRoutes(app);
  registerPipelineRoutes(app);
  registerChatRoutes(app);
  registerPreflightRoutes(app);

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
