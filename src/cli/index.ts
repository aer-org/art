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
      const pipelineIdx = args.indexOf('--pipeline');
      const pipelineFile =
        pipelineIdx !== -1 ? args[pipelineIdx + 1] : undefined;
      const { run } = await import('./run.js');
      await run(runPositional[0] || '.', {
        skipPreflight,
        stage: stageName,
        pipeline: pipelineFile,
      });
      break;
    }
    case 'login': {
      const { login } = await import('./login.js');
      await login(args);
      break;
    }
    case 'signup': {
      const { signup } = await import('./login.js');
      await signup(args);
      break;
    }
    case 'logout': {
      const { logout } = await import('./logout.js');
      await logout();
      break;
    }
    case 'remote': {
      const { remote } = await import('./remote.js');
      await remote(args);
      break;
    }
    case 'pull': {
      const { pull } = await import('./pull.js');
      await pull(args);
      break;
    }
    case 'push': {
      const { push } = await import('./push.js');
      await push(args);
      break;
    }
    case 'diff': {
      const { diff } = await import('./diff.js');
      await diff(args);
      break;
    }
    case 'fork': {
      const { fork } = await import('./fork.js');
      await fork(args);
      break;
    }
    case 'promote': {
      const { promote } = await import('./fork.js');
      await promote(args);
      break;
    }
    default:
      console.log(`aer-art — AI agent pipeline runner

Usage:
  art init [dir]              Create __art__/ scaffold and empty PIPELINE.json
  art run [dir]               Start the agent pipeline engine with Codex
  art run --claude [dir]      Start the agent pipeline engine with Claude Code
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
