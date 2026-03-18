import fs from 'fs';
import path from 'path';

import { CONTAINER_IMAGE, IMAGE_REGISTRY_PATH } from './config.js';
import { resolveLocalImageName } from './container-runtime.js';

export interface RegisteredImage {
  image: string; // Docker image name
  hasAgent: boolean; // Agent stack included
  baseImage?: string; // Original base (for rebuild)
}

export type ImageRegistry = Record<string, RegisteredImage>;

export function loadImageRegistry(): ImageRegistry {
  try {
    const raw = fs.readFileSync(IMAGE_REGISTRY_PATH, 'utf-8');
    return JSON.parse(raw) as ImageRegistry;
  } catch {
    return {};
  }
}

export function saveImageRegistry(registry: ImageRegistry): void {
  fs.mkdirSync(path.dirname(IMAGE_REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(
    IMAGE_REGISTRY_PATH,
    JSON.stringify(registry, null, 2) + '\n',
  );
}

/**
 * Resolve docker image name for a stage.
 * - If stageImage is a registry key, resolve it.
 * - If stageImage is not in registry, return it as-is (for command mode).
 * - If no stageImage, use "default".
 */
export function getImageForStage(
  stageImage?: string,
  isCommandMode = false,
): string {
  if (!stageImage) {
    const registry = loadImageRegistry();
    return resolveLocalImageName(registry['default']?.image || CONTAINER_IMAGE);
  }

  if (isCommandMode) {
    // Command mode: use image name directly (no registry lookup required)
    return resolveLocalImageName(stageImage);
  }

  // Agent mode: try registry lookup first
  const registry = loadImageRegistry();
  const entry = registry[stageImage];
  if (entry) return resolveLocalImageName(entry.image);

  // Not in registry — error for agent mode
  throw new Error(
    `Image "${stageImage}" not registered. Run init to register custom images.`,
  );
}
