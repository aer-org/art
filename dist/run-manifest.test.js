import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { generateRunId, writeCurrentRun, readCurrentRun, removeCurrentRun, writeRunManifest, readRunManifest, listRunManifests, isPidAlive, } from './run-manifest.js';
let tmpDir;
beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-manifest-test-'));
});
afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
describe('generateRunId', () => {
    it('returns run-{timestamp}-{6 hex chars} format', () => {
        const id = generateRunId();
        expect(id).toMatch(/^run-\d+-[0-9a-f]{6}$/);
    });
    it('produces unique IDs on consecutive calls', () => {
        const a = generateRunId();
        const b = generateRunId();
        expect(a).not.toBe(b);
    });
});
describe('writeCurrentRun / readCurrentRun', () => {
    it('roundtrips current run info', () => {
        const info = {
            runId: 'run-123-abcdef',
            pid: 9999,
            startTime: new Date().toISOString(),
        };
        writeCurrentRun(tmpDir, info);
        const result = readCurrentRun(tmpDir);
        expect(result).toEqual(info);
    });
});
describe('readCurrentRun', () => {
    it('returns null for nonexistent dir', () => {
        const result = readCurrentRun(path.join(tmpDir, 'does-not-exist'));
        expect(result).toBeNull();
    });
});
describe('removeCurrentRun', () => {
    it('removes file so subsequent read returns null', () => {
        const info = {
            runId: 'run-123-abcdef',
            pid: 9999,
            startTime: new Date().toISOString(),
        };
        writeCurrentRun(tmpDir, info);
        removeCurrentRun(tmpDir);
        expect(readCurrentRun(tmpDir)).toBeNull();
    });
    it('does not throw on nonexistent file', () => {
        expect(() => removeCurrentRun(path.join(tmpDir, 'nope'))).not.toThrow();
    });
});
describe('writeRunManifest / readRunManifest', () => {
    it('roundtrips a run manifest', () => {
        const manifest = {
            runId: 'run-100-aaaaaa',
            pid: 1234,
            startTime: '2026-01-01T00:00:00.000Z',
            status: 'success',
            stages: [{ name: 'build', status: 'success', duration: 5000 }],
            logFile: '/tmp/log.txt',
        };
        writeRunManifest(tmpDir, manifest);
        const result = readRunManifest(tmpDir, manifest.runId);
        expect(result).toEqual(manifest);
    });
});
describe('readRunManifest', () => {
    it('returns null for nonexistent run', () => {
        const result = readRunManifest(tmpDir, 'run-999-ffffff');
        expect(result).toBeNull();
    });
});
describe('listRunManifests', () => {
    it('returns manifests sorted in reverse chronological order', () => {
        const m1 = {
            runId: 'run-1000-aaaaaa',
            pid: 1,
            startTime: '2026-01-01T00:00:00.000Z',
            status: 'success',
            stages: [],
        };
        const m2 = {
            runId: 'run-2000-bbbbbb',
            pid: 2,
            startTime: '2026-01-02T00:00:00.000Z',
            status: 'error',
            stages: [],
        };
        const m3 = {
            runId: 'run-3000-cccccc',
            pid: 3,
            startTime: '2026-01-03T00:00:00.000Z',
            status: 'running',
            stages: [],
        };
        // Write in non-sorted order
        writeRunManifest(tmpDir, m1);
        writeRunManifest(tmpDir, m3);
        writeRunManifest(tmpDir, m2);
        const list = listRunManifests(tmpDir);
        expect(list).toHaveLength(3);
        expect(list[0].runId).toBe('run-3000-cccccc');
        expect(list[1].runId).toBe('run-2000-bbbbbb');
        expect(list[2].runId).toBe('run-1000-aaaaaa');
    });
    it('returns empty array for nonexistent dir', () => {
        const result = listRunManifests(path.join(tmpDir, 'nope'));
        expect(result).toEqual([]);
    });
});
describe('isPidAlive', () => {
    it('returns true for current process PID', () => {
        expect(isPidAlive(process.pid)).toBe(true);
    });
    it('returns false for a very large non-existent PID', () => {
        expect(isPidAlive(4_000_000)).toBe(false);
    });
});
//# sourceMappingURL=run-manifest.test.js.map