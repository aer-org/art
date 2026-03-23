import { describe, it, expect, beforeEach } from 'vitest';
import {
  ART_DIR_NAME,
  setEngineRoot,
  setDataDir,
  getProjectRoot,
  getCredentialProxyPort,
  setCredentialProxyPort,
} from './config.js';
import path from 'path';

describe('config', () => {
  describe('ART_DIR_NAME', () => {
    it('is __art__', () => {
      expect(ART_DIR_NAME).toBe('__art__');
    });
  });

  describe('setEngineRoot / getProjectRoot', () => {
    const original = getProjectRoot();

    beforeEach(() => {
      setEngineRoot(original);
    });

    it('updates project root and derived paths', async () => {
      setEngineRoot('/tmp/test-engine');
      expect(getProjectRoot()).toBe('/tmp/test-engine');

      // Re-import to check STORE_DIR etc. — they are let exports
      const config = await import('./config.js');
      expect(config.STORE_DIR).toBe(path.resolve('/tmp/test-engine', 'store'));
      expect(config.GROUPS_DIR).toBe(
        path.resolve('/tmp/test-engine', 'groups'),
      );
      expect(config.DATA_DIR).toBe(path.resolve('/tmp/test-engine', 'data'));
    });
  });

  describe('setDataDir', () => {
    it('overrides DATA_DIR independently', async () => {
      setDataDir('/tmp/custom-data');
      const config = await import('./config.js');
      expect(config.DATA_DIR).toBe(path.resolve('/tmp/custom-data'));
    });
  });

  describe('credential proxy port', () => {
    beforeEach(() => {
      // Reset to default by setting a known value then clearing
      setCredentialProxyPort(3001);
    });

    it('returns set port', () => {
      setCredentialProxyPort(9999);
      expect(getCredentialProxyPort()).toBe(9999);
    });

    it('setCredentialProxyPort overrides env default', () => {
      setCredentialProxyPort(4567);
      expect(getCredentialProxyPort()).toBe(4567);
    });
  });

  describe('CONTAINER_IMAGE', () => {
    it('defaults to art-agent:latest', async () => {
      const config = await import('./config.js');
      // Only check default when env var is not set
      if (!process.env.CONTAINER_IMAGE) {
        expect(config.CONTAINER_IMAGE).toBe('art-agent:latest');
      }
    });
  });
});
