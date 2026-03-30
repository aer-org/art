#!/usr/bin/env node

const [command, ...args] = process.argv.slice(2);

async function main(): Promise<void> {
  if (command === '--version' || command === '-v') {
    const { readFileSync } = await import('fs');
    const { resolve, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const dir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(resolve(dir, '../../package.json'), 'utf-8'),
    );
    console.log(pkg.version);
    return;
  }

  switch (command) {
    case 'init': {
      console.log(
        `'art init' has been merged into 'art compose'. Redirecting...\n`,
      );
      const { compose } = await import('./compose.js');
      await compose(args[0] || '.');
      break;
    }
    case 'run': {
      const runFlags = args.filter((a) => a.startsWith('--'));
      const runPositional = args.filter((a) => !a.startsWith('--'));
      const skipPreflight = runFlags.includes('--skip-preflight');
      const stageIdx = args.indexOf('--stage');
      const stageName = stageIdx !== -1 ? args[stageIdx + 1] : undefined;
      const { run } = await import('./run.js');
      await run(runPositional[0] || '.', { skipPreflight, stage: stageName });
      break;
    }
    case 'compose': {
      const composeFlags = args.filter((a) => a.startsWith('--'));
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
