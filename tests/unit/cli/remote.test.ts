import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDirs: string[] = [];
let configDir: string;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-remote-test-'));
  tmpDirs.push(configDir);
});

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('remote CLI', () => {
  // Integration-style tests using real fs through remote-config
  // We test the remote-config module directly since the CLI just delegates

  async function loadRemoteConfig() {
    return import('../../../src/remote-config.js');
  }

  it('add → list → set-default → remove flow works', async () => {
    const { loadRemotes, saveRemotes, getDefaultRemote, getRemote } =
      await loadRemoteConfig();

    // Start empty
    const config = loadRemotes();

    // Add origin
    config.remotes['origin'] = {
      url: 'https://art.example.com',
      default: true,
    };
    saveRemotes(config);

    // Add staging
    config.remotes['staging'] = { url: 'https://staging.example.com' };
    saveRemotes(config);

    // Verify
    const loaded = loadRemotes();
    expect(Object.keys(loaded.remotes)).toHaveLength(2);
    expect(loaded.remotes['origin'].default).toBe(true);

    // Set staging as default
    for (const r of Object.values(loaded.remotes)) delete r.default;
    loaded.remotes['staging'].default = true;
    saveRemotes(loaded);

    const def = getDefaultRemote();
    expect(def?.name).toBe('staging');

    // Remove staging
    delete loaded.remotes['staging'];
    saveRemotes(loaded);
    expect(getRemote('staging')).toBeNull();
  });
});
