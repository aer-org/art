import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'art-agent:latest',
  IMAGE_REGISTRY_PATH: '/mock/.config/aer-art/images.json',
}));

describe('image-registry', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.mkdirSync).mockReset();
  });

  async function loadModule() {
    return import('./image-registry.js');
  }

  describe('loadImageRegistry', () => {
    it('returns empty object when file does not exist', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const { loadImageRegistry } = await loadModule();
      expect(loadImageRegistry()).toEqual({});
    });

    it('parses valid JSON file', async () => {
      const registry = {
        default: { image: 'my-image:v1', hasAgent: true },
        custom: {
          image: 'custom:latest',
          hasAgent: false,
          baseImage: 'ubuntu',
        },
      };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(registry));
      const { loadImageRegistry } = await loadModule();
      expect(loadImageRegistry()).toEqual(registry);
    });
  });

  describe('saveImageRegistry', () => {
    it('writes JSON and creates parent dirs', async () => {
      const { saveImageRegistry } = await loadModule();
      const registry = {
        default: { image: 'my-image:v1', hasAgent: true },
      };
      saveImageRegistry(registry);

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        path.dirname('/mock/.config/aer-art/images.json'),
        { recursive: true },
      );
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/mock/.config/aer-art/images.json',
        JSON.stringify(registry, null, 2) + '\n',
      );
    });
  });

  describe('getImageForStage', () => {
    it('no stageImage, no registry → returns CONTAINER_IMAGE', async () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const { getImageForStage } = await loadModule();
      expect(getImageForStage()).toBe('art-agent:latest');
    });

    it('no stageImage, registry has default → returns default image', async () => {
      const registry = {
        default: { image: 'my-default:v2', hasAgent: true },
      };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(registry));
      const { getImageForStage } = await loadModule();
      expect(getImageForStage()).toBe('my-default:v2');
    });

    it('isCommandMode → returns stageImage as-is', async () => {
      const { getImageForStage } = await loadModule();
      expect(getImageForStage('ubuntu:22.04', true)).toBe('ubuntu:22.04');
    });

    it('agent mode, found in registry → returns registry image', async () => {
      const registry = {
        mykey: { image: 'resolved-image:v3', hasAgent: true },
      };
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(registry));
      const { getImageForStage } = await loadModule();
      expect(getImageForStage('mykey')).toBe('resolved-image:v3');
    });

    it('agent mode, not in registry → returns stageImage as-is', async () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));
      const { getImageForStage } = await loadModule();
      expect(getImageForStage('some-direct-image:latest')).toBe(
        'some-direct-image:latest',
      );
    });
  });
});
