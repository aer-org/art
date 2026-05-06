/**
 * Minimal pipeline execution engine for `art run`.
 * Replaces the full channel-based engine (index.ts) with only what's needed
 * to run pipelines in containers.
 */
import fs from 'fs';
import path from 'path';
import { ChildProcess } from 'child_process';

import { setCodexAuthProxyPort, setCredentialProxyPort } from './config.js';
import { startCodexAuthProxy } from './codex-auth-proxy.js';
import { startCredentialProxy } from './credential-proxy.js';
import {
  ensureContainerRuntimeRunning,
  getProxyBindHost,
  initRuntime,
} from './container-runtime.js';
import {
  formatPipelineConfigLoadError,
  getLastPipelineConfigLoadError,
  loadPipelineConfig,
} from './pipeline-config.js';
import { PipelineRunner } from './pipeline-runner.js';
import type {
  PipelineConfig,
  PipelineStage,
  PipelineTransition,
} from './pipeline-types.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

function resolveProvider(): 'claude' | 'codex' {
  return process.env.ART_AGENT_PROVIDER === 'claude' ? 'claude' : 'codex';
}

function resolveCodexAuthMode(): 'passthrough' | 'host-managed' {
  // Host-managed auth requires a container-to-host proxy connection. Default
  // to passthrough so local firewall policy does not block ordinary runs.
  return process.env.ART_CODEX_AUTH_MODE === 'host-managed'
    ? 'host-managed'
    : 'passthrough';
}

export async function runPipeline(opts: {
  group: RegisteredGroup;
  runId: string;
  artDir: string;
  stage?: string;
}): Promise<void> {
  const { group, runId, artDir, stage } = opts;

  // Initialize container runtime
  await initRuntime();
  ensureContainerRuntimeRunning();

  // Create group folder
  const groupDir = resolveGroupFolderPath(group.folder);
  const stateDir = path.join(groupDir, '.state');
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

  const provider = resolveProvider();
  let proxyServer: import('http').Server | null = null;
  let codexAuthProxyServer: import('http').Server | null = null;
  if (provider === 'claude') {
    const { server, port: proxyPort } = await startCredentialProxy(
      0,
      getProxyBindHost(),
    );
    proxyServer = server;
    setCredentialProxyPort(proxyPort);
  } else if (resolveCodexAuthMode() === 'host-managed') {
    const { server, port } = await startCodexAuthProxy(0, getProxyBindHost());
    codexAuthProxyServer = server;
    setCodexAuthProxyPort(port);
  }

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
    proxyServer?.close();
    codexAuthProxyServer?.close();
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

  const loadedConfig = loadPipelineConfig(group.folder);
  if (!loadedConfig) {
    console.error(
      formatPipelineConfigLoadError(
        getLastPipelineConfigLoadError(),
        'PIPELINE.json',
      ),
    );
    proxyServer?.close();
    process.exit(1);
  }
  let pipelineConfig: PipelineConfig = loadedConfig;

  // --stage: run a single stage in isolation
  if (stage) {
    const stageConfig = pipelineConfig.stages.find((s) => s.name === stage);
    if (!stageConfig) {
      console.error(
        `Stage "${stage}" not found. Available: ${pipelineConfig.stages.map((s) => s.name).join(', ')}`,
      );
      proxyServer?.close();
      codexAuthProxyServer?.close();
      process.exit(1);
    }
    // Replace transitions so the stage terminates on completion
    const isolatedTransitions: PipelineTransition[] = stageConfig.command
      ? [
          { marker: 'STAGE_COMPLETE', next: null },
          { marker: 'STAGE_ERROR', next: null },
        ]
      : [
          { marker: 'STAGE_COMPLETE', next: null, prompt: 'Stage completed' },
          {
            marker: 'STAGE_ERROR',
            next: null,
            outcome: 'error',
            prompt: 'Stage failed',
          },
        ];
    const isolatedStage: PipelineStage = {
      ...stageConfig,
      transitions: isolatedTransitions,
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
    undefined,
    artDir,
  );
  activeRunners.push(runner);
  const result = await runner.run();

  proxyServer?.close();
  codexAuthProxyServer?.close();
  process.exit(result === 'success' ? 0 : 1);
}
