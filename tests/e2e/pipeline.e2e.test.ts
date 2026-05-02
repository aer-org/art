import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  copyFixture,
  runArt,
  cleanupFixture,
  readPipelineState,
  isDockerAvailable,
  imageExists,
  installGlobal,
  uninstallGlobal,
  listPackageFiles,
} from './helpers.js';

const hasDocker = isDockerAvailable();
const hasApiKey =
  !!process.env.ANTHROPIC_API_KEY &&
  process.env.ANTHROPIC_API_KEY !== 'placeholder';

// Install package globally before all tests, uninstall after
let tgzPath: string;
beforeAll(() => {
  tgzPath = installGlobal();
}, 120_000);
afterAll(() => {
  uninstallGlobal();
  try {
    fs.unlinkSync(tgzPath);
  } catch {
    /* ok */
  }
});

// ─── Package contents (regression for #13: agent-runner src excluded) ─────────

describe('Package contents', () => {
  let files: string[];

  beforeAll(() => {
    files = listPackageFiles();
  });

  it('includes CLI entry point', () => {
    expect(files).toContain('dist/cli/index.js');
  });

  it('includes container build files', () => {
    expect(files).toContain('container/Dockerfile');
    expect(files).toContain('container/build.sh');
  });

  it('includes agent-runner source (regression #13)', () => {
    const agentRunnerSrc = files.filter((f) =>
      f.startsWith('container/agent-runner/src/'),
    );
    expect(agentRunnerSrc.length).toBeGreaterThan(0);
  });

  it('includes agent-runner dist', () => {
    const agentRunnerDist = files.filter((f) =>
      f.startsWith('container/agent-runner/dist/'),
    );
    expect(agentRunnerDist.length).toBeGreaterThan(0);
  });

  it('includes agent-runner package.json', () => {
    expect(files).toContain('container/agent-runner/package.json');
  });
});

// ─── Test 1: Environment check ───────────────────────────────────────────────

describe('Environment', () => {
  it('Docker is available', () => {
    expect(hasDocker).toBe(true);
  });

  it('Node.js 20+', () => {
    const [major] = process.versions.node.split('.').map(Number);
    expect(major).toBeGreaterThanOrEqual(20);
  });
});

// ─── Test 2: Container image build ───────────────────────────────────────────

describe.skipIf(!hasDocker)('Container image', () => {
  it('art-agent:latest image exists or can be built', () => {
    if (!imageExists('art-agent:latest')) {
      // Build it
      execSync('./container/build.sh', {
        stdio: 'pipe',
        timeout: 600_000,
      });
    }
    expect(imageExists('art-agent:latest')).toBe(true);
  });
});

// ─── Test 3: Single command-mode pipeline ────────────────────────────────────

describe.skipIf(!hasDocker)('Command-mode pipeline', () => {
  let fixtureDir: string;

  beforeAll(() => {
    fixtureDir = copyFixture('minimal-command');
  });

  afterAll(() => {
    cleanupFixture(fixtureDir);
  });

  it('completes single-stage command pipeline with exit 0', () => {
    const result = runArt(['run', '--skip-preflight', '.'], fixtureDir);

    if (result.code !== 0) {
      console.error('STDERR:', result.stderr);
      console.error('STDOUT:', result.stdout.slice(-500));
    }
    expect(result.code).toBe(0);

    const state = readPipelineState(path.join(fixtureDir, '__art__', '.state'));
    expect(state).not.toBeNull();
    expect(state!.status).toBe('success');
  });
});

// ─── Test 4: Multi-stage command pipeline ────────────────────────────────────

describe.skipIf(!hasDocker)('Multi-stage command pipeline', () => {
  let fixtureDir: string;

  beforeAll(() => {
    fixtureDir = copyFixture('multi-stage');
  });

  afterAll(() => {
    cleanupFixture(fixtureDir);
  });

  it('completes 3-stage pipeline with all transitions', () => {
    const result = runArt(['run', '--skip-preflight', '.'], fixtureDir);

    expect(result.code).toBe(0);

    const state = readPipelineState(path.join(fixtureDir, '__art__', '.state'));
    expect(state).not.toBeNull();
    expect(state!.status).toBe('success');

    // Verify all 3 stages completed
    const completed = state!.completedStages as string[];
    expect(completed).toContain('stage-a');
    expect(completed).toContain('stage-b');
    expect(completed).toContain('stage-c');
    expect(completed).toHaveLength(3);
  });
});

// ─── Test 5: Fan-out/fan-in command pipeline ────────────────────────────────

