export interface RegisteredImage {
    image: string;
    hasAgent: boolean;
    baseImage?: string;
    contentHash?: string;
}
export type ImageRegistry = Record<string, RegisteredImage>;
export declare function loadImageRegistry(): ImageRegistry;
export declare function saveImageRegistry(registry: ImageRegistry): void;
/**
 * Resolve docker image name for a stage.
 * - If stageImage is a registry key, resolve it.
 * - If stageImage is not in registry, return it as-is (for command mode).
 * - If no stageImage, use "default".
 */
export declare function getImageForStage(stageImage?: string, isCommandMode?: boolean): string;
//# sourceMappingURL=image-registry.d.ts.map