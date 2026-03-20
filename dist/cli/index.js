#!/usr/bin/env node
const [command, ...args] = process.argv.slice(2);
async function main() {
    switch (command) {
        case 'init': {
            console.log(`'art init' has been merged into 'art compose'. Redirecting...\n`);
            const { compose } = await import('./compose.js');
            await compose(args[0] || '.');
            break;
        }
        case 'run': {
            const { run } = await import('./run.js');
            await run(args[0] || '.');
            break;
        }
        case 'compose': {
            const { compose } = await import('./compose.js');
            await compose(args[0] || '.');
            break;
        }
        case 'update': {
            const { update } = await import('./update.js');
            await update();
            break;
        }
        default:
            console.log(`aer-art — AI agent pipeline runner

Usage:
  art compose [dir]   Initialize (if needed) and open pipeline editor
  art run [dir]       Start the agent pipeline engine
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