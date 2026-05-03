import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';

import { ART_BIN, ART_DIR_NAME, childProcessEnv } from '../config.ts';
import { projectState } from '../project-state.ts';
import { buildGraph } from '../pipeline-graph.ts';
import { runController } from '../run-controller.ts';

interface LoadBody {
  path: string;
}

const execFileP = promisify(execFile);
const RUN_STARTING_CLOCK_SKEW_MS = 1000;

function stateCatchesRunStart(
  state: { lastUpdated?: unknown } | null | undefined,
  startedAt: number,
): boolean {
  if (typeof state?.lastUpdated !== 'string') return false;
  const updatedAt = Date.parse(state.lastUpdated);
  return Number.isFinite(updatedAt) && updatedAt >= startedAt - RUN_STARTING_CLOCK_SKEW_MS;
}

function snapshotResponse(projectDir: string, initialized: boolean) {
  const project = projectState.current;
  const snap = project?.projectDir === projectDir ? project.current() : null;
  const activeRun = project && snap
    ? runController.activeRunInfo(project.projectDir, snap.latestRun)
    : null;
  const runStarting = project && snap && !activeRun
    ? runController.runStartingInfo(project.projectDir)
    : null;
  const isRunning = activeRun !== null;
  const isRunStarting =
    runStarting !== null && !stateCatchesRunStart(snap?.state, runStarting.startedAt);
  return {
    projectDir,
    initialized,
    pipeline: snap?.pipeline,
    pipelineError: snap?.pipelineError,
    state: snap?.state,
    latestRun: snap?.latestRun,
    graph: buildGraph(snap?.pipeline ?? null, snap?.state ?? null, {
      isRunning,
      isRunStarting,
      activeRunStartedAt: activeRun?.startedAt ?? (isRunStarting ? runStarting?.startedAt : null) ?? null,
    }),
    isRunning,
    isRunStarting,
  };
}

async function ensureInitialized(projectDir: string, pipelinePath: string): Promise<boolean> {
  if (fs.existsSync(pipelinePath)) return false;

  try {
    await execFileP(ART_BIN, ['init', projectDir], {
      cwd: projectDir,
      env: childProcessEnv(),
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const detail = err.stderr?.trim() || err.stdout?.trim() || err.message;
    throw new Error(`Failed to initialize __art__ in ${projectDir}: ${detail}`);
  }

  if (!fs.existsSync(pipelinePath)) {
    throw new Error(`art init completed but did not create ${pipelinePath}`);
  }
  return true;
}

export function registerLoadRoutes(app: FastifyInstance): void {
  app.post<{ Body: LoadBody }>('/api/load', async (req, reply) => {
    const dir = req.body?.path;
    if (!dir || typeof dir !== 'string') return reply.code(400).send({ error: 'path required' });
    const requested = path.resolve(dir);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(requested);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    if (!stat.isDirectory()) return reply.code(400).send({ error: `${requested} is not a directory` });

    const abs = fs.realpathSync(requested);

    const pipelinePath = path.join(abs, ART_DIR_NAME, 'PIPELINE.json');
    let initialized = false;
    try {
      initialized = await ensureInitialized(abs, pipelinePath);
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }

    const project = await projectState.load(abs);
    const snap = project.current();
    const activeRun = runController.activeRunInfo(project.projectDir, snap.latestRun);
    const runStarting = activeRun
      ? null
      : runController.runStartingInfo(project.projectDir);
    const isRunning = activeRun !== null;
    const isRunStarting =
      runStarting !== null && !stateCatchesRunStart(snap.state, runStarting.startedAt);
    return {
      projectDir: abs,
      initialized,
      pipeline: snap.pipeline,
      pipelineError: snap.pipelineError,
      state: snap.state,
      latestRun: snap.latestRun,
      graph: buildGraph(snap.pipeline, snap.state, {
        isRunning,
        isRunStarting,
        activeRunStartedAt: activeRun?.startedAt ?? (isRunStarting ? runStarting?.startedAt : null) ?? null,
      }),
      isRunning,
      isRunStarting,
    };
  });

  app.get('/api/current', async () => {
    const project = projectState.current;
    if (!project) return { projectDir: null };
    return snapshotResponse(project.projectDir, false);
  });
}
