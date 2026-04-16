/**
 * Shared engine bootstrap for art run.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

import { saveImageRegistry } from '../image-registry.js';

export interface EngineSetupResult {
  engineRoot: string;
  folderName: string;
  dataDir: string;
  runtimeBin: string;
}

export async function setupEngine(opts: {
  projectDir: string;
  artDir: string;
  credentialProxyPort?: number;
  ensureImages?: boolean;
}): Promise<EngineSetupResult> {
  const {
    projectDir,
    artDir,
    credentialProxyPort = 3002,
    ensureImages = false,
  } = opts;

  // Ensure TUI env vars are set (callers should set these before importing engine modules,
  // but set here as fallback so logger always routes to file)
  if (!process.env.ART_TUI_MODE) {
    process.env.ART_TUI_MODE = 'true';
    process.env.ART_TUI_LOG_DIR = path.join(artDir, 'logs');
  }

  const folderName = `art-${path.basename(projectDir).replace(/[^A-Za-z0-9_-]/g, '-')}`;

  // Import engine modules (logger will see ART_TUI_LOG_DIR)
  const { setEngineRoot, setDataDir, setCredentialProxyPort } =
    await import('../config.js');
  const { initRuntime } = await import('../container-runtime.js');
  const { registerExternalGroupFolder } = await import('../group-folder.js');

  // Derive engine root from the installed package location
  const thisFile = fileURLToPath(import.meta.url);
  const engineRoot = path.resolve(path.dirname(thisFile), '..', '..');

  // Configure engine paths
  setEngineRoot(engineRoot);
  setDataDir(path.join(artDir, '.tmp'));

  // Initialize container runtime (auto-detect or load saved choice)
  const rt = await initRuntime();

  // Check registered images exist locally; prompt to build missing ones
  if (ensureImages) {
    const { loadImageRegistry: loadReg } = await import('../image-registry.js');
    const { CONTAINER_IMAGE } = await import('../config.js');
    const imageRegistry = loadReg();

    // Always need the default image (stages without explicit image use it)
    const needed = new Map<string, { image: string; baseImage?: string }>();
    const defaultEntry = imageRegistry['default'];
    needed.set('default', {
      image: defaultEntry?.image || CONTAINER_IMAGE,
      baseImage: defaultEntry?.baseImage,
    });

    // Only add images actually referenced by pipeline stages
    const pipelinePath = path.join(artDir, 'PIPELINE.json');
    if (fs.existsSync(pipelinePath)) {
      try {
        const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
        for (const stage of pipeline.stages || []) {
          if (stage.image && !needed.has(stage.image)) {
            const regEntry = imageRegistry[stage.image];
            if (regEntry) {
              needed.set(stage.image, {
                image: regEntry.image,
                baseImage: regEntry.baseImage,
              });
            }
          }
        }
      } catch {
        // ignore malformed pipeline
      }
    }

    // Check which images are missing locally
    const missing: { key: string; image: string; baseImage?: string }[] = [];
    for (const [key, info] of needed) {
      try {
        execSync(`${rt.bin} image inspect ${info.image}`, {
          stdio: 'pipe',
          timeout: 10000,
        });
      } catch {
        missing.push({ key, image: info.image, baseImage: info.baseImage });
      }
    }

    // Prompt to build missing images
    if (missing.length > 0) {
      console.log(`\n${missing.length} image(s) need to be built:`);
      for (const m of missing) console.log(`  - ${m.key} (${m.image})`);

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const ask = (q: string) =>
        new Promise<string>((resolve) => rl.question(q, resolve));

      for (const m of missing) {
        const answer = process.stdin.isTTY
          ? await ask(`\nBuild image "${m.key}"? (y/N): `)
          : 'y'; // auto-accept in non-interactive (CI)
        if (answer.trim().toLowerCase() !== 'y') {
          console.error(
            `\nPlease update the pipeline to not require this image.`,
          );
          rl.close();
          process.exit(1);
        }

        // Build the image
        const scriptDir = path.resolve(engineRoot, 'container');
        const buildCmd =
          m.key === 'default' || !m.baseImage
            ? `${scriptDir}/build.sh`
            : `${scriptDir}/build.sh ${m.key} ${m.baseImage}`;
        console.log(`\nBuilding: ${m.image}...`);
        execSync(buildCmd, {
          stdio: 'inherit',
          timeout: 600000,
          env: { ...process.env, CONTAINER_RUNTIME: rt.bin },
        });

        // Ensure registry entry exists
        if (!imageRegistry[m.key]) {
          imageRegistry[m.key] = {
            image: m.image,
            hasAgent: true,
            baseImage: m.baseImage,
          };
          saveImageRegistry(imageRegistry);
        }
      }
      rl.close();
    }
  }

  // Set credential proxy port
  setCredentialProxyPort(
    parseInt(
      process.env.CREDENTIAL_PROXY_PORT || String(credentialProxyPort),
      10,
    ),
  );

  // Register __art__/ as an external group folder
  registerExternalGroupFolder(folderName, artDir);

  // Ensure IPC and session dirs exist
  const dataDir = path.join(artDir, '.tmp');
  fs.mkdirSync(path.join(dataDir, 'ipc', folderName, 'messages'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(dataDir, 'ipc', folderName, 'tasks'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(dataDir, 'ipc', folderName, 'input'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(dataDir, 'sessions', folderName, '.claude'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(dataDir, 'sessions', folderName, '.codex'), {
    recursive: true,
  });

  return { engineRoot, folderName, dataDir, runtimeBin: rt.bin };
}
