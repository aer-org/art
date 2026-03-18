/**
 * art update — Pull latest container images from registry.
 * For udocker: downloads pre-built tar from GitHub Release (udocker pull
 * can't reliably merge multi-layer images).
 */
import { execSync } from 'child_process';

import { loadImageRegistry, saveImageRegistry } from '../image-registry.js';
import {
  downloadAndLoadUdockerImage,
  initRuntime,
  removeImage,
} from '../container-runtime.js';

function udockerUpdateImage(runtimeBin: string, image: string): string | null {
  try {
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
    } catch {
      // no existing containers
    }

    removeImage(image);
    const loadedName = downloadAndLoadUdockerImage(runtimeBin);

    // Update registry with the actual loaded name
    const reg = loadImageRegistry();
    for (const [key, entry] of Object.entries(reg)) {
      if (entry.image === image) {
        reg[key] = { ...entry, image: loadedName };
      }
    }
    saveImageRegistry(reg);

    return loadedName;
  } catch {
    return null;
  }
}

export async function update(): Promise<void> {
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
      const loadedName = udockerUpdateImage(rt.bin, entry.image);
      if (loadedName) {
        console.log(`  ok    ${name} — updated (${loadedName})`);
        updated++;
      } else {
        console.error(`  FAIL  ${name} — could not download or load image`);
        failed++;
      }
      continue;
    }

    // Docker/Podman: normal pull with digest comparison
    let digestBefore: string | null = null;
    try {
      digestBefore = execSync(
        `${rt.bin} image inspect --format '{{.Id}}' ${entry.image}`,
        { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 10000 },
      ).trim();
    } catch {
      // image doesn't exist locally yet
    }

    try {
      execSync(`${rt.bin} pull ${entry.image}`, {
        stdio: 'inherit',
        timeout: 600000,
      });
    } catch {
      console.error(`  FAIL  ${name} — could not pull ${entry.image}`);
      failed++;
      continue;
    }

    let digestAfter: string | null = null;
    try {
      digestAfter = execSync(
        `${rt.bin} image inspect --format '{{.Id}}' ${entry.image}`,
        { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 10000 },
      ).trim();
    } catch {
      // shouldn't happen after successful pull
    }

    if (digestBefore && digestBefore === digestAfter) {
      console.log(`  ok    ${name} — already up to date`);
    } else {
      console.log(`  ok    ${name} — updated`);
      updated++;
    }
  }

  console.log(
    `\nDone. ${updated} updated, ${failed} failed, ${images.length - updated - failed} unchanged.`,
  );
}
