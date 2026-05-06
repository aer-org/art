#!/usr/bin/env node

const [command, ...args] = process.argv.slice(2);

function applyProviderFlag(flags: string[]): void {
  const wantsCodex = flags.includes('--codex');
  const wantsClaude = flags.includes('--claude');

  if (wantsCodex && wantsClaude) {
    console.error('Choose only one provider flag: --codex or --claude');
    process.exit(1);
  }

  if (wantsCodex) process.env.ART_AGENT_PROVIDER = 'codex';
  if (wantsClaude) process.env.ART_AGENT_PROVIDER = 'claude';
}

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
      const { init } = await import('./init.js');
      await init(args[0] || '.');
      break;
    }
    case 'run': {
      const runFlags = args.filter((a) => a.startsWith('--'));
      applyProviderFlag(runFlags);
      const runPositional = args.filter((a) => !a.startsWith('--'));
      const skipPreflight = runFlags.includes('--skip-preflight');
      const stageIdx = args.indexOf('--stage');
      const stageName = stageIdx !== -1 ? args[stageIdx + 1] : undefined;
      const { run } = await import('./run.js');
      await run(runPositional[0] || '.', {
        skipPreflight,
        stage: stageName,
      });
      break;
    }
    case 'login':
    case 'signup':
    case 'logout':
    case 'remote':
    case 'pull':
    case 'push':
    case 'diff':
    case 'fork':
    case 'promote': {
      console.error(
        `Feature pending: '${command}' depends on registry/remote support, which is currently disabled.`,
      );
      process.exit(1);
    }
    default:
      console.log(`aer-art — AI agent pipeline runner

Usage:
  art init [dir]              Create __art__/ scaffold and empty PIPELINE.json
  art run [dir]               Start the agent pipeline engine with Codex
  art run --claude [dir]      Start the agent pipeline engine with Claude Code

Pending (registry/remote support is currently disabled):
  art signup                  Create a new account
  art login                   Sign in with username/password
  art login --token           Sign in with a raw token
  art logout                  Remove stored credentials
  art remote add <name> <url> Register a backend endpoint
  art remote remove <name>    Remove a registered backend
  art remote list             List configured backends
  art remote set-default <n>  Set default backend
  art pull <pipeline>         Download pipeline bundle to local directory
  art push [dir]              Publish local changes back to registry
  art diff [dir]              Preview local vs registry changes
  art fork <agent>            Copy shared agent to user scope
  art promote <agent>         Promote user agent to shared scope
`);
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
