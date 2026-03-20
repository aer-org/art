import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { ART_DIR_NAME } from '../config.js';
import { STAGE_TEMPLATES, listTemplates } from '../stage-templates.js';
export { ONBOARD_SYSTEM_PROMPT } from './onboard-prompts.js';
// const PIPELINE_PRESETS: PipelinePreset[] = [
//   {
//     label: 'Build + Test + Review',
//     description: 'Build, test, then review for quality. (recommended)',
//     templateNames: ['build', 'test', 'review'],
//   },
//   {
//     label: 'Full research loop',
//     description: 'Build → Test → Review → History. (research)',
//     templateNames: ['build', 'test', 'review', 'history'],
//   },
// ];
const DEFAULT_PIPELINE = {
    label: 'Full research loop',
    description: 'Build → Test → Review → History',
    templateNames: ['build', 'test', 'review', 'history'],
};
export async function onboard(targetDir) {
    const projectDir = path.resolve(targetDir);
    const artDir = path.join(projectDir, ART_DIR_NAME);
    if (!fs.existsSync(artDir)) {
        console.error(`No ${ART_DIR_NAME}/ found in ${projectDir}. Run 'art compose .' first.`);
        process.exit(1);
    }
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    const ask = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));
    console.log('\n=== aer-art onboard ===\n');
    // Fixed pipeline: Build → Test → Review → History
    const stages = buildPresetStages(DEFAULT_PIPELINE);
    // TODO: re-enable pipeline selection UX
    // console.log('Choose a pipeline:\n');
    // for (let i = 0; i < PIPELINE_PRESETS.length; i++) {
    //   const p = PIPELINE_PRESETS[i];
    //   const tag = i === 0 ? ' (default)' : '';
    //   console.log(`  [${i + 1}] ${p.label} — ${p.description}${tag}`);
    // }
    // console.log(`  [${PIPELINE_PRESETS.length + 1}] Custom — Design your own stages. (advanced)`);
    // console.log();
    // const choiceRaw = await ask('Pick a number (press Enter for 1): ');
    // const choice = choiceRaw.trim() === '' ? 1 : parseInt(choiceRaw.trim(), 10);
    console.log(`Pipeline: ${stages.map((s) => s.name).join(' → ')}\n`);
    // Wire up transitions: each stage completes to the next
    for (let i = 0; i < stages.length; i++) {
        const nextName = i < stages.length - 1 ? stages[i + 1].name : null;
        const completeTransition = stages[i].transitions.find((t) => t.marker === '[STAGE_COMPLETE]');
        if (completeTransition && nextName) {
            completeTransition.next = nextName;
        }
    }
    // Auto-create metrics/insights for review stage
    const hasReview = stages.some((s) => s.name === 'review');
    if (hasReview) {
        fs.mkdirSync(path.join(artDir, 'metrics'), { recursive: true });
        fs.mkdirSync(path.join(artDir, 'insights'), { recursive: true });
        if (!fs.existsSync(path.join(artDir, 'METRIC.md'))) {
            fs.writeFileSync(path.join(artDir, 'METRIC.md'), '# Metrics\n\nTrack project metrics here. This file is read-only for agents.\n');
        }
        if (!fs.existsSync(path.join(artDir, 'insights', 'README.md'))) {
            fs.writeFileSync(path.join(artDir, 'insights', 'README.md'), '# Insights\n\nAgent-generated insights are stored here.\n');
        }
    }
    // Step 2: Project description
    console.log();
    const description = await ask('What are you building? (one sentence is fine, press Enter to skip): ');
    if (description.trim()) {
        fs.writeFileSync(path.join(artDir, 'CLAUDE.md'), `# Project Context\n\n${description.trim()}\n`);
        console.log(`  Saved to ${ART_DIR_NAME}/CLAUDE.md`);
    }
    // Write PIPELINE.json
    const pipeline = {
        stages,
    };
    fs.writeFileSync(path.join(artDir, 'PIPELINE.json'), JSON.stringify(pipeline, null, 2) + '\n');
    // Create stage subdirectories
    for (const stage of stages) {
        for (const [dir, perm] of Object.entries(stage.mounts)) {
            if (perm !== null) {
                fs.mkdirSync(path.join(artDir, dir), { recursive: true });
            }
        }
    }
    console.log(`\nPipeline saved to ${ART_DIR_NAME}/PIPELINE.json`);
    console.log(`Stages: ${stages.map((s) => s.name).join(' → ')}`);
    console.log(`\nRun 'art run .' to start the pipeline.`);
    rl.close();
}
function buildPresetStages(preset) {
    return preset.templateNames.map((name) => {
        const t = STAGE_TEMPLATES[name];
        return {
            name: t.name,
            prompt: t.prompt,
            mounts: { ...t.mounts },
            transitions: [...t.transitions],
        };
    });
}
async function buildCustomStages(ask) {
    const stages = [];
    const templates = listTemplates();
    console.log('\nAdd stages one at a time. Press Enter when done.\n');
    let addMore = true;
    while (addMore) {
        console.log('Pick a template or create a custom stage:\n');
        for (let i = 0; i < templates.length; i++) {
            console.log(`  [${i + 1}] ${templates[i].name} — ${templates[i].description}`);
        }
        console.log(`  [${templates.length + 1}] Custom — define your own stage`);
        console.log();
        const input = await ask('Stage number (Enter to finish): ');
        if (!input.trim()) {
            addMore = false;
            break;
        }
        const num = parseInt(input.trim(), 10);
        if (num >= 1 && num <= templates.length) {
            const template = templates[num - 1];
            console.log(`  Added: ${template.name}`);
            const customPrompt = await ask(`  Custom prompt? (Enter to use default): `);
            stages.push({
                name: template.name,
                prompt: customPrompt.trim() || template.prompt,
                mounts: { ...template.mounts },
                transitions: [...template.transitions],
            });
        }
        else if (num === templates.length + 1) {
            const name = await ask('  Stage name: ');
            if (!name.trim())
                continue;
            const prompt = await ask('  What should the agent do?: ');
            const canWrite = await ask('  Can this stage write code? (y/N): ');
            const writesCode = canWrite.trim().toLowerCase() === 'y';
            stages.push({
                name: name.trim().toLowerCase().replace(/\s+/g, '_'),
                prompt: prompt.trim(),
                mounts: {
                    plan: 'ro',
                    src: writesCode ? 'rw' : 'ro',
                    tests: null,
                },
                transitions: [
                    { marker: '[STAGE_COMPLETE]', next: null },
                    { marker: '[STAGE_ERROR]', next: null },
                ],
            });
            console.log(`  Added: ${name.trim()}`);
        }
        else {
            console.log('  Invalid choice, try again.');
        }
        console.log();
    }
    return stages;
}
//# sourceMappingURL=onboard.js.map