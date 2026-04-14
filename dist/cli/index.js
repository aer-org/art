#!/usr/bin/env node
const [command, ...args] = process.argv.slice(2);
function applyProviderFlag(flags) {
    const wantsCodex = flags.includes('--codex');
    const wantsClaude = flags.includes('--claude');
    if (wantsCodex && wantsClaude) {
        console.error('Choose only one provider flag: --codex or --claude');
        process.exit(1);
    }
    if (wantsCodex)
        process.env.ART_AGENT_PROVIDER = 'codex';
    if (wantsClaude)
        process.env.ART_AGENT_PROVIDER = 'claude';
}
async function main() {
    if (command === '--version' || command === '-v') {
        const { readFileSync } = await import('fs');
        const { resolve, dirname } = await import('path');
        const { fileURLToPath } = await import('url');
        const dir = dirname(fileURLToPath(import.meta.url));
        const pkg = JSON.parse(readFileSync(resolve(dir, '../../package.json'), 'utf-8'));
        console.log(pkg.version);
        return;
    }
    switch (command) {
        case 'init': {
            console.log(`'art init' has been merged into 'art compose'. Redirecting...\n`);
            const { compose } = await import('./compose.js');
            await compose(args[0] || '.');
            break;
        }
        case 'run': {
            const runFlags = args.filter((a) => a.startsWith('--'));
            applyProviderFlag(runFlags);
            const runPositional = args.filter((a) => !a.startsWith('--'));
            const skipPreflight = runFlags.includes('--skip-preflight');
            const stageIdx = args.indexOf('--stage');
            const stageName = stageIdx !== -1 ? args[stageIdx + 1] : undefined;
            const pipelineIdx = args.indexOf('--pipeline');
            const pipelineFile = pipelineIdx !== -1 ? args[pipelineIdx + 1] : undefined;
            const { run } = await import('./run.js');
            await run(runPositional[0] || '.', {
                skipPreflight,
                stage: stageName,
                pipeline: pipelineFile,
            });
            break;
        }
        case 'compose': {
            const composeFlags = args.filter((a) => a.startsWith('--'));
            applyProviderFlag(composeFlags);
            const composePositional = args.filter((a) => !a.startsWith('--'));
            const headless = composeFlags.includes('--headless');
            const { compose } = await import('./compose.js');
            await compose(composePositional[0] || '.', { headless });
            break;
        }
        case 'update': {
            const { update } = await import('./update.js');
            await update();
            break;
        }
        case 'prompts': {
            const { promptsCli } = await import('./prompts.js');
            await promptsCli(args);
            break;
        }
        default:
            console.log(`aer-art — AI agent pipeline runner

Usage:
  art compose [dir]   Initialize (if needed) and open pipeline editor
  art run [dir]       Start the agent pipeline engine
  art prompts ...     Inspect prompt DB entries and pipeline prompt ids
  art update          Pull latest container images from registry`);
            if (command && command !== 'help' && command !== '--help') {
                console.error(`\nUnknown command: ${command}`);
                process.exit(1);
            }
    }
}
main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
export {};
//# sourceMappingURL=index.js.map