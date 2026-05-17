import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

import {
  buildNodeLogContext,
  findLatestPipelineLogFile,
  tailStageClaudeTranscriptLines,
  tailNodeLogLines,
} from '../node-log.ts';
import { projectState } from '../project-state.ts';
import type { PipelineStage } from '../types.ts';

const TAIL_LINES = 500;
const TRANSCRIPT_TAIL_LINES = 350;

interface Params {
  name: string;
}

function tailLog(filePath: string, lines: number): string[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const split = raw.split('\n');
    return split.slice(Math.max(0, split.length - lines));
  } catch {
    return [];
  }
}

function findContainerLogs(logsDir: string, stageName: string, limit = 5): string[] {
  if (!fs.existsSync(logsDir)) return [];
  const agentStageName = `pipeline-${stageName}`;
  return fs
    .readdirSync(logsDir)
    .filter((f) => f.startsWith('container-') && f.endsWith('.log'))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((f) => path.join(logsDir, f))
    .filter((p) => {
      try {
        const head = fs.readFileSync(p, 'utf8').slice(0, 4000);
        return (
          head.includes(`Stage: ${stageName}`) ||
          head.includes(`Stage: ${agentStageName}`) ||
          head.includes(`Group: ${stageName}`) ||
          head.includes(`Group: ${agentStageName}`) ||
          head.includes(`[${stageName}]`)
        );
      } catch {
        return false;
      }
    });
}

const SCRIPT_MAX_BYTES = 256 * 1024;

export function registerStageRoutes(app: FastifyInstance): void {
  // Read the authored shell script for a command stage. The convention
  // is fixed (`__art__/scripts/<stage_name>.sh`), so no path resolution
  // is needed — for template-internal stages we still resolve by the
  // authored local name since templates and the base pipeline share
  // one scripts/ directory.
  app.get<{ Params: Params }>(
    '/api/stage/:name/script',
    async (req, reply) => {
      const project = projectState.current;
      if (!project)
        return reply.code(400).send({ error: 'No project loaded.' });
      const { name } = req.params;
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name)) {
        return reply.code(400).send({ error: 'Invalid stage name' });
      }
      const scriptPath = path.join(project.artDir, 'scripts', `${name}.sh`);
      let stat;
      try {
        stat = fs.statSync(scriptPath);
      } catch {
        return { name, exists: false, hostPath: scriptPath };
      }
      if (!stat.isFile()) {
        return { name, exists: false, hostPath: scriptPath };
      }
      const size = stat.size;
      const truncated = size > SCRIPT_MAX_BYTES;
      const fd = fs.openSync(scriptPath, 'r');
      try {
        const buf = Buffer.alloc(Math.min(size, SCRIPT_MAX_BYTES));
        fs.readSync(fd, buf, 0, buf.length, 0);
        return {
          name,
          exists: true,
          hostPath: scriptPath,
          size,
          truncated,
          content: buf.toString('utf8'),
        };
      } finally {
        fs.closeSync(fd);
      }
    },
  );

  app.get<{ Params: Params }>('/api/stage/:name', async (req, reply) => {
    const project = projectState.current;
    if (!project) return reply.code(400).send({ error: 'No project loaded.' });
    const { name } = req.params;
    const snap = project.current();

    const stages: PipelineStage[] = [
      ...(snap.pipeline?.stages ?? []),
      ...(snap.state?.insertedStages ?? []),
    ];
    const config = stages.find((s) => s.name === name) ?? null;

    const logsDir = path.join(project.artDir, '.state', 'logs');
    const pipelineLog = findLatestPipelineLogFile(logsDir);
    const nodeLogContext = buildNodeLogContext(snap.pipeline, snap.state);
    const pipelineNodeTail = pipelineLog
      ? tailNodeLogLines(pipelineLog, name, nodeLogContext, TAIL_LINES)
      : [];
    const transcriptTail = tailStageClaudeTranscriptLines(
      project.artDir,
      name,
      TRANSCRIPT_TAIL_LINES,
    );
    const nodeTail = [...transcriptTail, ...pipelineNodeTail];
    const stageTail = nodeTail.map((line) => line.line);

    const containerLogs = findContainerLogs(logsDir, name, 3).map((p) => ({
      file: path.basename(p),
      tail: tailLog(p, TAIL_LINES).join('\n'),
    }));

    const runStage = snap.latestRun?.stages?.find((s) => s.name === name) ?? null;

    return {
      name,
      config,
      runtime: {
        currentStage: snap.state?.currentStage ?? null,
        completed: snap.state?.completedStages?.includes(name) ?? false,
        runStatus: snap.state?.status ?? null,
        runStage,
        latestRun: snap.latestRun
          ? {
              runId: snap.latestRun.runId,
              status: snap.latestRun.status,
              startTime: snap.latestRun.startTime,
              endTime: snap.latestRun.endTime,
            }
          : null,
      },
      logs: {
        pipelineLogFile: pipelineLog ? path.basename(pipelineLog) : null,
        nodeLogFile: pipelineLog ? path.basename(pipelineLog) : null,
        nodeTail,
        pipelineTail: stageTail,
        containerLogs,
      },
      transitions: config?.transitions ?? [],
    };
  });
}
