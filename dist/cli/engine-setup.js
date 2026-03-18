/**
 * Shared engine bootstrap for art init / art run / art compose.
 * Extracts common setup from run.ts so init and compose can reuse it.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { saveImageRegistry } from '../image-registry.js';
export async function setupEngine(opts) {
    const { projectDir, artDir, credentialProxyPort = 3002 } = opts;
    // Set env vars for TUI-mode logging
    process.env.ART_TUI_MODE = 'true';
    process.env.ART_TUI_LOG_DIR = path.join(artDir, 'logs');
    const folderName = `art-${path.basename(projectDir).replace(/[^A-Za-z0-9_-]/g, '-')}`;
    process.env.ART_TUI_JID = `art://${projectDir}`;
    // Import engine modules (logger will see ART_TUI_LOG_DIR)
    const { setEngineRoot, setCredentialProxyPort } = await import('../config.js');
    const { initRuntime } = await import('../container-runtime.js');
    const { registerExternalGroupFolder } = await import('../group-folder.js');
    // Derive engine root from the installed package location
    const thisFile = fileURLToPath(import.meta.url);
    const engineRoot = path.resolve(path.dirname(thisFile), '..', '..');
    // Configure engine paths
    setEngineRoot(engineRoot);
    // Initialize container runtime (auto-detect or load saved choice)
    const rt = await initRuntime();
    // Pull/verify all registered container images (update registry if name changed)
    const { ensureImage } = await import('../container-runtime.js');
    const { loadImageRegistry: loadReg } = await import('../image-registry.js');
    const imageRegistry = loadReg();
    let registryChanged = false;
    for (const [key, entry] of Object.entries(imageRegistry)) {
        const usableName = ensureImage(entry.image);
        if (usableName !== entry.image) {
            imageRegistry[key] = { ...entry, image: usableName };
            registryChanged = true;
        }
    }
    if (registryChanged)
        saveImageRegistry(imageRegistry);
    // Set credential proxy port
    setCredentialProxyPort(parseInt(process.env.CREDENTIAL_PROXY_PORT || String(credentialProxyPort), 10));
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
//# sourceMappingURL=engine-setup.js.map