/**
 * Minimal pipeline execution engine for `art run`.
 * Replaces the full channel-based engine (index.ts) with only what's needed
 * to run pipelines in containers.
 */
import fs from 'fs';
import path from 'path';
import { ChildProcess } from 'child_process';

import { getCredentialProxyPort, setCredentialProxyPort } from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import {
  ensureContainerRuntimeRunning,
  getProxyBindHost,
  initRuntime,
} from './container-runtime.js';
import {
  loadAgentTeamConfig,
  loadPipelineConfig,
  PipelineRunner,
} from './pipeline-runner.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export async function runPipeline(opts: {
  group: RegisteredGroup;
  runId: string;
  artDir: string;
  stage?: string;
  pipeline?: string;
}): Promise<void> {
  const { group, runId, artDir, stage, pipeline } = opts;

  // Initialize container runtime
  await initRuntime();
  ensureContainerRuntimeRunning();

  // Create group folder
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Start credential proxy
  const { server: proxyServer, port: proxyPort } = await startCredentialProxy(
    0,
    getProxyBindHost(),
  );
  setCredentialProxyPort(proxyPort);

  // Graceful shutdown
  let shuttingDown = false;
  const activeRunners: PipelineRunner[] = [];
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received');
    await Promise.allSettled(activeRunners.map((r) => r.abort()));
    try {
      const { cleanupRunContainers } = await import('./container-runtime.js');
      cleanupRunContainers(runId);
    } catch {
      /* best effort */
    }
    proxyServer.close();
    process.exit(1);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Dummy chatJid for pipeline (not used for messaging)
  const chatJid = process.env.ART_TUI_JID || `art://pipeline`;

  // Track spawned processes for cleanup
  const onProcess = (_proc: ChildProcess, _containerName: string) => {
    // Container lifecycle managed by PipelineRunner
  };

  const notify = async (text: string) => {
    console.log(text);
  };

  // Team pipeline mode
  const teamConfig = loadAgentTeamConfig(group.folder);
  if (teamConfig) {
    const parentGroupDir = resolveGroupFolderPath(group.folder);
    logger.info(
      { agentCount: teamConfig.agents.length },
      'Agent team pipeline mode',
    );

    const results = await Promise.all(
      teamConfig.agents.map(async (agent) => {
        const agentGroupDir = path.join(parentGroupDir, agent.folder);
        const pipelineConfig = loadPipelineConfig(group.folder, agentGroupDir);
        if (!pipelineConfig) {
          console.log(`⚠️ ${agent.name}: PIPELINE.json not found`);
          return 'error' as const;
        }

        const virtualGroup: RegisteredGroup = {
          ...group,
          name: `team-${agent.name}`,
          folder: `${group.folder}__team_${agent.folder}`,
        };

        const runner = new PipelineRunner(
          virtualGroup,
          chatJid,
          pipelineConfig,
          async (text) => console.log(`[${agent.name}] ${text}`),
          onProcess,
          agentGroupDir,
          runId,
        );
        activeRunners.push(runner);
        return runner.run();
      }),
    );

    const allSuccess = results.every((r) => r === 'success');
    proxyServer.close();
    process.exit(allSuccess ? 0 : 1);
  }

  // Single pipeline mode
  let pipelineConfig = loadPipelineConfig(group.folder, undefined, pipeline);
  if (!pipelineConfig) {
    console.error(`No ${pipeline ?? 'PIPELINE.json'} found`);
    proxyServer.close();
    process.exit(1);
  }

  // --stage: run a single stage in isolation
  if (stage) {
    const stageConfig = pipelineConfig.stages.find((s) => s.name === stage);
    if (!stageConfig) {
      console.error(
        `Stage "${stage}" not found. Available: ${pipelineConfig.stages.map((s) => s.name).join(', ')}`,
      );
      proxyServer.close();
      process.exit(1);
    }
    // Replace transitions so the stage terminates on completion
    const isolatedStage = {
      ...stageConfig,
      transitions: stageConfig.command
        ? [
            { marker: 'STAGE_COMPLETE', next: null },
            { marker: 'STAGE_ERROR', next: null },
          ]
        : [
            { marker: 'STAGE_COMPLETE', next: null, prompt: 'Stage completed' },
            { marker: 'STAGE_ERROR', retry: true, prompt: 'Recoverable error' },
          ],
    };
    pipelineConfig = { stages: [isolatedStage] };
    console.log(`\n🔧 Running single stage: ${stage}`);
  }

  logger.info({ stageCount: pipelineConfig.stages.length }, 'Pipeline mode');

  const runner = new PipelineRunner(
    group,
    chatJid,
    pipelineConfig,
    notify,
    onProcess,
    undefined,
    runId,
  );
  activeRunners.push(runner);
  const result = await runner.run();

  proxyServer.close();
  process.exit(result === 'success' ? 0 : 1);
}
