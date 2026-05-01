import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---AER_ART_OUTPUT_START---';
const OUTPUT_END_MARKER = '---AER_ART_OUTPUT_END---';

// Mock config
vi.mock('../../src/config.js', () => ({
  CONTAINER_IMAGE: 'aer-art-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/aer-art-test-data',
  GROUPS_DIR: '/tmp/aer-art-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
  getProjectRoot: () => '/tmp/aer-art-test-root',
  getCredentialProxyPort: () => 3001,
}));

// Mock logger
vi.mock('../../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('../../src/mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock credential-proxy
vi.mock('../../src/credential-proxy.js', () => ({
  detectAuthMode: () => 'api-key',
}));

vi.mock('../../src/codex-auth.js', () => ({
  ensureCodexSessionAuth: vi.fn(),
}));

// Mock group-folder
vi.mock('../../src/group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) =>
    `/tmp/aer-art-test-groups/${folder}`,
  resolveGroupIpcPath: (folder: string) =>
    `/tmp/aer-art-test-data/ipc/${folder}`,
}));

// Mock container-runtime with a docker config
vi.mock('../../src/container-runtime.js', () => ({
  getRuntime: () => ({
    kind: 'docker',
    bin: 'docker',
    capabilities: {
      canBuild: true,
      supportsAutoRemove: true,
      supportsNaming: true,
      supportsAddHost: true,
      supportsDevices: true,
      supportsDeviceCgroupRule: true,
      supportsPsFilter: true,
      supportsUser: true,
      supportsStdin: true,
    },
    hostGateway: 'host.docker.internal',
    bridgeInterface: 'docker0',
    selinux: false,
    rootless: false,
  }),
  hostGatewayArgs: () => [],
  readonlyMountArgs: (host: string, container: string) => [
    '-v',
    `${host}:${container}:ro`,
  ],
  writableMountArgs: (host: string, container: string) => [
    '-v',
    `${host}:${container}`,
  ],
  stopContainer: (name: string) => `docker stop ${name}`,
  prepareContainer: vi.fn(),
  cleanupContainer: vi.fn(),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import {
  runContainerAgent,
  ContainerOutput,
} from '../../src/container-runner.js';
import type { RegisteredGroup } from '../../src/types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('container-runner MCP config generation', () => {
  beforeEach(() => {
    fakeProc = createFakeProcess();
    vi.clearAllMocks();
  });

  it('writes stage-local Codex config.toml with external MCP servers', async () => {
    const fsModule = await import('fs');
    const mockedFs = vi.mocked(fsModule.default);
    const codexGroup: RegisteredGroup = {
      ...testGroup,
      containerConfig: {
        provider: 'codex',
        externalMcpServers: [
          {
            ref: 'sqlite.read',
            name: 'sqlite_read',
            transport: 'http',
            url: 'http://host.docker.internal:4318/mcp',
            tools: ['query'],
            startupTimeoutSec: 12,
          },
          {
            ref: 'sqlite.write',
            name: 'sqlite_write',
            transport: 'stdio',
            command: 'node',
            args: ['tools/sqlite-mcp.js'],
            env: { SQLITE_DB: '/workspace/project/db.sqlite' },
            tools: ['upsert_state'],
            startupTimeoutSec: 8,
          },
        ],
      },
    };

    const resultPromise = runContainerAgent(
      codexGroup,
      {
        ...testInput,
        provider: 'codex',
        externalMcpServers: codexGroup.containerConfig!.externalMcpServers,
      },
      () => {},
    );

    const configCall = mockedFs.writeFileSync.mock.calls.find(
      ([filePath]) =>
        filePath ===
        '/tmp/aer-art-test-data/sessions/test-group/.codex/config.toml',
    );
    expect(configCall).toBeDefined();
    const configText = String(configCall![1]);
    expect(configText).toContain('[mcp_servers.aer_art]');
    expect(configText).toContain('[mcp_servers.sqlite_read]');
    expect(configText).toContain(
      'url = "http://host.docker.internal:4318/mcp"',
    );
    expect(configText).toContain('startup_timeout_sec = 12');
    expect(configText).toContain('[mcp_servers.sqlite_write]');
    expect(configText).toContain('command = "node"');
    expect(configText).toContain('args = ["tools/sqlite-mcp.js"]');
    expect(configText).toContain('[mcp_servers.sqlite_write.env]');
    expect(configText).toContain('SQLITE_DB = "/workspace/project/db.sqlite"');
    expect(configText).toContain('startup_timeout_sec = 8');

    fakeProc.emit('close', 0);
    await resultPromise;
  });
});
