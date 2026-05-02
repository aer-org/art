import { describe, it, expect, beforeEach } from 'vitest';
import {
  ART_DIR_NAME,
  setDataDir,
  getDataDir,
  getPackageAssetPath,
  getCredentialProxyPort,
  setCredentialProxyPort,
} from '../../src/config.js';
import path from 'path';

describe('config', () => {
  describe('ART_DIR_NAME', () => {
    it('is __art__', () => {
      expect(ART_DIR_NAME).toBe('__art__');
    });
  });

  describe('setDataDir / getDataDir', () => {
    it('returns the configured data directory', () => {
      setDataDir('/tmp/custom-data');
      expect(getDataDir()).toBe(path.resolve('/tmp/custom-data'));
    });

    it('resolves relative paths', () => {
      setDataDir('./relative-data');
      expect(getDataDir()).toBe(path.resolve('./relative-data'));
    });
  });

  describe('getPackageAssetPath', () => {
    it('resolves under the package install root', () => {
      const buildScript = getPackageAssetPath('container', 'build.sh');
      expect(path.isAbsolute(buildScript)).toBe(true);
      expect(buildScript.endsWith(path.join('container', 'build.sh'))).toBe(
        true,
      );
    });

    it('returns the package root when called with no args', () => {
      const root = getPackageAssetPath();
      expect(path.isAbsolute(root)).toBe(true);
    });
  });

  describe('credential proxy port', () => {
    beforeEach(() => {
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
      const config = await import('../../src/config.js');
      if (!process.env.CONTAINER_IMAGE) {
        expect(config.CONTAINER_IMAGE).toBe('art-agent:latest');
      }
    });
  });
});
