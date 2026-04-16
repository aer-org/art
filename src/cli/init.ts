import fs from 'fs';
import path from 'path';

import { ART_DIR_NAME } from '../config.js';
import { STAGE_TEMPLATES } from '../stage-templates.js';

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

/** Create __art__/ directory structure, pipeline config, and .gitignore */
export function scaffoldArtDir(projectDir: string): void {
  const artDir = path.join(projectDir, ART_DIR_NAME);

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

  // Pipeline
  const stages = buildStages();
  const pipeline = {
    stages,
    entryStage: stages[0]?.name,
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
    'logs/\nsessions/\nPIPELINE_STATE*.json\n.tmp/\n',
  );

  console.log(`  ${ART_DIR_NAME}/ created with default pipeline.`);
  console.log(`  Pipeline: ${stages.map((s) => s.name).join(' → ')}\n`);
}

export async function init(targetDir: string): Promise<void> {
  const projectDir = path.resolve(targetDir);
  const artDir = path.join(projectDir, ART_DIR_NAME);

  if (fs.existsSync(path.join(artDir, 'PIPELINE.json'))) {
    console.log(`${ART_DIR_NAME}/ already initialized in ${projectDir}`);
    return;
  }

  scaffoldArtDir(projectDir);
}
