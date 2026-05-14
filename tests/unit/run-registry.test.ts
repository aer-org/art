import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  listRuns,
  liveRuns,
  crashedRuns,
  sealedRuns,
  findRun,
} from '../../src/run-registry.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-registry-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRun(
  runId: string,
  opts: {
    sealed?: boolean;
    pid?: number;
    hostname?: string;
    runJson?: unknown; // override run.json content
    omitRunJson?: boolean;
    malformedRunJson?: boolean;
  },
): void {
  const runDir = path.join(tmpDir, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  if (opts.omitRunJson) {
    // intentionally skip writing run.json
  } else if (opts.malformedRunJson) {
    fs.writeFileSync(path.join(runDir, 'run.json'), '{not valid json');
  } else if (opts.runJson !== undefined) {
    fs.writeFileSync(
      path.join(runDir, 'run.json'),
      JSON.stringify(opts.runJson),
    );
  } else {
    fs.writeFileSync(
      path.join(runDir, 'run.json'),
      JSON.stringify({
        pid: opts.pid ?? process.pid,
        hostname: opts.hostname ?? os.hostname(),
        startTime: '2026-01-01T00:00:00.000Z',
      }),
    );
  }
  if (opts.sealed) {
    fs.writeFileSync(path.join(runDir, 'sealed'), '');
  }
}

describe('listRuns', () => {
  it('returns [] when runs dir does not exist', () => {
    expect(listRuns(tmpDir)).toEqual([]);
  });

  it('returns runs in reverse-chronological order by runId', () => {
    makeRun('run-1000-aaaaaa', { sealed: true });
    makeRun('run-3000-cccccc', { sealed: true });
    makeRun('run-2000-bbbbbb', { sealed: true });

    const list = listRuns(tmpDir);
    expect(list.map((r) => r.runId)).toEqual([
      'run-3000-cccccc',
      'run-2000-bbbbbb',
      'run-1000-aaaaaa',
    ]);
  });

  it('ignores non-run entries in runs/', () => {
    makeRun('run-1-aaaaaa', { sealed: true });
    fs.writeFileSync(path.join(tmpDir, 'runs', 'README'), 'noise');
    fs.mkdirSync(path.join(tmpDir, 'runs', 'not-a-run'), { recursive: true });
    expect(listRuns(tmpDir).map((r) => r.runId)).toEqual(['run-1-aaaaaa']);
  });
});

describe('classification (3-state)', () => {
  it('sealed marker present → state="sealed" (even if pid alive)', () => {
    makeRun('run-1-aaaaaa', { sealed: true, pid: process.pid });
    const r = findRun(tmpDir, 'run-1-aaaaaa');
    expect(r?.state).toBe('sealed');
  });

  it('no sealed + pid alive on same host → state="live"', () => {
    makeRun('run-1-aaaaaa', { pid: process.pid });
    const r = findRun(tmpDir, 'run-1-aaaaaa');
    expect(r?.state).toBe('live');
  });

  it('no sealed + pid dead → state="crashed"', () => {
    // pid 1 = init; sending signal 0 succeeds but we use a very high pid that is
    // guaranteed dead on most systems.
    makeRun('run-1-aaaaaa', { pid: 2 ** 22 + 1 });
    const r = findRun(tmpDir, 'run-1-aaaaaa');
    expect(r?.state).toBe('crashed');
  });

  it('hostname mismatch → state="crashed" (cannot trust pid cross-host)', () => {
    makeRun('run-1-aaaaaa', {
      pid: process.pid,
      hostname: 'some-other-host.example.com',
    });
    const r = findRun(tmpDir, 'run-1-aaaaaa');
    expect(r?.state).toBe('crashed');
  });
});

describe('classification edge cases', () => {
  it('missing run.json → state="crashed"', () => {
    makeRun('run-1-aaaaaa', { omitRunJson: true });
    expect(findRun(tmpDir, 'run-1-aaaaaa')?.state).toBe('crashed');
  });

  it('malformed run.json → state="crashed"', () => {
    makeRun('run-1-aaaaaa', { malformedRunJson: true });
    expect(findRun(tmpDir, 'run-1-aaaaaa')?.state).toBe('crashed');
  });

  it('missing pid in run.json → state="crashed"', () => {
    makeRun('run-1-aaaaaa', {
      runJson: { startTime: '2026-01-01T00:00:00.000Z' },
    });
    expect(findRun(tmpDir, 'run-1-aaaaaa')?.state).toBe('crashed');
  });

  it('pid <= 0 → state="crashed"', () => {
    makeRun('run-1-aaaaaa', { pid: 0 });
    expect(findRun(tmpDir, 'run-1-aaaaaa')?.state).toBe('crashed');
  });

  it('sealed + missing run.json → state="sealed" (sealed wins)', () => {
    makeRun('run-1-aaaaaa', { sealed: true, omitRunJson: true });
    expect(findRun(tmpDir, 'run-1-aaaaaa')?.state).toBe('sealed');
  });
});

describe('filter helpers', () => {
  beforeEach(() => {
    makeRun('run-1-live01', { pid: process.pid });
    makeRun('run-2-dead01', { pid: 2 ** 22 + 7 });
    makeRun('run-3-seal01', { sealed: true });
    makeRun('run-4-seal02', { sealed: true });
  });

  it('liveRuns returns only live', () => {
    expect(liveRuns(tmpDir).map((r) => r.runId)).toEqual(['run-1-live01']);
  });

  it('crashedRuns returns only crashed', () => {
    expect(crashedRuns(tmpDir).map((r) => r.runId)).toEqual(['run-2-dead01']);
  });

  it('sealedRuns returns only sealed', () => {
    expect(
      sealedRuns(tmpDir)
        .map((r) => r.runId)
        .sort(),
    ).toEqual(['run-3-seal01', 'run-4-seal02']);
  });
});

describe('resolveRetentionLimit', () => {
  it('defaults to 10 when ART_KEEP_RUNS unset', async () => {
    delete process.env.ART_KEEP_RUNS;
    const { resolveRetentionLimit } = await import('../../src/run-registry.js');
    expect(resolveRetentionLimit()).toBe(10);
  });

  it('respects ART_KEEP_RUNS', async () => {
    process.env.ART_KEEP_RUNS = '3';
    const { resolveRetentionLimit } = await import('../../src/run-registry.js');
    expect(resolveRetentionLimit()).toBe(3);
    delete process.env.ART_KEEP_RUNS;
  });

  it('disables retention on negative or non-numeric values', async () => {
    process.env.ART_KEEP_RUNS = '-1';
    const { resolveRetentionLimit } = await import('../../src/run-registry.js');
    expect(resolveRetentionLimit()).toBe(Number.POSITIVE_INFINITY);
    process.env.ART_KEEP_RUNS = 'abc';
    expect(resolveRetentionLimit()).toBe(Number.POSITIVE_INFINITY);
    delete process.env.ART_KEEP_RUNS;
  });
});

describe('sweepSealedRuns', () => {
  it('keeps newest N sealed runs and deletes the rest', async () => {
    for (let i = 1; i <= 5; i++) {
      makeRun(`run-${1000 + i}-aaaaaa`, { sealed: true });
    }
    const { sweepSealedRuns } = await import('../../src/run-registry.js');
    const deleted = sweepSealedRuns(tmpDir, 2);
    // Newest two (sorted desc): run-1005-, run-1004-. Older three deleted.
    expect(deleted.sort()).toEqual(
      ['run-1001-aaaaaa', 'run-1002-aaaaaa', 'run-1003-aaaaaa'].sort(),
    );
    const remaining = fs
      .readdirSync(path.join(tmpDir, 'runs'))
      .filter((f) => f.startsWith('run-'))
      .sort();
    expect(remaining).toEqual(['run-1004-aaaaaa', 'run-1005-aaaaaa']);
  });

  it('does not delete live or crashed runs (only sealed are eligible)', async () => {
    makeRun('run-1-aaaaaa', { sealed: true });
    makeRun('run-2-aaaaaa', { sealed: true });
    makeRun('run-3-aaaaaa', { pid: process.pid }); // live
    makeRun('run-4-aaaaaa', { pid: 2 ** 22 + 9 }); // crashed
    const { sweepSealedRuns } = await import('../../src/run-registry.js');
    const deleted = sweepSealedRuns(tmpDir, 1);
    expect(deleted).toEqual(['run-1-aaaaaa']); // only the older sealed
    const remaining = fs.readdirSync(path.join(tmpDir, 'runs')).sort();
    expect(remaining).toEqual(['run-2-aaaaaa', 'run-3-aaaaaa', 'run-4-aaaaaa']);
  });

  it('returns [] when count is below the keep limit', async () => {
    makeRun('run-1-aaaaaa', { sealed: true });
    const { sweepSealedRuns } = await import('../../src/run-registry.js');
    expect(sweepSealedRuns(tmpDir, 10)).toEqual([]);
  });

  it('keeps everything when keep is Infinity', async () => {
    makeRun('run-1-aaaaaa', { sealed: true });
    const { sweepSealedRuns } = await import('../../src/run-registry.js');
    expect(sweepSealedRuns(tmpDir, Number.POSITIVE_INFINITY)).toEqual([]);
  });
});

describe('findRun', () => {
  it('returns null when run dir does not exist', () => {
    expect(findRun(tmpDir, 'run-nope')).toBeNull();
  });

  it('returns classified header for existing run', () => {
    makeRun('run-1-aaaaaa', { sealed: true });
    const r = findRun(tmpDir, 'run-1-aaaaaa');
    expect(r).toMatchObject({
      runId: 'run-1-aaaaaa',
      state: 'sealed',
    });
  });
});
