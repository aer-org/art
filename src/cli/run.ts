import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import { ensureAuth, hasCodexCliAuth } from './auth.js';
import { setupEngine } from './engine-setup.js';

function resolveProvider(): 'claude' | 'codex' {
  return process.env.ART_AGENT_PROVIDER === 'claude' ? 'claude' : 'codex';
}

/** Parse ART_DIFF_SIZE_LIMIT (e.g. "1G", "500M", "2GiB") → bytes. */
function parseSizeLimit(): number {
  const raw = process.env.ART_DIFF_SIZE_LIMIT ?? '1G';
  const m = /^(\d+(?:\.\d+)?)\s*([KMGT]i?)?B?$/i.exec(raw.trim());
  if (!m) return 1 << 30; // 1 GiB default on parse error
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toUpperCase();
  const map: Record<string, number> = {
    '': 1,
    K: 1024,
    KI: 1024,
    M: 1024 ** 2,
    MI: 1024 ** 2,
    G: 1024 ** 3,
    GI: 1024 ** 3,
    T: 1024 ** 4,
    TI: 1024 ** 4,
  };
  return Math.floor(n * (map[unit] ?? 1));
}

async function runArtifactDiffSizeGate(
  artDir: string,
  assumeYes: boolean,
  pipelineOverride?: string,
): Promise<void> {
  const limit = parseSizeLimit();
  const { dirSizeBytes, classifyDiffMounts } = await import('../run-diff.js');

  const pipelinePath = pipelineOverride ?? path.join(artDir, 'PIPELINE.json');
  let stages: {
    name?: string;
    mounts?: Record<string, 'ro' | 'rw' | null | undefined>;
  }[] = [];
  try {
    const raw = fs.readFileSync(pipelinePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.stages)) stages = parsed.stages;
  } catch {
    return; // pipeline missing/invalid — the runner will surface the real error
  }

  // Per-stage classification: which rw mounts we'd snapshot, which we skip.
  // Aggregate keys uniquely for the size probe + skip-warning list.
  const rwHostPaths = new Map<string, string>(); // diff name → hostPath
  const skips = new Map<string, { stages: string[]; reason: string }>();
  for (const s of stages) {
    const { resolved, skipped } = classifyDiffMounts(s.mounts ?? {}, artDir);
    for (const r of resolved) rwHostPaths.set(r.name, r.hostPath);
    for (const k of skipped) {
      const entry = skips.get(k.key) ?? { stages: [], reason: k.reason };
      entry.stages.push(s.name ?? '<unnamed>');
      skips.set(k.key, entry);
    }
  }

  const oversized: { name: string; bytes: number }[] = [];
  for (const [name, hostPath] of rwHostPaths) {
    const bytes = dirSizeBytes(hostPath);
    if (bytes > limit) oversized.push({ name, bytes });
  }

  if (oversized.length === 0 && skips.size === 0) return;

  const fmt = (b: number): string =>
    b >= 1 << 30
      ? `${(b / (1 << 30)).toFixed(2)} GB`
      : b >= 1 << 20
        ? `${(b / (1 << 20)).toFixed(1)} MB`
        : `${b} B`;

  for (const m of oversized) {
    console.error(
      `Warning: rw mount '${m.name}' is ${fmt(m.bytes)}. Preserving pre-state for diff will use roughly the same temporary disk space per stage. Pass --no-diff to disable.`,
    );
  }
  for (const [key, info] of skips) {
    const stagesList =
      info.stages.length > 3
        ? `${info.stages.slice(0, 3).join(', ')}, +${info.stages.length - 3} more`
        : info.stages.join(', ');
    console.error(
      `Warning: rw mount '${key}' will not be diff-captured (${info.reason}). Stages: ${stagesList}.`,
    );
  }

  if (assumeYes || process.env.CI || !process.stdin.isTTY) return;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise<string>((resolve) =>
    rl.question('Continue? [y/N] ', resolve),
  );
  rl.close();
  if (answer.trim().toLowerCase() !== 'y') {
    console.error('Aborted.');
    process.exit(1);
  }
}

