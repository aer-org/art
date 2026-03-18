/**
 * art update — Pull latest container images from registry.
 * For udocker: downloads pre-built tar from GitHub Release (udocker pull
 * can't reliably merge multi-layer images).
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadImageRegistry, saveImageRegistry, } from '../image-registry.js';
import { initRuntime } from '../container-runtime.js';
const TAR_RELEASE_URL = 'https://github.com/aer-org/art/releases/download/container-latest/art-agent.tar.gz';
function udockerLoadFromTar(runtimeBin, image) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-update-'));
    const tarPath = path.join(tmpDir, 'art-agent.tar.gz');
    try {
        console.log('  downloading tar from release...');
        execSync(`curl -fSL -o ${tarPath} ${TAR_RELEASE_URL}`, {
            stdio: ['pipe', 'inherit', 'inherit'],
            timeout: 600000,
        });
        // Remove existing containers for this image to avoid stale rootfs
        try {
            const ps = execSync(`${runtimeBin} ps`, {
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: 10000,
            });
            for (const line of ps.split('\n')) {
                if (line.includes(image)) {
                    const id = line.trim().split(/\s+/)[0];
                    if (id && id.length > 8) {
                        execSync(`${runtimeBin} rm ${id}`, { stdio: 'pipe' });
                    }
                }
            }
        }
        catch {
            // no existing containers
        }
        // Remove existing image
        try {
            execSync(`${runtimeBin} rmi ${image}`, { stdio: 'pipe' });
        }
        catch {
            // image didn't exist
        }
        console.log('  loading image...');
        const loadOutput = execSync(`${runtimeBin} load -i ${tarPath}`, {
            encoding: 'utf-8',
            timeout: 600000,
        });
        console.log(loadOutput);
        // udocker can't handle slash-heavy registry names (ghcr.io/org/image).
        // Tag the loaded image with a short local name.
        const shortName = 'art-agent:latest';
        const match = loadOutput.match(/\['([^']+)'\]/);
        if (match) {
            const loadedName = match[1];
            if (loadedName !== shortName) {
                try {
                    execSync(`${runtimeBin} tag ${loadedName} ${shortName}`, {
                        stdio: 'pipe',
                        timeout: 10000,
                    });
                    console.log(`  tagged ${loadedName} → ${shortName}`);
                }
                catch {
                    // non-fatal
                }
            }
        }
        // Update image registry to use the short name
        const reg = loadImageRegistry();
        for (const [key, entry] of Object.entries(reg)) {
            if (entry.image === image || entry.image === shortName) {
                reg[key] = { ...entry, image: shortName };
            }
        }
        saveImageRegistry(reg);
        return true;
    }
    catch {
        return false;
    }
    finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}
export async function update() {
    const rt = await initRuntime();
    const registry = loadImageRegistry();
    const images = Object.entries(registry);
    if (images.length === 0) {
        console.log('No images registered. Run `art init` first.');
        return;
    }
    let updated = 0;
    let failed = 0;
    for (const [name, entry] of images) {
        // Skip local-only images (no registry prefix)
        if (!entry.image.includes('/')) {
            console.log(`  skip  ${name} (${entry.image}) — local image`);
            continue;
        }
        console.log(`  pull  ${name} (${entry.image})...`);
        if (rt.kind === 'udocker') {
            // udocker: download pre-built tar from GitHub Release
            if (udockerLoadFromTar(rt.bin, entry.image)) {
                console.log(`  ok    ${name} — updated`);
                updated++;
            }
            else {
                console.error(`  FAIL  ${name} — could not download or load image`);
                failed++;
            }
            continue;
        }
        // Docker/Podman: normal pull with digest comparison
        let digestBefore = null;
        try {
            digestBefore = execSync(`${rt.bin} image inspect --format '{{.Id}}' ${entry.image}`, { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 10000 }).trim();
        }
        catch {
            // image doesn't exist locally yet
        }
        try {
            execSync(`${rt.bin} pull ${entry.image}`, {
                stdio: 'inherit',
                timeout: 600000,
            });
        }
        catch {
            console.error(`  FAIL  ${name} — could not pull ${entry.image}`);
            failed++;
            continue;
        }
        let digestAfter = null;
        try {
            digestAfter = execSync(`${rt.bin} image inspect --format '{{.Id}}' ${entry.image}`, { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 10000 }).trim();
        }
        catch {
            // shouldn't happen after successful pull
        }
        if (digestBefore && digestBefore === digestAfter) {
            console.log(`  ok    ${name} — already up to date`);
        }
        else {
            console.log(`  ok    ${name} — updated`);
            updated++;
        }
    }
    console.log(`\nDone. ${updated} updated, ${failed} failed, ${images.length - updated - failed} unchanged.`);
}
//# sourceMappingURL=update.js.map