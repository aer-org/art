import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { generateRunId, writeRunManifest, readRunManifest, listRunManifests, } from './run-manifest.js';
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
//# sourceMappingURL=run-manifest.test.js.map