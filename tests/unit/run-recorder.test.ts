import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  RunRecorder,
  generateRunId,
  setActiveRecorder,
  getActiveRecorder,
} from '../../src/run-recorder.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-recorder-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setActiveRecorder(null);
});

describe('generateRunId', () => {
  it('returns run-{timestamp}-{6 hex chars}', () => {
    expect(generateRunId()).toMatch(/^run-\d+-[0-9a-f]{6}$/);
  });

  it('produces distinct IDs on consecutive calls', () => {
    expect(generateRunId()).not.toBe(generateRunId());
  });
});

describe('RunRecorder.create', () => {
  it('creates runs/<id>/ + state/ directory and writes run.json with metadata', () => {
    const r = RunRecorder.create({
      stateDir: tmpDir,
      runId: 'run-100-aaaaaa',
      init: { provider: 'codex', image: 'art-agent:latest', args: ['run'] },
    });
    expect(r.runId).toBe('run-100-aaaaaa');
    expect(r.runDir).toBe(path.join(tmpDir, 'runs', 'run-100-aaaaaa'));
    expect(fs.existsSync(r.runDir)).toBe(true);
    expect(fs.existsSync(r.stateDir())).toBe(true);

    const meta = JSON.parse(
      fs.readFileSync(path.join(r.runDir, 'run.json'), 'utf-8'),
    );
    expect(meta.pid).toBe(process.pid);
    expect(meta.hostname).toBe(os.hostname());
    expect(meta.startTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(meta.provider).toBe('codex');
    expect(meta.image).toBe('art-agent:latest');
    expect(meta.args).toEqual(['run']);
  });

  it('auto-generates runId when omitted', () => {
    const r = RunRecorder.create({ stateDir: tmpDir, init: {} });
    expect(r.runId).toMatch(/^run-\d+-[0-9a-f]{6}$/);
  });

  it('stateDir() returns runs/<id>/state', () => {
    const r = RunRecorder.create({
      stateDir: tmpDir,
      runId: 'run-1-aaaaaa',
      init: {},
    });
    expect(r.stateDir()).toBe(
      path.join(tmpDir, 'runs', 'run-1-aaaaaa', 'state'),
    );
  });
});

describe('RunRecorder.event', () => {
  it('appends one JSONL line per event with timestamp', () => {
    const r = RunRecorder.create({
      stateDir: tmpDir,
      runId: 'run-1-aaaaaa',
      init: {},
    });
    r.event({ level: 'info', type: 'stage.start', stageName: 'build' });
    r.event({ level: 'info', type: 'stage.end', stageName: 'build' });

    const raw = fs.readFileSync(path.join(r.runDir, 'events.jsonl'), 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    const e1 = JSON.parse(lines[0]);
    const e2 = JSON.parse(lines[1]);
    expect(e1.type).toBe('stage.start');
    expect(e1.stageName).toBe('build');
    expect(e1.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(e2.type).toBe('stage.end');
  });

  it('after finalize, events become no-ops (best-effort)', () => {
    const r = RunRecorder.create({
      stateDir: tmpDir,
      runId: 'run-1-aaaaaa',
      init: {},
    });
    r.event({ level: 'info', type: 'before' });
    r.finalize({
      outcome: 'success',
      endTime: new Date().toISOString(),
      durationMs: 0,
      totalStages: 0,
      failedStages: 0,
    });
    expect(() => r.event({ level: 'info', type: 'after' })).not.toThrow();

    const raw = fs.readFileSync(path.join(r.runDir, 'events.jsonl'), 'utf-8');
    expect(raw).toContain('"before"');
    expect(raw).not.toContain('"after"');
  });

  it('console.error on event write failure does not throw', () => {
    const r = RunRecorder.create({
      stateDir: tmpDir,
      runId: 'run-1-aaaaaa',
      init: {},
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const appendSpy = vi
      .spyOn(fs, 'appendFileSync')
      .mockImplementationOnce(() => {
        throw new Error('boom');
      });
    expect(() => r.event({ level: 'error', type: 'whatever' })).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    appendSpy.mockRestore();
    errSpy.mockRestore();
  });
});

describe('RunRecorder.finalize', () => {
  it('writes summary.json and sealed marker', () => {
    const r = RunRecorder.create({
      stateDir: tmpDir,
      runId: 'run-1-aaaaaa',
      init: {},
    });
    r.finalize({
      outcome: 'success',
      endTime: '2026-01-01T00:00:00.000Z',
      durationMs: 1234,
      totalStages: 3,
      failedStages: 0,
    });
    expect(fs.existsSync(path.join(r.runDir, 'sealed'))).toBe(true);
    const summary = JSON.parse(
      fs.readFileSync(path.join(r.runDir, 'summary.json'), 'utf-8'),
    );
    expect(summary).toEqual({
      outcome: 'success',
      endTime: '2026-01-01T00:00:00.000Z',
      durationMs: 1234,
      totalStages: 3,
      failedStages: 0,
    });
    expect(r.isFinalized()).toBe(true);
  });

  it('is idempotent (second call does nothing)', () => {
    const r = RunRecorder.create({
      stateDir: tmpDir,
      runId: 'run-1-aaaaaa',
      init: {},
    });
    r.finalize({
      outcome: 'success',
      endTime: '2026-01-01T00:00:00.000Z',
      durationMs: 1,
      totalStages: 0,
      failedStages: 0,
    });
    const firstSealedStat = fs.statSync(path.join(r.runDir, 'sealed'));
    r.finalize({
      outcome: 'error',
      endTime: '2026-01-02T00:00:00.000Z',
      durationMs: 9999,
      totalStages: 99,
      failedStages: 99,
    });
    const secondSealedStat = fs.statSync(path.join(r.runDir, 'sealed'));
    expect(secondSealedStat.mtimeMs).toBe(firstSealedStat.mtimeMs);
    const summary = JSON.parse(
      fs.readFileSync(path.join(r.runDir, 'summary.json'), 'utf-8'),
    );
    expect(summary.outcome).toBe('success');
  });
});

describe('RunRecorder.reattach', () => {
  it('reopens an existing run dir', () => {
    const original = RunRecorder.create({
      stateDir: tmpDir,
      runId: 'run-1-aaaaaa',
      init: {},
    });
    original.event({ level: 'info', type: 'before-restart' });

    const reattached = RunRecorder.reattach(tmpDir, 'run-1-aaaaaa');
    expect(reattached).not.toBeNull();
    reattached!.event({ level: 'info', type: 'after-restart' });
    reattached!.finalize({
      outcome: 'success',
      endTime: new Date().toISOString(),
      durationMs: 0,
      totalStages: 0,
      failedStages: 0,
    });

    const raw = fs.readFileSync(
      path.join(original.runDir, 'events.jsonl'),
      'utf-8',
    );
    expect(raw).toContain('before-restart');
    expect(raw).toContain('after-restart');
  });

  it('returns null for missing run dir', () => {
    expect(RunRecorder.reattach(tmpDir, 'run-nope')).toBeNull();
  });
});

describe('active recorder hook', () => {
  it('setActiveRecorder / getActiveRecorder roundtrip', () => {
    const r = RunRecorder.create({
      stateDir: tmpDir,
      runId: 'run-1-aaaaaa',
      init: {},
    });
    expect(getActiveRecorder()).toBeNull();
    setActiveRecorder(r);
    expect(getActiveRecorder()).toBe(r);
    setActiveRecorder(null);
    expect(getActiveRecorder()).toBeNull();
  });
});
