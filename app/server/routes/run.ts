import type { FastifyInstance } from 'fastify';

import { projectState } from '../project-state.ts';
import { runController } from '../run-controller.ts';
import { authStatus } from '../preflight.ts';

export function registerRunRoutes(app: FastifyInstance): void {
  app.post('/api/run', async (_req, reply) => {
    const project = projectState.current;
    if (!project) return reply.code(400).send({ error: 'No project loaded.' });
    const auth = authStatus(project.projectDir);
    const result = runController.start(project.projectDir, {
      skipPreflight: !auth.present,
      authWarning: auth.present
        ? undefined
        : 'Claude authentication is not configured. Running with `art run --skip-preflight` so the GUI can show logs; agent stages may fail until Initial Setup is completed.',
    });
    if (!result.ok) return reply.code(result.status).send({ error: result.reason });
    return { ok: true, pid: result.pid };
  });

  app.post('/api/stop', async (_req, reply) => {
    const project = projectState.current;
    if (!project) return reply.code(400).send({ error: 'No project loaded.' });
    const result = await runController.stop(project.projectDir);
    if (!result.ok) return reply.code(409).send({ error: result.reason });
    return { ok: true };
  });

  app.get('/api/run/log', async (_req, reply) => {
    const project = projectState.current;
    if (!project) return reply.code(400).send({ error: 'No project loaded.' });
    return { lines: runController.log(project.projectDir) };
  });
}
