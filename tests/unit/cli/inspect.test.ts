import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { inspect } from '../../../src/cli/inspect.js';

let tmpDir: string;
let stateDir: string;
let logs: string[];
let errs: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-inspect-test-'));
  stateDir = path.join(tmpDir, '__art__', '.state');
  fs.mkdirSync(path.join(stateDir, 'runs'), { recursive: true });
  logs = [];
  errs = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => {
    logs.push(a.join(' '));
  });
  errSpy = vi.spyOn(console, 'error').mockImplementation((...a) => {
    errs.push(a.join(' '));
  });
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
});

function makeRun(
  runId: string,
  opts: {
    sealed?: boolean;
    summary?: Record<string, unknown>;
    runJson?: Record<string, unknown>;
    stages?: Record<string, Record<string, unknown>>;
    events?: Array<Record<string, unknown>>;
  },
): void {
  const runDir = path.join(stateDir, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'run.json'),
    JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      hostname: os.hostname(),
      startTime: '2026-01-01T00:00:00.000Z',
      ...opts.runJson,
    }),
  );
  if (opts.sealed) fs.writeFileSync(path.join(runDir, 'sealed'), '');
  if (opts.summary) {
    fs.writeFileSync(
      path.join(runDir, 'summary.json'),
      JSON.stringify({ schemaVersion: 1, ...opts.summary }),
    );
  }
  if (opts.stages) {
    for (const [stageName, rec] of Object.entries(opts.stages)) {
      const sd = path.join(runDir, 'nodes', 'root', 'stages', stageName);
      fs.mkdirSync(sd, { recursive: true });
      fs.writeFileSync(
        path.join(sd, 'stage.json'),
        JSON.stringify({
          schemaVersion: 1,
          stageName,
          nodeId: 'root',
          ...rec,
        }),
      );
    }
  }
  if (opts.events) {
    fs.writeFileSync(
      path.join(runDir, 'events.jsonl'),
      opts.events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
  }
}

describe('art inspect (no runId)', () => {
  it('lists empty when no runs', async () => {
    await inspect(undefined, { project: tmpDir });
    expect(logs.join('\n')).toContain('No runs found.');
  });

  it('lists runs newest-first with summary outcome', async () => {
    makeRun('run-100-aaaaaa', {
      sealed: true,
      summary: { outcome: 'success', totalStages: 2, failedStages: 0 },
    });
    makeRun('run-200-bbbbbb', {
      sealed: true,
      summary: { outcome: 'error', totalStages: 3, failedStages: 1 },
    });

    await inspect(undefined, { project: tmpDir });
    const text = logs.join('\n');
    // Newest first: run-200 above run-100
    const i200 = text.indexOf('run-200-bbbbbb');
    const i100 = text.indexOf('run-100-aaaaaa');
    expect(i200).toBeGreaterThan(-1);
    expect(i100).toBeGreaterThan(i200);
    expect(text).toContain('success');
    expect(text).toContain('error');
    expect(text).toContain('2/2'); // success stages
    expect(text).toContain('2/3'); // success/total with 1 failure
  });
});

describe('art inspect <runId>', () => {
  it('prints header + stages + decisions for a sealed run', async () => {
    makeRun('run-100-aaaaaa', {
      sealed: true,
      runJson: { provider: 'codex', hostname: 'test-host' },
      summary: {
        outcome: 'success',
        endTime: '2026-01-01T00:01:00.000Z',
        durationMs: 60_000,
        totalStages: 2,
        failedStages: 0,
      },
      stages: {
        build: {
          result: 'success',
          matchedMarker: 'STAGE_COMPLETE',
          durationMs: 30_000,
          finishedAt: '2026-01-01T00:00:30.000Z',
        },
        verify: {
          result: 'success',
          matchedMarker: 'VERIFY_PASS',
          durationMs: 25_000,
          finishedAt: '2026-01-01T00:00:55.000Z',
        },
      },
      events: [
        {
          time: '2026-01-01T00:00:05.000Z',
          type: 'decision.marker',
          stageName: 'build',
          message: 'marker STAGE_COMPLETE',
        },
        {
          time: '2026-01-01T00:00:35.000Z',
          type: 'decision.marker',
          stageName: 'verify',
          message: 'marker VERIFY_PASS',
        },
      ],
    });

    await inspect('run-100-aaaaaa', { project: tmpDir });
    const text = logs.join('\n');
    expect(text).toContain('Run:       run-100-aaaaaa');
    expect(text).toContain('State:     sealed');
    expect(text).toContain('Outcome:   success');
    expect(text).toContain('Stages:    2/2 succeeded');
    expect(text).toContain('Provider:  codex');
    expect(text).toContain('build');
    expect(text).toContain('verify');
    expect(text).toContain('STAGE_COMPLETE');
    expect(text).toContain('Decisions:');
    expect(text).toContain('decision.marker');
  });

  it('--events prints raw events.jsonl as JSON lines', async () => {
    makeRun('run-100-aaaaaa', {
      sealed: true,
      events: [
        { time: '2026-01-01T00:00:00.000Z', type: 'stage.start' },
        { time: '2026-01-01T00:00:01.000Z', type: 'stage.end' },
      ],
    });
    await inspect('run-100-aaaaaa', { project: tmpDir, events: true });
    expect(logs).toHaveLength(2);
    expect(JSON.parse(logs[0]).type).toBe('stage.start');
    expect(JSON.parse(logs[1]).type).toBe('stage.end');
  });

  it('exits non-zero on missing runId', async () => {
    await expect(inspect('run-nope', { project: tmpDir })).rejects.toThrow(
      'process.exit(1)',
    );
    expect(errs.join('\n')).toContain('Run not found');
  });

  it('exits non-zero when state dir is absent', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-empty-'));
    await expect(inspect(undefined, { project: empty })).rejects.toThrow(
      'process.exit(1)',
    );
    fs.rmSync(empty, { recursive: true, force: true });
  });
});
