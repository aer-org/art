/**
 * Minimal pipeline execution engine for `art run`.
 * Replaces the full channel-based engine (index.ts) with only what's needed
 * to run pipelines in containers.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ChildProcess, execSync, spawnSync } from 'child_process';

import { setCodexAuthProxyPort, setCredentialProxyPort } from './config.js';
import { startCodexAuthProxy } from './codex-auth-proxy.js';
import { startCredentialProxy } from './credential-proxy.js';
import {
  ensureContainerRuntimeRunning,
  getProxyBindHost,
  initRuntime,
} from './container-runtime.js';
import {
  loadPipelineConfig,
  pipelineTagFromPath,
  PipelineRunner,
} from './pipeline-runner.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

function resolveProvider(): 'claude' | 'codex' {
  return process.env.ART_AGENT_PROVIDER === 'codex' ? 'codex' : 'claude';
}

function resolveCodexAuthMode(): 'passthrough' | 'host-managed' {
  return process.env.ART_CODEX_AUTH_MODE === 'host-managed'
    ? 'host-managed'
    : 'passthrough';
}

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

  let pipelineConfig = loadPipelineConfig(group.folder, undefined, pipeline);
  if (!pipelineConfig) {
    console.error(`No ${pipeline ?? 'PIPELINE.json'} found`);
    proxyServer?.close();
    process.exit(1);
  }

  // Resolve registry agent refs (stage.agent = "name:tag") → populate prompt,
  // mcp, and — if the agent points at a dockerfile — build a locally-canonical
  // image tag so independent machines converge on the same image name.
  const stagesWithRefs = pipelineConfig.stages.filter((s) => s.agent);
  if (stagesWithRefs.length > 0) {
    const { RegistryClient, loadCredentials, canonicalImageTag } =
      await import('./registry-client.js');
    const creds = loadCredentials();
    if (!creds) {
      console.error(
        "Pipeline references registry agents but no credentials found. Run 'art login'.",
      );
      proxyServer?.close();
      codexAuthProxyServer?.close();
      process.exit(1);
    }
    const client = new RegistryClient(creds);
    const runtimeBin = (await import('./container-runtime.js')).getRuntime()
      .bin;
    const buildRoot = path.join(os.homedir(), '.cache', 'aer-art', 'builds');

    for (const stage of stagesWithRefs) {
      const ref = stage.agent!;
      try {
        const { hash, version } = await client.resolveAndFetchAgent(ref);
        if (!stage.prompt) stage.prompt = version.system_prompt;
        if (!stage.mcpAccess && version.mcp_tools.length > 0) {
          stage.mcpAccess = version.mcp_tools;
        }

        if (version.dockerfile_hash && version.dockerfile_image_name) {
          const df = await client.fetchDockerfileVersion(
            version.dockerfile_hash,
          );
          const imageTag = canonicalImageTag(df.image_name, df.content_hash);

          const inspect = spawnSync(
            runtimeBin,
            ['image', 'inspect', imageTag],
            {
              stdio: 'pipe',
            },
          );
          if (inspect.status !== 0) {
            const shortHash = df.content_hash
              .replace('sha256:', '')
              .slice(0, 12);
            const buildDir = path.join(buildRoot, shortHash);
            fs.mkdirSync(buildDir, { recursive: true });
            fs.writeFileSync(path.join(buildDir, 'Dockerfile'), df.content);
            console.log(`Building ${imageTag}…`);
            execSync(`${runtimeBin} build -t ${imageTag} ${buildDir}`, {
              stdio: 'inherit',
            });
          }
          if (!stage.image) stage.image = imageTag;
        }

        logger.info(
          {
            stage: stage.name,
            ref,
            hash,
            dockerfile_hash: version.dockerfile_hash,
            image: stage.image,
          },
          'Resolved registry agent',
        );
        console.log(
          `Resolved ${stage.name}: ${ref} → ${hash.slice(0, 19)}…${
            stage.image ? ` (image: ${stage.image})` : ''
          }`,
        );
      } catch (e) {
        console.error(
          `Failed to resolve '${ref}' for stage '${stage.name}': ${(e as Error).message}`,
        );
        proxyServer?.close();
        codexAuthProxyServer?.close();
        process.exit(1);
      }
    }
  }

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

  const bundleDir = pipeline ? path.dirname(path.resolve(pipeline)) : artDir;
  const runner = new PipelineRunner(
    group,
    chatJid,
    pipelineConfig,
    notify,
    onProcess,
    undefined,
    runId,
    pipelineTagFromPath(pipeline),
    undefined,
    bundleDir,
  );
  activeRunners.push(runner);
  const result = await runner.run();

  proxyServer?.close();
  codexAuthProxyServer?.close();
  process.exit(result === 'success' ? 0 : 1);
}