describe.skipIf(!hasDocker)('Fan-out/fan-in command pipeline', () => {
  let fixtureDir: string;

  beforeAll(() => {
    fixtureDir = copyFixture('fan-out-fan-in');
  });

  afterAll(() => {
    cleanupFixture(fixtureDir);
  });

  it('runs parallel stages and waits for the synthesized join', () => {
    const result = runArt(['run', '--skip-preflight', '.'], fixtureDir);

    if (result.code !== 0) {
      console.error('STDERR:', result.stderr);
      console.error('STDOUT:', result.stdout.slice(-500));
    }
    expect(result.code).toBe(0);

    const state = readPipelineState(path.join(fixtureDir, '__art__', '.state'));
    expect(state).not.toBeNull();
    expect(state!.status).toBe('success');

    // build (origin) → 2 stitched test lanes → synthesized join → deploy
    const completed = state!.completedStages as string[];
    expect(completed).toContain('build');
    expect(completed).toContain('build__test0__run');
    expect(completed).toContain('build__test1__run');
    expect(completed).toContain('build__test__join');
    expect(completed).toContain('deploy');
    expect(completed).toHaveLength(5);

    // build runs first; join waits for both lanes; deploy runs after join
    const buildIdx = completed.indexOf('build');
    const lane0Idx = completed.indexOf('build__test0__run');
    const lane1Idx = completed.indexOf('build__test1__run');
    const joinIdx = completed.indexOf('build__test__join');
    const deployIdx = completed.indexOf('deploy');
    expect(buildIdx).toBeLessThan(lane0Idx);
    expect(buildIdx).toBeLessThan(lane1Idx);
    expect(joinIdx).toBeGreaterThan(lane0Idx);
    expect(joinIdx).toBeGreaterThan(lane1Idx);
    expect(deployIdx).toBeGreaterThan(joinIdx);
  });
});

// ─── Test 6: Agent-mode pipeline (API required) ─────────────────────────────

describe.skipIf(!hasDocker || !hasApiKey)('Agent-mode pipeline @api', () => {
  let fixtureDir: string;

  beforeAll(() => {
    fixtureDir = copyFixture('minimal-agent');
  });

  afterAll(() => {
    cleanupFixture(fixtureDir);
  });

  it('completes agent pipeline with Claude API call', () => {
    const result = runArt(
      ['run', '--claude', '.'],
      fixtureDir,
      undefined,
      600_000,
    );

    expect(result.code).toBe(0);

    const state = readPipelineState(path.join(fixtureDir, '__art__', '.state'));
    expect(state).not.toBeNull();
    expect(state!.status).toBe('success');
  });
});

// ─── Test 6: Init scaffold (API required) ────────────────────────────────────

describe('Init scaffold', () => {
  let fixtureDir: string;

  beforeAll(() => {
    fixtureDir = copyFixture('minimal-init');
  });

  afterAll(() => {
    cleanupFixture(fixtureDir);
  });

  it('creates __art__ scaffold via init', () => {
    const result = runArt(['init', '.'], fixtureDir, undefined, 120_000);

    expect(result.code).toBe(0);

    const artDir = path.join(fixtureDir, '__art__');
    const pipelinePath = path.join(artDir, 'PIPELINE.json');
    const pipeline = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8')) as {
      stages: unknown[];
    };
    expect(pipeline.stages).toEqual([]);
    expect(fs.existsSync(path.join(artDir, 'agents'))).toBe(true);
    expect(fs.existsSync(path.join(artDir, 'templates'))).toBe(true);
    expect(fs.existsSync(path.join(artDir, 'plan'))).toBe(false);
  });
});

// ─── Test 7: Init + Run full flow (API required) ─────────────────────────────

describe.skipIf(!hasDocker || !hasApiKey)('Init + Run full flow @api', () => {
  let fixtureDir: string;

  beforeAll(() => {
    fixtureDir = copyFixture('minimal-init');
  });

  afterAll(() => {
    cleanupFixture(fixtureDir);
  });

  it('init then run completes successfully', () => {
    const initResult = runArt(['init', '.'], fixtureDir, undefined, 120_000);
    expect(initResult.code).toBe(0);

    const pipelinePath = path.join(fixtureDir, '__art__', 'PIPELINE.json');
    fs.writeFileSync(
      pipelinePath,
      JSON.stringify(
        {
          stages: [
            {
              name: 'done',
              prompt: 'Just return [STAGE_COMPLETE]. Do nothing else.',
              mounts: {},
              transitions: [{ marker: '[STAGE_COMPLETE]', next: null }],
            },
          ],
          entryStage: 'done',
        },
        null,
        2,
      ) + '\n',
    );

    const runResult = runArt(
      ['run', '--claude', '.'],
      fixtureDir,
      undefined,
      600_000,
    );
    expect(runResult.code).toBe(0);

    const state = readPipelineState(path.join(fixtureDir, '__art__', '.state'));
    expect(state).not.toBeNull();
    expect(state!.status).toBe('success');
  });
});
