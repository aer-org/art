/**
 * Run manifest and current-run persistence.
 *
 * CRUD helpers for pipeline run tracking:
 * - _current.json: which run is active (PID guard)
 * - {runId}.json: per-run manifest with stage history
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
// --- Run ID ---
export function generateRunId() {
    return `run-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}
// --- Helpers ---
function runsDir(groupDir) {
    return path.join(groupDir, 'runs');
}
// --- Current Run ---
export function writeCurrentRun(groupDir, info) {
    const dir = runsDir(groupDir);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = path.join(dir, '_current.json.tmp');
    const filePath = path.join(dir, '_current.json');
    fs.writeFileSync(tmpPath, JSON.stringify(info, null, 2));
    fs.renameSync(tmpPath, filePath);
}
export function readCurrentRun(groupDir) {
    try {
        const raw = fs.readFileSync(path.join(runsDir(groupDir), '_current.json'), 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
export function removeCurrentRun(groupDir) {
    try {
        fs.unlinkSync(path.join(runsDir(groupDir), '_current.json'));
    }
    catch {
        /* file may not exist */
    }
}
// --- Run Manifest ---
export function writeRunManifest(groupDir, manifest) {
    const dir = runsDir(groupDir);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${manifest.runId}.json`);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2));
    fs.renameSync(tmpPath, filePath);
}
export function readRunManifest(groupDir, runId) {
    try {
        const raw = fs.readFileSync(path.join(runsDir(groupDir), `${runId}.json`), 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
export function listRunManifests(groupDir) {
    const dir = runsDir(groupDir);
    if (!fs.existsSync(dir))
        return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.startsWith('run-') && f.endsWith('.json'))
        .sort()
        .reverse()
        .map((f) => {
        try {
            return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        }
        catch {
            return null;
        }
    })
        .filter((m) => m !== null);
}
// --- PID ---
export function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=run-manifest.js.map