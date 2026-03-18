import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { ensureAuth } from './auth.js';

/**
 * Ensure the container image exists locally. If not, pull from registry.
 */
function ensureContainerImage(
  containerImage: string,
  runtimeBin: string,
): void {
  const isUdocker = runtimeBin === 'udocker';
  const inspectCmd = isUdocker
    ? `${runtimeBin} inspect ${containerImage}`
    : `${runtimeBin} image inspect ${containerImage}`;

  try {
    execSync(inspectCmd, { stdio: 'pipe', timeout: 10000 });
    return; // image exists
  } catch {
    // image not found — pull it
  }

  console.log(`Pulling container image: ${containerImage}...`);
  try {
    execSync(`${runtimeBin} pull ${containerImage}`, {
      stdio: 'inherit',
      timeout: 600000,
    });
    console.log('Container image pulled successfully.\n');
  } catch {
    console.error(
      `Failed to pull image '${containerImage}'.\n` +
        `Check your network connection and that the image exists:\n` +
        `  ${runtimeBin} pull ${containerImage}`,
    );
    process.exit(1);
  }
}

function preflight(): void {
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

  // Claude CLI
  try {
    execSync('claude --version', { stdio: 'pipe', timeout: 5000 });
  } catch {
    errors.push(
      'Claude CLI not found. Run: npm install -g @anthropic-ai/claude-code',
    );
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

export async function run(targetDir: string): Promise<void> {
  preflight();

  const projectDir = path.resolve(targetDir);
  const artDirName = '__art__';
  const artDir = path.join(projectDir, artDirName);

  if (!fs.existsSync(artDir)) {
    console.error(
      `No ${artDirName}/ found in ${projectDir}. Run 'art init .' first.`,
    );
    process.exit(1);
  }

  // Ensure Claude authentication is available (before any engine imports)
  await ensureAuth();

  // Set env vars BEFORE importing engine modules so logger picks them up
  process.env.ART_TUI_MODE = 'true';
  process.env.ART_TUI_LOG_DIR = path.join(artDir, 'logs');

  const folderName = `art-${path.basename(projectDir).replace(/[^A-Za-z0-9_-]/g, '-')}`;
  process.env.ART_TUI_JID = `art://${projectDir}`;

  // Now import engine modules (logger will see ART_TUI_LOG_DIR)
  const {
    ART_DIR_NAME,
    CONTAINER_IMAGE,
    setEngineRoot,
    setCredentialProxyPort,
  } = await import('../config.js');
  const { initRuntime, getRuntimeBin } =
    await import('../container-runtime.js');
  const { registerExternalGroupFolder } = await import('../group-folder.js');

  // Derive engine root from the installed package location
  const thisFile = fileURLToPath(import.meta.url);
  const engineRoot = path.resolve(path.dirname(thisFile), '..', '..');

  // Configure engine paths to use engine install dir for DB/store/groups
  setEngineRoot(engineRoot);

  // Initialize container runtime (auto-detect or load saved choice)
  const rt = await initRuntime();

  // Pull/verify all registered container images
  const { loadImageRegistry } = await import('../image-registry.js');
  const imageRegistry = loadImageRegistry();
  for (const entry of Object.values(imageRegistry)) {
    ensureContainerImage(entry.image, rt.bin);
  }

  // Use a different credential proxy port to avoid conflict with running AerArt
  setCredentialProxyPort(
    parseInt(process.env.CREDENTIAL_PROXY_PORT || '3002', 10),
  );

  // Register __art__/ as an external group folder
  registerExternalGroupFolder(folderName, artDir);

  // Ensure IPC and session dirs exist
  const dataDir = path.resolve(engineRoot, 'data');
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

  const artGroup = {
    name: 'art',
    folder: folderName,
    trigger: '',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    isMain: true,
    containerConfig: {
      workspaceDir: artDir,
    },
  };

  // Import and start the engine
  const { startEngine } = await import('../index.js');
  await startEngine({
    autoRegisterGroup: { jid: process.env.ART_TUI_JID!, group: artGroup },
  });
}
