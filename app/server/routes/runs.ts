/**
 * Transparency-visualizer routes. All endpoints are read-only file-system
 * queries against `__art__/.state/runs/<runId>/` for the currently loaded
 * project (set via /api/load). No SSE: sealed runs are static, live runs
 * the UI polls.
 *
 * Endpoints:
 *   GET /api/runs                                       — list runs
 *   GET /api/runs/:runId                                — run detail
 *   GET /api/runs/:runId/events?type=&limit=&stage=     — events.jsonl
 *   GET /api/runs/:runId/provenance                     — provenance.json
 *   GET /api/runs/:runId/pipeline-snap                  — pipeline.snap.json
 *   GET /api/runs/:runId/stages/:nodeId/:stageName      — stage detail
 *   GET .../prompt                                      — prompt.txt
 *   GET .../initial                                     — initial.txt
 *   GET .../command                                     — command.sh + .json
 *   GET .../diff                                        — diff summary + list
 *   GET .../diff/:mount                                 — unified diff
 *   GET .../turns                                       — turns/NNN.json[]
 *   GET .../stream?kind=&tail=                          — stream tail
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { projectState } from '../project-state.ts';
import {
  getRun,
  getStage,
  listRuns,
  readEvents,
  readPipelineSnap,
  readProvenance,
  readStageCommand,
  readStageDiff,
  readStageDiffSummary,
  readStageStream,
  readStageText,
  readStageTurns,
} from '../run-reader.ts';

interface RunIdParam {
  runId: string;
}
interface StageParam extends RunIdParam {
  nodeId: string;
  stageName: string;
}
interface DiffParam extends StageParam {
  mount: string;
}

function projectOr400(reply: FastifyReply): string | null {
  const project = projectState.current;
  if (!project) {
    reply.code(400).send({ error: 'No project loaded.' });
    return null;
  }
  return project.projectDir;
}

export function registerRunsRoutes(app: FastifyInstance): void {
  app.get('/api/runs', async (_req, reply) => {
    const projectDir = projectOr400(reply);
    if (!projectDir) return;
    return { runs: listRuns(projectDir) };
  });

  app.get<{ Params: RunIdParam }>(
    '/api/runs/:runId',
    async (req, reply) => {
      const projectDir = projectOr400(reply);
      if (!projectDir) return;
      const detail = getRun(projectDir, req.params.runId);
      if (!detail) return reply.code(404).send({ error: 'Run not found.' });
      return detail;
    },
  );

  app.get<{
    Params: RunIdParam;
    Querystring: { type?: string; limit?: string; stage?: string; node?: string };
  }>('/api/runs/:runId/events', async (req, reply) => {
    const projectDir = projectOr400(reply);
    if (!projectDir) return;
    const limit = req.query.limit
      ? Math.max(0, Number(req.query.limit))
      : undefined;
    return {
      events: readEvents(projectDir, req.params.runId, {
        type: req.query.type,
        limit: Number.isFinite(limit) ? limit : undefined,
        stageName: req.query.stage,
        nodeId: req.query.node,
      }),
    };
  });

  app.get<{ Params: RunIdParam }>(
    '/api/runs/:runId/provenance',
    async (req, reply) => {
      const projectDir = projectOr400(reply);
      if (!projectDir) return;
      const p = readProvenance(projectDir, req.params.runId);
      if (!p) return reply.code(404).send({ error: 'No provenance for run.' });
      return p;
    },
  );

  app.get<{ Params: RunIdParam }>(
    '/api/runs/:runId/pipeline-snap',
    async (req, reply) => {
      const projectDir = projectOr400(reply);
      if (!projectDir) return;
      const snap = readPipelineSnap(projectDir, req.params.runId);
      if (!snap) {
        return reply.code(404).send({ error: 'No pipeline snapshot for run.' });
      }
      return snap;
    },
  );

  app.get<{ Params: StageParam }>(
    '/api/runs/:runId/stages/:nodeId/:stageName',
    async (req, reply) => {
      const projectDir = projectOr400(reply);
      if (!projectDir) return;
      const detail = getStage(
        projectDir,
        req.params.runId,
        req.params.nodeId,
        req.params.stageName,
      );
      if (!detail) return reply.code(404).send({ error: 'Stage not found.' });
      return detail;
    },
  );

  app.get<{ Params: StageParam }>(
    '/api/runs/:runId/stages/:nodeId/:stageName/prompt',
    async (req, reply) => {
      const projectDir = projectOr400(reply);
      if (!projectDir) return;
      const text = readStageText(
        projectDir,
        req.params.runId,
        req.params.nodeId,
        req.params.stageName,
        'prompt.txt',
      );
      if (text === null) {
        return reply.code(404).send({ error: 'No prompt.txt for stage.' });
      }
      reply.type('text/plain; charset=utf-8');
      return text;
    },
  );

  app.get<{ Params: StageParam }>(
    '/api/runs/:runId/stages/:nodeId/:stageName/initial',
    async (req, reply) => {
      const projectDir = projectOr400(reply);
      if (!projectDir) return;
      const text = readStageText(
        projectDir,
        req.params.runId,
        req.params.nodeId,
        req.params.stageName,
        'initial.txt',
      );
      if (text === null) {
        return reply.code(404).send({ error: 'No initial.txt for stage.' });
      }
      reply.type('text/plain; charset=utf-8');
      return text;
    },
  );

  app.get<{ Params: StageParam }>(
    '/api/runs/:runId/stages/:nodeId/:stageName/command',
    async (req, reply) => {
      const projectDir = projectOr400(reply);
      if (!projectDir) return;
      const cmd = readStageCommand(
        projectDir,
        req.params.runId,
        req.params.nodeId,
        req.params.stageName,
      );
      if (cmd.sh === null && cmd.meta === null) {
        return reply.code(404).send({ error: 'No command for stage.' });
      }
      return cmd;
    },
  );

  app.get<{ Params: StageParam }>(
    '/api/runs/:runId/stages/:nodeId/:stageName/diff',
    async (req, reply) => {
      const projectDir = projectOr400(reply);
      if (!projectDir) return;
      const summary = readStageDiffSummary(
        projectDir,
        req.params.runId,
        req.params.nodeId,
        req.params.stageName,
      );
      if (!summary) return reply.code(404).send({ error: 'No diff for stage.' });
      return summary;
    },
  );

  app.get<{ Params: DiffParam }>(
    '/api/runs/:runId/stages/:nodeId/:stageName/diff/:mount',
    async (req, reply) => {
      const projectDir = projectOr400(reply);
      if (!projectDir) return;
      const text = readStageDiff(
        projectDir,
        req.params.runId,
        req.params.nodeId,
        req.params.stageName,
        req.params.mount,
      );
      if (text === null) {
        return reply.code(404).send({ error: 'No diff for mount.' });
      }
      reply.type('text/plain; charset=utf-8');
      return text;
    },
  );

  app.get<{ Params: StageParam }>(
    '/api/runs/:runId/stages/:nodeId/:stageName/turns',
    async (req, reply) => {
      const projectDir = projectOr400(reply);
      if (!projectDir) return;
      return {
        turns: readStageTurns(
          projectDir,
          req.params.runId,
          req.params.nodeId,
          req.params.stageName,
        ),
      };
    },
  );

  app.get<{
    Params: StageParam;
    Querystring: { kind?: 'agent' | 'stdout' | 'stderr'; tail?: string };
  }>(
    '/api/runs/:runId/stages/:nodeId/:stageName/stream',
    async (req, reply) => {
      const projectDir = projectOr400(reply);
      if (!projectDir) return;
      const kind = req.query.kind ?? 'agent';
      const tail = req.query.tail
        ? Math.max(1, Number(req.query.tail))
        : 500;
      const out = readStageStream(
        projectDir,
        req.params.runId,
        req.params.nodeId,
        req.params.stageName,
        kind,
        Number.isFinite(tail) ? tail : 500,
      );
      if (!out) return reply.code(404).send({ error: 'No stream for stage.' });
      return out;
    },
  );
}
