import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setDataDir } from '../../src/config.js';
import { createStageIpcEndpoint } from '../../src/stage-ipc.js';

describe('StageIpcEndpoint', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-ipc-'));
    setDataDir(dataDir);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('writes host-to-container messages and close sentinels', () => {
    const endpoint = createStageIpcEndpoint('group-a');

    endpoint.sendToContainer('hello container');

    const files = fs
      .readdirSync(endpoint.inputDir)
      .filter((file) => file.endsWith('.json'));
    expect(files).toHaveLength(1);
    const message = JSON.parse(
      fs.readFileSync(path.join(endpoint.inputDir, files[0]), 'utf8'),
    );
    expect(message).toMatchObject({
      type: 'message',
      text: 'hello container',
    });
    expect(typeof message.timestamp).toBe('string');

    endpoint.closeContainerInput();
    expect(fs.existsSync(path.join(endpoint.inputDir, '_close'))).toBe(true);

    endpoint.clearCloseSentinel();
    expect(fs.existsSync(path.join(endpoint.inputDir, '_close'))).toBe(false);
  });

  it('drains container-to-host messages', () => {
    const endpoint = createStageIpcEndpoint('group-b');

    endpoint.writeFromContainer({
      type: 'message',
      text: 'hello host',
      sender: 'worker',
    });

    expect(endpoint.drainFromContainer()).toMatchObject([
      {
        type: 'message',
        text: 'hello host',
        sender: 'worker',
      },
    ]);
    expect(
      fs
        .readdirSync(endpoint.messagesDir)
        .filter((file) => file.endsWith('.json')),
    ).toHaveLength(0);
  });
});
