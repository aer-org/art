import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { FastifyInstance } from 'fastify';

interface BrowseQuery {
  path?: string;
}

export function registerBrowseRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: BrowseQuery }>('/api/browse', async (req, reply) => {
    const requested = req.query.path && req.query.path.trim() ? req.query.path : os.homedir();
    const abs = path.resolve(requested);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }

    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({
        name: e.name,
        path: path.join(abs, e.name),
        hasArt: fs.existsSync(path.join(abs, e.name, '__art__', 'PIPELINE.json')),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const parent = path.dirname(abs);
    const hasArtHere = fs.existsSync(path.join(abs, '__art__', 'PIPELINE.json'));

    return {
      path: abs,
      parent: parent === abs ? null : parent,
      home: os.homedir(),
      hasArt: hasArtHere,
      entries: dirs,
    };
  });
}
