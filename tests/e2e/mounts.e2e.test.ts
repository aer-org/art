import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
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
    expect(result.stdout).toContain('READ_OK');
    expect(result.stdout).toContain('WRITE_FAIL');
    expect(result.stdout).not.toContain('WRITE_OK');
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
    expect(result.stdout).toContain('WRITE_OK');
    expect(result.stdout).not.toContain('WRITE_FAIL');

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

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('HIDDEN');
    expect(result.stdout).not.toContain('VISIBLE');
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

    expect(result.code).toBe(0);

    // Project root is readable
    expect(result.stdout).toContain('PROJECT_READ_OK');

    // Project root is NOT writable
    expect(result.stdout).toContain('PROJECT_WRITE_FAIL');
    expect(result.stdout).not.toContain('PROJECT_WRITE_OK');

    // Sub-path src/generated is writable
    expect(result.stdout).toContain('SUB_WRITE_OK');
    expect(result.stdout).not.toContain('SUB_WRITE_FAIL');

    // __art__/ is always hidden from container
    expect(result.stdout).toContain('ART_HIDDEN');
    expect(result.stdout).not.toContain('ART_VISIBLE');

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
