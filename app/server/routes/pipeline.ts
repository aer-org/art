import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import type { FastifyInstance } from 'fastify';

import { projectState } from '../project-state.ts';
import { runController } from '../run-controller.ts';
import type { PipelineConfig, PipelineStage } from '../types.ts';

interface Body {
  config: PipelineConfig;
}

function validate(config: unknown): { ok: true; config: PipelineConfig } | { ok: false; error: string } {
  if (!config || typeof config !== 'object') return { ok: false, error: 'config must be an object' };
  const c = config as PipelineConfig;
  if (!Array.isArray(c.stages) || c.stages.length === 0) {
    return { ok: false, error: 'stages must be a non-empty array' };
  }
  const names = new Set<string>();
  for (const s of c.stages as PipelineStage[]) {
    if (!s || typeof s !== 'object') return { ok: false, error: 'every stage must be an object' };
    if (typeof s.name !== 'string' || !s.name) return { ok: false, error: 'every stage must have a string "name"' };
    if (names.has(s.name)) return { ok: false, error: `duplicate stage name: ${s.name}` };
    names.add(s.name);
    if (s.kind && s.kind !== 'agent' && s.kind !== 'command') {
      return { ok: false, error: `stage "${s.name}": kind must be 'agent' or 'command'` };
    }
    if (s.transitions && !Array.isArray(s.transitions)) {
      return { ok: false, error: `stage "${s.name}": transitions must be an array` };
    }
  }
  // Reference check
  for (const s of c.stages) {
    for (const t of s.transitions ?? []) {
      const targets = t.next == null ? [] : Array.isArray(t.next) ? t.next : [t.next];
      for (const target of targets) {
        if (!names.has(target)) {
          return { ok: false, error: `stage "${s.name}": transition next "${target}" does not match any stage` };
        }
      }
    }
  }
  return { ok: true, config: c };
}

export function registerPipelineRoutes(app: FastifyInstance): void {
  app.post<{ Body: Body }>('/api/pipeline', async (req, reply) => {
    const project = projectState.current;
    if (!project) return reply.code(400).send({ error: 'No project loaded.' });
    if (runController.isRunning(project.projectDir)) {
      return reply.code(409).send({ error: 'Cannot edit PIPELINE.json while a run is in progress.' });
    }

    const result = validate(req.body?.config);
    if (!result.ok) return reply.code(400).send({ error: result.error });

    const filePath = path.join(project.artDir, 'PIPELINE.json');
    const tmpPath = `${filePath}.tmp`;
    let release: (() => Promise<void>) | null = null;
    try {
      release = await lockfile.lock(filePath, { realpath: false, retries: 5 });
      fs.writeFileSync(tmpPath, JSON.stringify(result.config, null, 2) + '\n');
      fs.renameSync(tmpPath, filePath);
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    } finally {
      if (release) await release().catch(() => {});
    }
    return { ok: true };
  });
}
