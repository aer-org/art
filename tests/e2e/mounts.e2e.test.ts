import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  copyFixture,
  runArt,
  cleanupFixture,
  isDockerAvailable,
  installGlobal,
  uninstallGlobal,
} from './helpers.js';

const hasDocker = isDockerAvailable();

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

// ─── Read-only mount ─────────────────────────────────────────────────────────

describe.skipIf(!hasDocker)('Mount: read-only (ro)', () => {
  let fixtureDir: string;

  beforeAll(() => {
    fixtureDir = copyFixture('mount-ro');
  });

  afterAll(() => {
    cleanupFixture(fixtureDir);
  });

  it('can read but cannot write to ro mount', () => {
    const result = runArt(['run', '--skip-preflight', '.'], fixtureDir);

    expect(result.code).toBe(0);
    // Stage output is prefixed with [stage-name] to distinguish from log lines
    expect(result.stdout).toContain('[test-ro] READ_OK');
    expect(result.stdout).toContain('[test-ro] WRITE_FAIL');
    expect(result.stdout).not.toContain('[test-ro] WRITE_OK');
  });
});

// ─── Read-write mount ────────────────────────────────────────────────────────

describe.skipIf(!hasDocker)('Mount: read-write (rw)', () => {
  let fixtureDir: string;

  beforeAll(() => {
    fixtureDir = copyFixture('mount-rw');
  });

  afterAll(() => {
    cleanupFixture(fixtureDir);
  });

  it('can read and write to rw mount', () => {
    const result = runArt(['run', '--skip-preflight', '.'], fixtureDir);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('[test-rw] WRITE_OK');
    expect(result.stdout).not.toContain('[test-rw] WRITE_FAIL');

    // Verify file actually persisted on host
    const writtenFile = path.join(fixtureDir, '__art__', 'src', 'written.txt');
    expect(fs.existsSync(writtenFile)).toBe(true);
    expect(fs.readFileSync(writtenFile, 'utf-8').trim()).toBe('hello');
  });
});

// ─── Hidden mount (null) ─────────────────────────────────────────────────────

describe.skipIf(!hasDocker)('Mount: hidden (null)', () => {
  let fixtureDir: string;

  beforeAll(() => {
    fixtureDir = copyFixture('mount-hidden');
  });

  afterAll(() => {
    cleanupFixture(fixtureDir);
  });

  it('cannot see hidden mount path', () => {
    const result = runArt(['run', '--skip-preflight', '.'], fixtureDir);

    if (result.code !== 0) {
      console.error('HIDDEN STDERR:', result.stderr);
      console.error('HIDDEN STDOUT:', result.stdout.slice(-500));
    }
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('[test-hidden] HIDDEN');
    expect(result.stdout).not.toContain('[test-hidden] VISIBLE');
  });
});

// ─── Project mount with sub-path override ────────────────────────────────────

describe.skipIf(!hasDocker)('Mount: project ro + sub-path rw', () => {
  let fixtureDir: string;

  beforeAll(() => {
    fixtureDir = copyFixture('mount-project-sub');
  });

  afterAll(() => {
    cleanupFixture(fixtureDir);
  });

  it('project is readable, not writable; sub-path is writable; __art__ is hidden', () => {
    const result = runArt(['run', '--skip-preflight', '.'], fixtureDir);

    if (result.code !== 0) {
      console.error('PROJECT-SUB STDERR:', result.stderr);
      console.error('PROJECT-SUB STDOUT:', result.stdout.slice(-500));
    }
    expect(result.code).toBe(0);

    // Project root is readable
    expect(result.stdout).toContain('[test-project-sub] PROJECT_READ_OK');

    // Project root is NOT writable
    expect(result.stdout).toContain('[test-project-sub] PROJECT_WRITE_FAIL');
    expect(result.stdout).not.toContain('[test-project-sub] PROJECT_WRITE_OK');

    // Sub-path src/generated is writable
    expect(result.stdout).toMatch(/SUB_WRITE_OK/);
    expect(result.stdout).not.toMatch(/\] SUB_WRITE_FAIL/);

    // __art__/ contents are hidden from container (shadow with empty dir)
    expect(result.stdout).toMatch(/ART_HIDDEN/);
    expect(result.stdout).not.toMatch(/\] ART_VISIBLE/);

    // Verify written file persisted on host
    const outputFile = path.join(
      fixtureDir,
      'src',
      'generated',
      'output.txt',
    );
    expect(fs.existsSync(outputFile)).toBe(true);
  });
});

// ─── Host path mount via hostMounts ─────────────────────────────────────────

describe.skipIf(!hasDocker)('Mount: host path (hostMounts)', () => {
  let fixtureDir: string;
  const allowlistPath = path.join(
    os.homedir(),
    '.config',
    'aer-art',
    'mount-allowlist.json',
  );
  let originalAllowlist: string | null = null;

  beforeAll(() => {
    // Save existing allowlist if present
    if (fs.existsSync(allowlistPath)) {
      originalAllowlist = fs.readFileSync(allowlistPath, 'utf-8');
    }

    fixtureDir = copyFixture('mount-host-path');

    // Rewrite PIPELINE.json with the actual host-data path
    const pipelinePath = path.join(fixtureDir, '__art__', 'PIPELINE.json');
    const hostDataDir = path.join(fixtureDir, 'host-data');
    const content = fs.readFileSync(pipelinePath, 'utf-8');
    fs.writeFileSync(
      pipelinePath,
      content.replace('__HOST_DATA_PATH__', hostDataDir),
    );

    // Ensure allowlist permits /tmp (where fixtures are copied)
    const allowlist = {
      allowedRoots: [
        { path: '/tmp', allowReadWrite: true, description: 'E2E test fixtures' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: false,
    };
    // Merge with existing allowlist if present
    if (originalAllowlist) {
      try {
        const existing = JSON.parse(originalAllowlist);
        const hasTmp = existing.allowedRoots?.some(
          (r: { path: string }) => r.path === '/tmp',
        );
        if (!hasTmp) {
          existing.allowedRoots = existing.allowedRoots || [];
          existing.allowedRoots.push({
            path: '/tmp',
            allowReadWrite: true,
            description: 'E2E test fixtures',
          });
        }
        fs.writeFileSync(allowlistPath, JSON.stringify(existing, null, 2));
      } catch {
        fs.mkdirSync(path.dirname(allowlistPath), { recursive: true });
        fs.writeFileSync(allowlistPath, JSON.stringify(allowlist, null, 2));
      }
    } else {
      fs.mkdirSync(path.dirname(allowlistPath), { recursive: true });
      fs.writeFileSync(allowlistPath, JSON.stringify(allowlist, null, 2));
    }
  });

  afterAll(() => {
    cleanupFixture(fixtureDir);
    // Restore original allowlist
    if (originalAllowlist !== null) {
      fs.writeFileSync(allowlistPath, originalAllowlist);
    } else if (fs.existsSync(allowlistPath)) {
      fs.unlinkSync(allowlistPath);
    }
  });

  it('can read host-mounted directory inside container', () => {
    const result = runArt(['run', '--skip-preflight', '.'], fixtureDir);

    if (result.code !== 0) {
      console.error('HOST-MOUNT STDERR:', result.stderr);
      console.error('HOST-MOUNT STDOUT:', result.stdout.slice(-500));
    }
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('[test-host-mount] host-data-ok');
    expect(result.stdout).toContain('[test-host-mount] HOST_READ_OK');
    expect(result.stdout).not.toContain('[test-host-mount] HOST_READ_FAIL');
  });
});
