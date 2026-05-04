import fs from 'fs';
import path from 'path';

import { ART_DIR_NAME } from '../config.js';

/** Create __art__/ directory structure, pipeline config, and .gitignore */
export function scaffoldArtDir(projectDir: string): void {
  const artDir = path.join(projectDir, ART_DIR_NAME);

  console.log(`\nSetting up ${ART_DIR_NAME}/ in ${projectDir}\n`);

  // Create directory structure
  fs.mkdirSync(artDir, { recursive: true });

  // Authoring directories
  fs.mkdirSync(path.join(artDir, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(artDir, 'templates'), { recursive: true });

  // Pipeline
  const pipeline = {
    stages: [],
  };
  fs.writeFileSync(
    path.join(artDir, 'PIPELINE.json'),
    JSON.stringify(pipeline, null, 2) + '\n',
  );

  // .gitignore
  fs.writeFileSync(
    path.join(artDir, '.gitignore'),
    '.state/\n.tmp/\n.stages/\nsessions/\n',
  );

  console.log(`  ${ART_DIR_NAME}/ created.`);
  console.log(`  Edit ${ART_DIR_NAME}/PIPELINE.json to add stages.\n`);
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
