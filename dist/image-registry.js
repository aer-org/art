import fs from 'fs';
import path from 'path';
import { CONTAINER_IMAGE, IMAGE_REGISTRY_PATH } from './config.js';
export function loadImageRegistry() {
    try {
        const raw = fs.readFileSync(IMAGE_REGISTRY_PATH, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
export function saveImageRegistry(registry) {
    fs.mkdirSync(path.dirname(IMAGE_REGISTRY_PATH), { recursive: true });
    fs.writeFileSync(IMAGE_REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
}
/**
 * Resolve docker image name for a stage.
 * - If stageImage is a registry key, resolve it.
 * - If stageImage is not in registry, return it as-is (for command mode).
 * - If no stageImage, use "default".
 */
export function getImageForStage(stageImage, isCommandMode = false) {
    if (!stageImage) {
        const registry = loadImageRegistry();
        return registry['default']?.image || CONTAINER_IMAGE;
    }
    if (isCommandMode) {
        return stageImage;
    }
    // Agent mode: try registry lookup first
    const registry = loadImageRegistry();
    const entry = registry[stageImage];
    if (entry)
        return entry.image;
    // Not in registry — treat as direct Docker image name
    return stageImage;
}
//# sourceMappingURL=image-registry.js.map