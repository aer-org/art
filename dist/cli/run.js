import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { ensureAuth } from './auth.js';
import { setupEngine } from './engine-setup.js';
function preflight() {
    const errors = [];
    // Node.js version
    const [major] = process.versions.node.split('.').map(Number);
    if (major < 20) {
        errors.push(`Node.js 20+ required (current: ${process.versions.node}). https://nodejs.org`);
    }
    // Container runtime (docker, podman, or udocker)
    let hasRuntime = false;
    for (const cmd of ['docker', 'podman', 'udocker']) {
        try {
            const checkCmd = cmd === 'udocker' ? `${cmd} version` : `${cmd} info`;
            execSync(checkCmd, { stdio: 'pipe', timeout: 10000 });
            hasRuntime = true;
            break;
        }
        catch {
            // try next
        }
    }
    if (!hasRuntime) {
        errors.push('No container runtime found. Install Docker, Podman, or udocker.');
    }
    // Claude CLI
    try {
        execSync('claude --version', { stdio: 'pipe', timeout: 5000 });
    }
    catch {
        errors.push('Claude CLI not found. Run: npm install -g @anthropic-ai/claude-code');
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
export async function run(targetDir) {
    preflight();
    const projectDir = path.resolve(targetDir);
    const artDirName = '__art__';
    const artDir = path.join(projectDir, artDirName);
    if (!fs.existsSync(artDir)) {
        console.error(`No ${artDirName}/ found in ${projectDir}. Run 'art init .' first.`);
        process.exit(1);
    }
    // Ensure Claude authentication is available (before any engine imports)
    await ensureAuth();
    // Setup engine (paths, runtime, images, IPC dirs)
    const { folderName } = await setupEngine({
        projectDir,
        artDir,
        ensureImages: true,
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
        autoRegisterGroup: { jid: process.env.ART_TUI_JID, group: artGroup },
    });
}
//# sourceMappingURL=run.js.map