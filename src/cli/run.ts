import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import { ensureAuth } from './auth.js';
import { setupEngine } from './engine-setup.js';

function preflight(opts?: { skipClaudeCli?: boolean }): void {
  const errors: string[] = [];

  // Node.js version
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 20) {
    errors.push(
      `Node.js 20+ required (current: ${process.versions.node}). https://nodejs.org`,
    );
  }

  // Container runtime (docker, podman, or udocker)
  let hasRuntime = false;
  for (const cmd of ['docker', 'podman', 'udocker']) {
    try {
      const checkCmd = cmd === 'udocker' ? `${cmd} version` : `${cmd} info`;
      execSync(checkCmd, { stdio: 'pipe', timeout: 10000 });
      hasRuntime = true;
      break;
    } catch {
      // try next
    }
  }
  if (!hasRuntime) {
    errors.push(
      'No container runtime found. Install Docker, Podman, or udocker.',
    );
  }

  // Claude CLI (skippable for command-mode-only pipelines)
  if (!opts?.skipClaudeCli) {
    try {
      execSync('claude --version', { stdio: 'pipe', timeout: 5000 });
    } catch {
      errors.push(
        'Claude CLI not found. Run: npm install -g @anthropic-ai/claude-code',
      );
    }
  }

  if (errors.length > 0) {
    console.error('Preflight check failed:\n');
    for (const err of errors) {
      console.error(`  ✗ ${err}`);
    }
    console.error();
    process.exit(1);
  }
}

async function askConfirmation(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return true;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise<string>((resolve) =>
    rl.question(prompt, resolve),
  );
  rl.close();
  const trimmed = answer.trim().toLowerCase();
  return trimmed === '' || trimmed === 'y' || trimmed === 'yes';
}

export async function run(
  targetDir: string,
  opts?: { skipPreflight?: boolean; stage?: string },
): Promise<void> {
  preflight({ skipClaudeCli: opts?.skipPreflight });

  const projectDir = path.resolve(targetDir);
  const artDirName = '__art__';
  const artDir = path.join(projectDir, artDirName);

  if (!fs.existsSync(artDir)) {
    console.error(
      `No ${artDirName}/ found in ${projectDir}. Run 'art compose .' first.`,
    );
    process.exit(1);
  }

  // Set TUI env vars before any engine import so logger routes to file
  process.env.ART_TUI_MODE = 'true';
  process.env.ART_TUI_LOG_DIR = path.join(artDir, 'logs');

  // Check for existing run (_current.json)
  const { readCurrentRun, removeCurrentRun, isPidAlive, generateRunId } =
    await import('../run-manifest.js');
  const { cleanupRunContainers } = await import('../container-runtime.js');

  const currentRun = readCurrentRun(artDir);
  if (currentRun) {
    if (isPidAlive(currentRun.pid)) {
      const confirmed = await askConfirmation(
        `A run is already in progress (${currentRun.runId}, PID ${currentRun.pid}).\nStop and start a new one? [Y/n] `,
      );
      if (!confirmed) {
        console.log('Exiting.');
        process.exit(0);
      }
      // Stop the existing run
      try {
        process.kill(currentRun.pid, 'SIGTERM');
      } catch {
        /* already dead */
      }
      cleanupRunContainers(currentRun.runId);
      removeCurrentRun(artDir);
    } else {
      // PID is dead — orphan cleanup
      console.log(
        `Previous run exited abnormally (${currentRun.runId}, PID ${currentRun.pid}). Cleaning up...`,
      );
      cleanupRunContainers(currentRun.runId);
      removeCurrentRun(artDir);
    }
  }

  // Generate run ID for this execution
  const runId = generateRunId();

  // Ensure Claude authentication is available (before any engine imports)
  if (opts?.skipPreflight) {
    // Set placeholder so credential proxy can start without real auth
    if (!process.env.ANTHROPIC_API_KEY && !process.env._ART_OAUTH_TOKEN) {
      process.env.ANTHROPIC_API_KEY = 'placeholder';
    }
  } else {
    await ensureAuth();
  }

  // Setup engine (paths, runtime, images, IPC dirs)
  const { folderName } = await setupEngine({
    projectDir,
    artDir,
    ensureImages: true,
  });

  // Pre-pull missing pipeline stage images
  const { loadPipelineConfig } = await import('../pipeline-runner.js');
  const { getRuntime } = await import('../container-runtime.js');
  const { CONTAINER_IMAGE } = await import('../config.js');
  const { getImageForStage } = await import('../image-registry.js');

  const pipelineConfig = loadPipelineConfig('', artDir);
  if (pipelineConfig) {
    const rt = getRuntime();
    const images = new Set<string>();
    for (const stage of pipelineConfig.stages) {
      if (stage.command) {
        images.add(stage.image || CONTAINER_IMAGE);
      } else {
        try {
          images.add(getImageForStage(stage.image, false));
        } catch {
          // Registry key not found — treat as direct image name
          if (stage.image) images.add(stage.image);
        }
      }
    }

    const missing: string[] = [];
    for (const img of images) {
      try {
        execSync(`${rt.bin} image inspect ${img}`, {
          stdio: 'pipe',
          timeout: 10000,
        });
      } catch {
        missing.push(img);
      }
    }

    if (missing.length > 0) {
      console.log('\nThe following images are not available locally:');
      for (const img of missing) console.log(`  - ${img}`);
      const confirmed = await askConfirmation(
        'Pull them now? [Y/n] ',
      );
      if (confirmed) {
        for (const img of missing) {
          console.log(`\nPulling ${img}...`);
          execSync(`${rt.bin} pull ${img}`, {
            stdio: 'inherit',
            timeout: 600000,
          });
        }
      }
    }
  }

  // Import manifest functions ahead of signal handler registration
  const { readRunManifest, writeRunManifest } =
    await import('../run-manifest.js');

  // Register SIGINT/SIGTERM handlers to clean up _current.json
  const cleanupOnSignal = () => {
    try {
      const manifest = readRunManifest(artDir, runId);
      if (manifest) {
        manifest.endTime = new Date().toISOString();
        manifest.status = 'cancelled';
        writeRunManifest(artDir, manifest);
      }
    } catch {
      /* best effort */
    }
    removeCurrentRun(artDir);
  };
  process.on('SIGINT', cleanupOnSignal);
  process.on('SIGTERM', cleanupOnSignal);

  const artGroup = {
    name: 'art',
    folder: folderName,
    trigger: '',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    isMain: true,
    containerConfig: {},
  };

  // Import and run the pipeline engine
  const { runPipeline } = await import('../run-engine.js');
  await runPipeline({ group: artGroup, runId, artDir, stage: opts?.stage });
}