function preflight(opts?: { skipProviderCli?: boolean }): void {
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

  if (!opts?.skipProviderCli) {
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

/**
 * Resolve the --pipeline argument to an absolute pipeline JSON path.
 * Accepts: an existing path (absolute or relative to cwd), or a bare name
 * resolved against `<artDir>/pipelines/<name>` then `<artDir>/<name>`, trying
 * both as-given and with a `.json` suffix. Returns undefined when no pipeline
 * was requested. Exits with a clear error when the requested file is missing.
 */
function resolvePipelinePath(
  artDir: string,
  pipeline: string | undefined,
): string | undefined {
  if (!pipeline) return undefined;
  const candidates: string[] = [];
  const withJson = (p: string) =>
    p.endsWith('.json') ? [p] : [p, `${p}.json`];
  // Explicit path (absolute or relative to cwd)
  if (pipeline.includes('/') || path.isAbsolute(pipeline)) {
    candidates.push(...withJson(path.resolve(pipeline)));
  } else {
    // Bare name: look in __art__/pipelines first, then __art__ itself.
    candidates.push(...withJson(path.join(artDir, 'pipelines', pipeline)));
    candidates.push(...withJson(path.join(artDir, pipeline)));
  }
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) {
    console.error(
      `Pipeline "${pipeline}" not found. Looked for:\n` +
        candidates.map((c) => `  - ${c}`).join('\n'),
    );
    process.exit(1);
  }
  return found;
}

export async function run(
  targetDir: string,
  opts?: {
    skipPreflight?: boolean;
    stage?: string;
    assumeYes?: boolean;
    pipeline?: string;
  },
): Promise<void> {
  preflight({ skipProviderCli: opts?.skipPreflight });

  const projectDir = path.resolve(targetDir);
  const artDirName = '__art__';
  const artDir = path.join(projectDir, artDirName);

  if (!fs.existsSync(artDir)) {
    console.error(
      `No ${artDirName}/ found in ${projectDir}. Run 'art init .' first.`,
    );
    process.exit(1);
  }

  // Resolve an alternative pipeline if --pipeline was given. undefined means
  // the default __art__/PIPELINE.json is used everywhere downstream.
  const pipelinePath = resolvePipelinePath(artDir, opts?.pipeline);
  if (pipelinePath) {
    console.log(`Using pipeline: ${pipelinePath}`);
  }

  // L1 artifact-diff size gate. We snapshot rw mounts via hardlink-copy
  // before each stage; the temporary space is roughly the modified
  // portion. For mounts that are already very large (multi-GB), warn the
  // user before stage 0 starts so the disk cost isn't a surprise mid-run.
  // Skip entirely if --no-diff is set or no rw mounts are huge.
  if (process.env.ART_NO_DIFF !== '1') {
    await runArtifactDiffSizeGate(artDir, !!opts?.assumeYes, pipelinePath);
  }

  const { generateRunId } = await import('../run-manifest.js');

  // Generate run ID for this execution
  const runId = generateRunId();

  // Ensure provider authentication is available (before any engine imports)
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
    pipelinePath,
  });

  // Pre-pull missing pipeline stage images
  const { loadPipelineConfig } = await import('../pipeline-runner.js');
  type PipelineStage = import('../pipeline-runner.js').PipelineStage;
  const { loadPipelineTemplate } = await import('../pipeline-template.js');
  const { getRuntime } = await import('../container-runtime.js');
  const { CONTAINER_IMAGE } = await import('../config.js');
  const { getImageForStage, loadImageRegistry, saveImageRegistry } =
    await import('../image-registry.js');
  const { contentHash: computeHash } = await import('../bundle.js');

  const bundleDir = artDir;
  const pipelineConfig = loadPipelineConfig('', artDir, pipelinePath);
  if (pipelineConfig) {
    const rt = getRuntime();
    const registry = loadImageRegistry();
    const dockerfilesDir = path.join(artDir, 'dockerfiles');

    // Collect ALL stages: pipeline + all referenced templates (recursive)
    const allStages: PipelineStage[] = [...pipelineConfig.stages];
    const visitedTemplates = new Set<string>();

    function collectTemplateStages(stages: PipelineStage[]) {
      for (const stage of stages) {
        for (const t of stage.transitions) {
          if (t.template && !visitedTemplates.has(t.template)) {
            visitedTemplates.add(t.template);
            try {
              const tpl = loadPipelineTemplate(bundleDir, t.template);
              allStages.push(...tpl.stages);
              collectTemplateStages(tpl.stages);
            } catch {
              // Template not found — will error at runtime
            }
          }
        }
      }
    }
    collectTemplateStages(pipelineConfig.stages);

    // Phase 1: Resolve images — build from local Dockerfiles or check registry
    const images = new Set<string>();
    const checked = new Set<string>(); // dedupe by image name

    for (const stage of allStages) {
      const imageName = stage.image;
      const dedupeKey = imageName ?? '__default__';
      if (checked.has(dedupeKey)) continue;
      checked.add(dedupeKey);

      if (stage.command) {
        images.add(imageName || CONTAINER_IMAGE);
        continue;
      }

      // Agent stage: check images.json first
      if (!imageName || registry[imageName]) {
        try {
          images.add(getImageForStage(imageName, false));
        } catch {
          if (imageName) images.add(imageName);
        }
        continue;
      }

      // Not in images.json — check local Dockerfile
      const dockerfilePath = path.join(
        dockerfilesDir,
        `${imageName}.Dockerfile`,
      );
      if (fs.existsSync(dockerfilePath)) {
        const content = fs.readFileSync(dockerfilePath, 'utf-8');
        const hash = computeHash(content);

        // Check if already built with same content (re-read in case of stale ref)
        const existing = loadImageRegistry()[imageName];
        if (existing?.contentHash === hash) {
          images.add(existing.image);
          continue;
        }

        const imageTag = `art-${imageName}:${hash.slice(7, 19)}`;
        console.log(
          `\n  Image "${imageName}" needs to be built from Dockerfile.`,
        );
        console.log(`    Source: dockerfiles/${imageName}.Dockerfile`);
        console.log(`    Tag:    ${imageTag}`);
        const confirmed = await askConfirmation('  Build now? [Y/n] ');
        if (!confirmed) {
          console.error(
            `\n  ✗ Image "${imageName}" is required but not built. Aborting.`,
          );
          process.exit(1);
        }

        console.log(`\n  Building ${imageTag}...`);
        execSync(
          `${rt.bin} build -t ${imageTag} -f ${dockerfilePath} ${artDir}`,
          { stdio: 'inherit', timeout: 600000 },
        );

        registry[imageName] = {
          image: imageTag,
          hasAgent: true,
          contentHash: hash,
        };
        saveImageRegistry(registry);
        images.add(imageTag);
        continue;
      }

      // No local Dockerfile — agent images must be built from a local Dockerfile.
      console.error(
        `\n  ✗ Image "${imageName}" is not available locally and no Dockerfile was found at __art__/dockerfiles/${imageName}.Dockerfile.`,
      );
      console.error(
        `    Add a Dockerfile at that path or use a pre-built image name resolvable by the container runtime.`,
      );
      process.exit(1);
    }

    // Phase 2: Pre-pull missing Docker images (Hub images + command stage images)
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

  // Signal cancellation: PipelineRunner.abort() finalizes the recorder, which
  // writes summary.json + sealed marker. No manifest write here anymore.

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
    pipelinePath,
  });
}
