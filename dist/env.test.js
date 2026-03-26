import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
// Mock logger to avoid pino initialization side effects
vi.mock('./logger.js', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import { readEnvFile } from './env.js';
describe('readEnvFile', () => {
    const originalCwd = process.cwd();
    let tmpDir;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join('/tmp', 'env-test-'));
        vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    });
    afterEach(() => {
        vi.restoreAllMocks();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    it('returns empty object when .env does not exist', () => {
        const result = readEnvFile(['FOO']);
        expect(result).toEqual({});
    });
    it('reads requested keys from .env', () => {
        fs.writeFileSync(path.join(tmpDir, '.env'), 'FOO=bar\nBAZ=qux\n');
        const result = readEnvFile(['FOO', 'BAZ']);
        expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
    });
    it('ignores keys not in the requested list', () => {
        fs.writeFileSync(path.join(tmpDir, '.env'), 'FOO=bar\nSECRET=hidden\n');
        const result = readEnvFile(['FOO']);
        expect(result).toEqual({ FOO: 'bar' });
    });
    it('skips comments and blank lines', () => {
        fs.writeFileSync(path.join(tmpDir, '.env'), '# comment\n\nFOO=bar\n  # another\n');
        const result = readEnvFile(['FOO']);
        expect(result).toEqual({ FOO: 'bar' });
    });
    it('strips double quotes from values', () => {
        fs.writeFileSync(path.join(tmpDir, '.env'), 'FOO="hello world"\n');
        const result = readEnvFile(['FOO']);
        expect(result).toEqual({ FOO: 'hello world' });
    });
    it('strips single quotes from values', () => {
        fs.writeFileSync(path.join(tmpDir, '.env'), "FOO='hello world'\n");
        const result = readEnvFile(['FOO']);
        expect(result).toEqual({ FOO: 'hello world' });
    });
    it('handles values with = sign', () => {
        fs.writeFileSync(path.join(tmpDir, '.env'), 'FOO=bar=baz\n');
        const result = readEnvFile(['FOO']);
        expect(result).toEqual({ FOO: 'bar=baz' });
    });
    it('skips lines without = sign', () => {
        fs.writeFileSync(path.join(tmpDir, '.env'), 'INVALID_LINE\nFOO=bar\n');
        const result = readEnvFile(['FOO']);
        expect(result).toEqual({ FOO: 'bar' });
    });
    it('skips keys with empty values', () => {
        fs.writeFileSync(path.join(tmpDir, '.env'), 'FOO=\nBAR=val\n');
        const result = readEnvFile(['FOO', 'BAR']);
        expect(result).toEqual({ BAR: 'val' });
    });
});
//# sourceMappingURL=env.test.js.map