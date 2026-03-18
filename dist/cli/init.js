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
function buildStages() {
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
        const completeTransition = stages[i].transitions.find((t) => t.marker === '[STAGE_COMPLETE]');
        if (completeTransition && nextName) {
            completeTransition.next = nextName;
        }
    }
    return stages;
}
export async function init(targetDir) {
    const projectDir = path.resolve(targetDir);
    const artDir = path.join(projectDir, ART_DIR_NAME);
    if (fs.existsSync(artDir)) {
        console.log(`${ART_DIR_NAME}/ already exists in ${projectDir}`);
        return;
    }
    console.log(`\nSetting up ${ART_DIR_NAME}/ in ${projectDir}\n`);
    // Create directory structure
    fs.mkdirSync(artDir, { recursive: true });
    // Plan
    fs.mkdirSync(path.join(artDir, 'plan'), { recursive: true });
    fs.writeFileSync(path.join(artDir, 'plan', 'PLAN.md'), '# Plan\n\nDescribe what you want the agents to build.\n');
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
    fs.writeFileSync(path.join(artDir, 'CLAUDE.md'), '# Project Context\n\nDescribe your project here. Agents will read this for context.\n');
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
    fs.writeFileSync(path.join(artDir, 'PIPELINE.json'), JSON.stringify(pipeline, null, 2) + '\n');
    // Create any additional stage mount directories
    for (const stage of stages) {
        for (const [dir, perm] of Object.entries(stage.mounts)) {
            if (perm !== null) {
                fs.mkdirSync(path.join(artDir, dir), { recursive: true });
            }
        }
    }
    // .gitignore
    fs.writeFileSync(path.join(artDir, '.gitignore'), 'logs/\nsessions/\nPIPELINE_STATE.json\n');
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
    // Ask user if they want to register custom images
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    const prompt = (q) => new Promise((resolve) => rl.question(q, resolve));
    const answer = await prompt('Register custom container images? (y/N): ');
    if (answer.trim().toLowerCase() === 'y') {
        const name = (await prompt('Image name (e.g., vivado): ')).trim();
        const baseImage = (await prompt('Base Docker image (Debian/Ubuntu, e.g., xilinx/vivado:2024.1): ')).trim();
        if (name && baseImage) {
            console.log(`\nBuilding agent image on top of ${baseImage}...`);
            console.log('Installing: Node.js 22, Chromium, agent-browser, claude-code, gcc/g++');
            console.log('⚠️  Base image must be Debian/Ubuntu. Entrypoint will be overridden.\n');
            const scriptDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'container');
            execSync(`${scriptDir}/build.sh ${name} ${baseImage}`, {
                stdio: 'inherit',
            });
            registry[name] = {
                image: `aer-art-agent-${name}:latest`,
                hasAgent: true,
                baseImage,
            };
            saveImageRegistry(registry);
            console.log(`\n✅ Image "${name}" registered.\n`);
        }
    }
    rl.close();
    // Ensure Claude authentication before launching editor
    await ensureAuth();
    // Setup engine for container agent
    const { setupEngine } = await import('./engine-setup.js');
    await setupEngine({ projectDir, artDir });
    // Launch GUI editor with container agent onboarding
    await startEditorServer(artDir, 'init', projectDir);
}
//# sourceMappingURL=init.js.map