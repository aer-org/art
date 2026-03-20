import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
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
async function askConfirmation(prompt) {
    if (!process.stdin.isTTY)
        return true;
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    const answer = await new Promise((resolve) => rl.question(prompt, resolve));
    rl.close();
    const trimmed = answer.trim().toLowerCase();
    return trimmed === '' || trimmed === 'y' || trimmed === 'yes';
}
export async function run(targetDir) {
    preflight();
    const projectDir = path.resolve(targetDir);
    const artDirName = '__art__';
    const artDir = path.join(projectDir, artDirName);
    if (!fs.existsSync(artDir)) {
        console.error(`No ${artDirName}/ found in ${projectDir}. Run 'art compose .' first.`);
        process.exit(1);
    }
    // Check for existing run (_current.json)
    const { readCurrentRun, removeCurrentRun, isPidAlive, generateRunId } = await import('../pipeline-runner.js');
    const { cleanupRunContainers } = await import('../container-runtime.js');
    const currentRun = readCurrentRun(artDir);
    if (currentRun) {
        if (isPidAlive(currentRun.pid)) {
            const confirmed = await askConfirmation(`이미 실행 중인 run이 있습니다 (${currentRun.runId}, PID ${currentRun.pid}).\n중지하고 새로 시작하시겠습니까? [Y/n] `);
            if (!confirmed) {
                console.log('종료합니다.');
                process.exit(0);
            }
            // Stop the existing run
            try {
                process.kill(currentRun.pid, 'SIGTERM');
            }
            catch {
                /* already dead */
            }
            cleanupRunContainers(currentRun.runId);
            removeCurrentRun(artDir);
        }
        else {
            // PID is dead — orphan cleanup
            console.log(`이전 run이 비정상 종료됨 (${currentRun.runId}, PID ${currentRun.pid}). 정리 중...`);
            cleanupRunContainers(currentRun.runId);
            removeCurrentRun(artDir);
        }
    }
    // Generate run ID for this execution
    const runId = generateRunId();
    // Ensure Claude authentication is available (before any engine imports)
    await ensureAuth();
    // Setup engine (paths, runtime, images, IPC dirs)
    const { folderName } = await setupEngine({
        projectDir,
        artDir,
        ensureImages: true,
    });
    // Import manifest functions ahead of signal handler registration
    const { readRunManifest, writeRunManifest } = await import('../pipeline-runner.js');
    // Register SIGINT/SIGTERM handlers to clean up _current.json
    const cleanupOnSignal = () => {
        try {
            const manifest = readRunManifest(artDir, runId);
            if (manifest) {
                manifest.endTime = new Date().toISOString();
                manifest.status = 'cancelled';
                writeRunManifest(artDir, manifest);
            }
        }
        catch {
            /* best effort */
        }
        removeCurrentRun(artDir);
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
        containerConfig: {
            workspaceDir: artDir,
        },
    };
    // Import and start the engine
    const { startEngine } = await import('../index.js');
    await startEngine({
        autoRegisterGroup: { jid: process.env.ART_TUI_JID, group: artGroup },
        runId,
    });
}
//# sourceMappingURL=run.js.map