import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import { ensureAuth, hasCodexCliAuth } from './auth.js';
import { setupEngine } from './engine-setup.js';

function resolveProvider(): 'claude' | 'codex' {
  return process.env.ART_AGENT_PROVIDER === 'codex' ? 'codex' : 'claude';
}

function preflight(opts?: { skipClaudeCli?: boolean }): void {
  const errors: string[] = [];
  const provider = resolveProvider();

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

  if (!opts?.skipClaudeCli) {
    if (provider === 'codex') {
      try {
        execSync('codex --version', { stdio: 'pipe', timeout: 5000 });
      } catch {
        errors.push('Codex CLI not found. Run: npm install -g @openai/codex');
      }
      if (!hasCodexCliAuth()) {
        errors.push(
          'Codex auth not found. Log in with Codex on the host first.',
        );
      }
    } else {
      try {
        execSync('claude --version', { stdio: 'pipe', timeout: 5000 });
      } catch {
        errors.push(
          'Claude CLI not found. Run: npm install -g @anthropic-ai/claude-code',
        );
      }
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
  opts?: { skipPreflight?: boolean; stage?: string; pipeline?: string },
): Promise<void> {
  preflight({ skipClaudeCli: opts?.skipPreflight });

  const projectDir = path.resolve(targetDir);
  const artDirName = '__art__';
  const artDir = path.join(projectDir, artDirName);

  if (!fs.existsSync(artDir)) {
    console.error(
      `No ${artDirName}/ found in ${projectDir}. Run 'art init .' first.`,
    );
    process.exit(1);
  }

  // Set TUI env vars before any engine import so logger routes to file
  process.env.ART_TUI_MODE = 'true';
  process.env.ART_TUI_LOG_DIR = path.join(artDir, 'logs');

  const { generateRunId } = await import('../run-manifest.js');

  // Generate run ID for this execution
  const runId = generateRunId();

  // Ensure Claude authentication is available (before any engine imports)
  if (opts?.skipPreflight) {
    // Set placeholder so credential proxy can start without real auth
    if (
      resolveProvider() === 'claude' &&
      !process.env.ANTHROPIC_API_KEY &&
      !process.env._ART_OAUTH_TOKEN
    ) {
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

  const pipelineOverride = opts?.pipeline
    ? path.resolve(projectDir, opts.pipeline)
    : undefined;
  const pipelineConfig = loadPipelineConfig('', artDir, pipelineOverride);
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
      const confirmed = await askConfirmation('Pull them now? [Y/n] ');
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

  // Register SIGINT/SIGTERM handlers to mark manifest as cancelled
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
  await runPipeline({
    group: artGroup,
    runId,
    artDir,
    stage: opts?.stage,
    pipeline: pipelineOverride,
  });
}
