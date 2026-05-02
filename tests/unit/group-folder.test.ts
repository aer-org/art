import path from 'path';

import { describe, expect, it } from 'vitest';

import { setDataDir } from '../../src/config.js';
import {
  isValidGroupFolder,
  registerExternalGroupFolder,
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from '../../src/group-folder.js';

describe('group folder validation', () => {
  it('accepts normal group folder names', () => {
    expect(isValidGroupFolder('main')).toBe(true);
    expect(isValidGroupFolder('family-chat')).toBe(true);
    expect(isValidGroupFolder('Team_42')).toBe(true);
  });

  it('rejects traversal and reserved names', () => {
    expect(isValidGroupFolder('../../etc')).toBe(false);
    expect(isValidGroupFolder('/tmp')).toBe(false);
    expect(isValidGroupFolder('global')).toBe(false);
    expect(isValidGroupFolder('')).toBe(false);
  });

  it('throws when resolving an unregistered group folder', () => {
    expect(() => resolveGroupFolderPath('never-registered')).toThrow(
      /No external mapping registered/,
    );
  });

  it('resolves IPC paths under the configured data directory', () => {
    setDataDir('/tmp/aer-art-test-data');
    const resolved = resolveGroupIpcPath('family-chat');
    expect(resolved).toBe(
      path.join('/tmp/aer-art-test-data', 'ipc', 'family-chat'),
    );
  });

  it('throws for unsafe folder names', () => {
    expect(() => resolveGroupFolderPath('../../etc')).toThrow();
    expect(() => resolveGroupIpcPath('/tmp')).toThrow();
  });

  it('inherits external mapping for virtual sub-groups', () => {
    const artDir = path.resolve('/tmp', 'art-test-project', '__art__');
    registerExternalGroupFolder('art-test-project', artDir);

    expect(resolveGroupFolderPath('art-test-project')).toBe(artDir);
    expect(resolveGroupFolderPath('art-test-project__pipeline_build')).toBe(
      path.join(artDir, '.stages', 'pipeline_build'),
    );
    expect(
      resolveGroupFolderPath('art-test-project__abc123__pipeline_build'),
    ).toBe(path.join(artDir, '.stages', 'abc123__pipeline_build'));
  });
});
