/**
 * art update — Rebuild all registered container images locally.
 * All images are built via container/build.sh (no remote registry pulls).
 */
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadImageRegistry } from '../image-registry.js';
import { initRuntime } from '../container-runtime.js';
export async function update() {
    const rt = await initRuntime();
    const registry = loadImageRegistry();
    const images = Object.entries(registry);
    if (images.length === 0) {
        console.log('No images registered. Run `art compose` first.');
        return;
    }
    // Derive engine root for build script path
    const thisFile = fileURLToPath(import.meta.url);
    const engineRoot = path.resolve(path.dirname(thisFile), '..', '..');
    const scriptDir = path.resolve(engineRoot, 'container');
    let rebuilt = 0;
    let failed = 0;
    for (const [name, entry] of images) {
        console.log(`  build  ${name} (${entry.image})...`);
        const buildCmd = name === 'default' || !entry.baseImage
            ? `${scriptDir}/build.sh`
            : `${scriptDir}/build.sh ${name} ${entry.baseImage}`;
        try {
            execSync(buildCmd, {
                stdio: 'inherit',
                timeout: 600000,
                env: { ...process.env, CONTAINER_RUNTIME: rt.bin },
            });
            console.log(`  ok    ${name} — rebuilt`);
            rebuilt++;
        }
        catch {
            console.error(`  FAIL  ${name} — build failed`);
            failed++;
        }
    }
    console.log(`\nDone. ${rebuilt} rebuilt, ${failed} failed.`);
}
//# sourceMappingURL=update.js.map