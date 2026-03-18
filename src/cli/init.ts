import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import { ART_DIR_NAME, CONTAINER_IMAGE } from '../config.js';
import { loadImageRegistry, saveImageRegistry } from '../image-registry.js';
import { STAGE_TEMPLATES } from '../stage-templates.js';
import { ensureAuth } from './auth.js';
import { startEditorServer } from './compose.js';

const DEFAULT_TEMPLATE_NAMES = ['build', 'test', 'review', 'history'];

interface Stage {
  name: string;
  prompt: string;
  mounts: Record<string, string | null>;
  transitions: Array<{ marker: string; next: string | null }>;
}

function buildStages(): Stage[] {
  const stages = DEFAULT_TEMPLATE_NAMES.map((name) => {
    const t = STAGE_TEMPLATES[name];
    return {
      name: t.name,
      prompt: t.prompt,
      mounts: { ...t.mounts },
      transitions: [...t.transitions],
    };
  });

  // Wire up transitions: each stage completes to the next
  for (let i = 0; i < stages.length; i++) {
    const nextName = i < stages.length - 1 ? stages[i + 1].name : null;
    const completeTransition = stages[i].transitions.find(
      (t) => t.marker === '[STAGE_COMPLETE]',
    );
    if (completeTransition && nextName) {
      completeTransition.next = nextName;
    }
  }

  return stages;
}

export async function init(targetDir: string): Promise<void> {
  const projectDir = path.resolve(targetDir);
  const artDir = path.join(projectDir, ART_DIR_NAME);

  if (fs.existsSync(artDir)) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await new Promise<string>((resolve) =>
      rl.question(
        `${ART_DIR_NAME}/ already exists. Remove and re-initialize? (y/N): `,
        resolve,
      ),
    );
    rl.close();
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }
    fs.rmSync(artDir, { recursive: true, force: true });
  }

  console.log(`\nSetting up ${ART_DIR_NAME}/ in ${projectDir}\n`);

  // Create directory structure
  fs.mkdirSync(artDir, { recursive: true });

  // Plan
  fs.mkdirSync(path.join(artDir, 'plan'), { recursive: true });
  fs.writeFileSync(
    path.join(artDir, 'plan', 'PLAN.md'),
    '# Plan\n\nDescribe what you want the agents to build.\n',
  );

  // Source
  fs.mkdirSync(path.join(artDir, 'src'), { recursive: true });

  // Logs
  fs.mkdirSync(path.join(artDir, 'logs'), { recursive: true });

  // Metrics / Insights / Memory (for review & history stages)
  fs.mkdirSync(path.join(artDir, 'metrics'), { recursive: true });
  fs.mkdirSync(path.join(artDir, 'insights'), { recursive: true });
  fs.mkdirSync(path.join(artDir, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(artDir, 'outputs'), { recursive: true });
  fs.mkdirSync(path.join(artDir, 'tests'), { recursive: true });

  // CLAUDE.md
  fs.writeFileSync(
    path.join(artDir, 'CLAUDE.md'),
    '# Project Context\n\nDescribe your project here. Agents will read this for context.\n',
  );

  // Pipeline
  const stages = buildStages();
  const pipeline = {
    stages,
    entryStage: stages[0]?.name,
    errorPolicy: {
      maxConsecutive: 3,
      debugOnMaxErrors: true,
    },
  };
  fs.writeFileSync(
    path.join(artDir, 'PIPELINE.json'),
    JSON.stringify(pipeline, null, 2) + '\n',
  );

  // Create any additional stage mount directories
  for (const stage of stages) {
    for (const [dir, perm] of Object.entries(stage.mounts)) {
      if (perm !== null) {
        fs.mkdirSync(path.join(artDir, dir), { recursive: true });
      }
    }
  }

  // .gitignore
  fs.writeFileSync(
    path.join(artDir, '.gitignore'),
    'logs/\nsessions/\nPIPELINE_STATE.json\n',
  );

  console.log(`  ${ART_DIR_NAME}/ created with default pipeline.`);
  console.log(`  Pipeline: ${stages.map((s) => s.name).join(' → ')}\n`);

  // Ensure default image is registered
  const registry = loadImageRegistry();
  if (!registry['default']) {
    registry['default'] = {
      image: CONTAINER_IMAGE,
      hasAgent: true,
    };
    saveImageRegistry(registry);
  }

  // Ensure Claude authentication before launching editor
  await ensureAuth();

  // Set TUI env vars early so logger routes to file before any engine import
  process.env.ART_TUI_MODE = 'true';
  process.env.ART_TUI_LOG_DIR = path.join(artDir, 'logs');

  // Setup engine for container agent
  const { setupEngine } = await import('./engine-setup.js');
  const { engineRoot, runtimeBin } = await setupEngine({ projectDir, artDir });

  // Ensure default agent container image exists; prompt to build if missing
  let hasDefaultImage = false;
  try {
    execSync(`${runtimeBin} image inspect ${CONTAINER_IMAGE}`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    hasDefaultImage = true;
  } catch {
    // image not found
  }

  if (!hasDefaultImage) {
    const rl2 = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = process.stdin.isTTY
      ? await new Promise<string>((resolve) =>
          rl2.question(
            `\nAgent 컨테이너 이미지를 빌드하시겠습니까? (${CONTAINER_IMAGE}) (y/N): `,
            resolve,
          ),
        )
      : 'y';
    rl2.close();

    if (answer.trim().toLowerCase() === 'y') {
      const scriptDir = path.resolve(engineRoot, 'container');
      console.log(`\n빌드 중: ${CONTAINER_IMAGE}...`);
      execSync(`${scriptDir}/build.sh`, {
        stdio: 'inherit',
        timeout: 600000,
        env: { ...process.env, CONTAINER_RUNTIME: runtimeBin },
      });
    }
  }

  // Launch GUI editor with container agent onboarding
  await startEditorServer(artDir, 'init', projectDir);
}
