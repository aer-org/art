/**
 * Shared engine bootstrap for art init / art run / art compose.
 * Extracts common setup from run.ts so init and compose can reuse it.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

export interface EngineSetupResult {
  engineRoot: string;
  folderName: string;
  dataDir: string;
  runtimeBin: string;
}

const TAR_RELEASE_URL =
  'https://github.com/aer-org/art/releases/download/container-latest/art-agent.tar.gz';

/**
 * Ensure the container image exists locally. If not, pull from registry.
 * For udocker: downloads pre-built tar from GitHub Release since udocker pull
 * can't reliably merge multi-layer images.
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

  if (isUdocker) {
    console.log(`Downloading container image tar: ${containerImage}...`);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-setup-'));
    const tarPath = path.join(tmpDir, 'art-agent.tar.gz');
    try {
      execSync(`curl -fSL -o ${tarPath} ${TAR_RELEASE_URL}`, {
        stdio: ['pipe', 'inherit', 'inherit'],
        timeout: 600000,
      });
      execSync(`${runtimeBin} load -i ${tarPath}`, {
        stdio: 'inherit',
        timeout: 600000,
      });
      console.log('Container image loaded successfully.\n');
    } catch {
      console.error(
        `Failed to download or load image tar.\n` +
          `Download manually from: ${TAR_RELEASE_URL}\n` +
          `Then run: ${runtimeBin} load -i art-agent.tar.gz`,
      );
      process.exit(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    return;
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

export async function setupEngine(opts: {
  projectDir: string;
  artDir: string;
  credentialProxyPort?: number;
}): Promise<EngineSetupResult> {
  const { projectDir, artDir, credentialProxyPort = 3002 } = opts;

  // Set env vars for TUI-mode logging
  process.env.ART_TUI_MODE = 'true';
  process.env.ART_TUI_LOG_DIR = path.join(artDir, 'logs');

  const folderName = `art-${path.basename(projectDir).replace(/[^A-Za-z0-9_-]/g, '-')}`;
  process.env.ART_TUI_JID = `art://${projectDir}`;

  // Import engine modules (logger will see ART_TUI_LOG_DIR)
  const { setEngineRoot, setCredentialProxyPort } =
    await import('../config.js');
  const { initRuntime } = await import('../container-runtime.js');
  const { registerExternalGroupFolder } = await import('../group-folder.js');

  // Derive engine root from the installed package location
  const thisFile = fileURLToPath(import.meta.url);
  const engineRoot = path.resolve(path.dirname(thisFile), '..', '..');

  // Configure engine paths
  setEngineRoot(engineRoot);

  // Initialize container runtime (auto-detect or load saved choice)
  const rt = await initRuntime();

  // Pull/verify all registered container images
  const { loadImageRegistry } = await import('../image-registry.js');
  const imageRegistry = loadImageRegistry();
  for (const entry of Object.values(imageRegistry)) {
    ensureContainerImage(entry.image, rt.bin);
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

  return { engineRoot, folderName, dataDir, runtimeBin: rt.bin };
}
