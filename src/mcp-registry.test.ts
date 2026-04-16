import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadMcpRegistry,
  resolveStageMcpServers,
  validateStageMcpAccess,
} from './mcp-registry.js';

describe('mcp-registry', () => {
  let tmpDir: string;
  let registryPath: string;
  const previousRegistryPath = process.env.ART_MCP_REGISTRY_PATH;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-mcp-registry-'));
    registryPath = path.join(tmpDir, 'mcp-registry.json');
    process.env.ART_MCP_REGISTRY_PATH = registryPath;
  });

  afterEach(() => {
    if (typeof previousRegistryPath === 'string') {
      process.env.ART_MCP_REGISTRY_PATH = previousRegistryPath;
    } else {
      delete process.env.ART_MCP_REGISTRY_PATH;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads stdio and http registry entries', () => {
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        'sqlite.read': {
          name: 'sqlite_read',
          transport: 'http',
          url: 'http://${ART_HOST_GATEWAY}:4318/mcp',
          tools: ['query'],
          startupTimeoutSec: 12,
        },
        'sqlite.write': {
          transport: 'stdio',
          command: 'node',
          args: ['tools/sqlite-mcp.js'],
          env: { SQLITE_DB: '/workspace/project/db.sqlite' },
          tools: ['upsert_state'],
        },
      }),
    );

    const registry = loadMcpRegistry();
    expect(registry['sqlite.read']).toEqual(
      expect.objectContaining({
        name: 'sqlite_read',
        transport: 'http',
        url: 'http://${ART_HOST_GATEWAY}:4318/mcp',
      }),
    );
    expect(registry['sqlite.write']).toEqual(
      expect.objectContaining({
        name: 'sqlite_write',
        transport: 'stdio',
        command: 'node',
      }),
    );
  });

  it('resolves ART_HOST_GATEWAY placeholders for stage access', () => {
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        'sqlite.read': {
          name: 'sqlite_read',
          transport: 'http',
          url: 'http://${ART_HOST_GATEWAY}:4318/mcp',
          tools: ['query'],
        },
      }),
    );

    const resolved = resolveStageMcpServers(['sqlite.read'], {
      hostGateway: 'host.docker.internal',
    });
    expect(resolved).toEqual([
      expect.objectContaining({
        ref: 'sqlite.read',
        name: 'sqlite_read',
        transport: 'http',
        url: 'http://host.docker.internal:4318/mcp',
      }),
    ]);
  });

  it('rejects duplicate server names within one stage', () => {
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        first: {
          name: 'sqlite',
          transport: 'http',
          url: 'http://one.example/mcp',
        },
        second: {
          name: 'sqlite',
          transport: 'http',
          url: 'http://two.example/mcp',
        },
      }),
    );

    expect(() => validateStageMcpAccess(['first', 'second'])).toThrow(
      /same server name/,
    );
  });
});
