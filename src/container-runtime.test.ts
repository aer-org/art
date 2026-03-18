import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// vi.hoisted ensures these are available when hoisted vi.mock factories run
const {
  mockExecSync,
  mockReadFileSync,
  mockExistsSync,
  mockWriteFileSync,
  mockMkdirSync,
} = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockExistsSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
}));

// Mock child_process
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// Mock fs for initRuntime tests
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
      existsSync: (...args: unknown[]) => mockExistsSync(...args),
      writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
      mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    },
  };
});

import {
  readonlyMountArgs,
  writableMountArgs,
  stopContainer,
  hostGatewayArgs,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
  getRuntime,
  getRuntimeBin,
  getHostGateway,
  getProxyBindHost,
  getRuntimeCapabilities,
  initRuntime,
  _resetRuntime,
  _setRuntime,
  type RuntimeConfig,
  type RuntimeKind,
} from './container-runtime.js';
import { logger } from './logger.js';

function makeRuntime(
  kind: RuntimeKind,
  overrides?: Partial<RuntimeConfig>,
): RuntimeConfig {
  const defaults: Record<RuntimeKind, RuntimeConfig> = {
    docker: {
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
    },
    podman: {
      kind: 'podman',
      bin: 'podman',
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
      hostGateway: 'host.containers.internal',
      bridgeInterface: 'podman0',
      selinux: false,
      rootless: true,
    },
    udocker: {
      kind: 'udocker',
      bin: 'udocker',
      capabilities: {
        canBuild: false,
        supportsAutoRemove: false,
        supportsNaming: false,
        supportsAddHost: false,
        supportsDevices: false,
        supportsDeviceCgroupRule: false,
        supportsPsFilter: false,
        supportsUser: true,
        supportsStdin: false,
      },
      hostGateway: 'localhost',
      bridgeInterface: null,
      selinux: false,
      rootless: false,
    },
  };
  return { ...defaults[kind], ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetRuntime();
});

afterEach(() => {
  _resetRuntime();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });

  it('adds :z suffix for SELinux-enabled runtime', () => {
    _setRuntime(makeRuntime('podman', { selinux: true }));
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro,z']);
  });
});

describe('writableMountArgs', () => {
  it('returns -v flag without suffix by default', () => {
    const args = writableMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path']);
  });

  it('adds :z suffix for SELinux-enabled runtime', () => {
    _setRuntime(makeRuntime('podman', { selinux: true }));
    const args = writableMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:z']);
  });
});

describe('stopContainer', () => {
  it('uses docker by default', () => {
    expect(stopContainer('aer-art-test-123')).toBe(
      'docker stop aer-art-test-123',
    );
  });

  it('uses the runtime bin when set', () => {
    _setRuntime(makeRuntime('podman'));
    expect(stopContainer('aer-art-test-123')).toBe(
      'podman stop aer-art-test-123',
    );
  });
});

// --- hostGatewayArgs ---

describe('hostGatewayArgs', () => {
  it('returns empty for udocker (no --add-host support)', () => {
    _setRuntime(makeRuntime('udocker'));
    expect(hostGatewayArgs()).toEqual([]);
  });

  it('returns docker-style --add-host on Linux', () => {
    _setRuntime(makeRuntime('docker'));
    // hostGatewayArgs checks os.platform() internally
    const args = hostGatewayArgs();
    // On Linux this should include --add-host, on other platforms it's empty
    if (process.platform === 'linux') {
      expect(args).toEqual(['--add-host=host.docker.internal:host-gateway']);
    } else {
      expect(args).toEqual([]);
    }
  });

  it('returns podman-style --add-host on Linux', () => {
    _setRuntime(makeRuntime('podman'));
    const args = hostGatewayArgs();
    if (process.platform === 'linux') {
      expect(args).toEqual([
        '--add-host=host.containers.internal:host-gateway',
      ]);
    } else {
      expect(args).toEqual([]);
    }
  });
});

// --- getRuntime / getters ---

describe('getRuntime', () => {
  it('throws if not initialized', () => {
    expect(() => getRuntime()).toThrow('not initialized');
  });

  it('returns cached runtime after _setRuntime', () => {
    const rt = makeRuntime('docker');
    _setRuntime(rt);
    expect(getRuntime()).toBe(rt);
  });
});

describe('getRuntimeBin', () => {
  it('returns the binary name', () => {
    _setRuntime(makeRuntime('podman'));
    expect(getRuntimeBin()).toBe('podman');
  });
});

describe('getHostGateway', () => {
  it('returns docker gateway', () => {
    _setRuntime(makeRuntime('docker'));
    expect(getHostGateway()).toBe('host.docker.internal');
  });

  it('returns podman gateway', () => {
    _setRuntime(makeRuntime('podman'));
    expect(getHostGateway()).toBe('host.containers.internal');
  });

  it('returns localhost for udocker', () => {
    _setRuntime(makeRuntime('udocker'));
    expect(getHostGateway()).toBe('localhost');
  });
});

describe('getProxyBindHost', () => {
  it('returns 127.0.0.1 for udocker', () => {
    _setRuntime(makeRuntime('udocker'));
    expect(getProxyBindHost()).toBe('127.0.0.1');
  });
});

describe('getRuntimeCapabilities', () => {
  it('docker has all capabilities', () => {
    _setRuntime(makeRuntime('docker'));
    const caps = getRuntimeCapabilities();
    expect(caps.canBuild).toBe(true);
    expect(caps.supportsAutoRemove).toBe(true);
    expect(caps.supportsNaming).toBe(true);
    expect(caps.supportsAddHost).toBe(true);
    expect(caps.supportsDevices).toBe(true);
    expect(caps.supportsPsFilter).toBe(true);
  });

  it('udocker has limited capabilities', () => {
    _setRuntime(makeRuntime('udocker'));
    const caps = getRuntimeCapabilities();
    expect(caps.canBuild).toBe(false);
    expect(caps.supportsAutoRemove).toBe(false);
    expect(caps.supportsNaming).toBe(false);
    expect(caps.supportsAddHost).toBe(false);
    expect(caps.supportsDevices).toBe(false);
    expect(caps.supportsPsFilter).toBe(false);
    expect(caps.supportsUser).toBe(true);
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('succeeds for docker when docker info works', () => {
    _setRuntime(makeRuntime('docker'));
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledWith('docker info', {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime already running',
    );
  });

  it('throws when docker info fails', () => {
    _setRuntime(makeRuntime('docker'));
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow(
      'Container runtime is required but failed to start',
    );
  });

  it('uses udocker version for udocker runtime', () => {
    _setRuntime(makeRuntime('udocker'));
    mockExecSync.mockReturnValueOnce('udocker 1.3.1');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledWith('udocker version', {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(logger.debug).toHaveBeenCalledWith('udocker is available');
  });

  it('throws when udocker version fails', () => {
    _setRuntime(makeRuntime('udocker'));
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('udocker not found');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow('udocker');
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('stops orphaned containers with docker/podman', () => {
    _setRuntime(makeRuntime('docker'));
    mockExecSync.mockReturnValueOnce(
      'aer-art-group1-111\naer-art-group2-222\n',
    );
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      'docker stop aer-art-group1-111',
      { stdio: 'pipe' },
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      'docker stop aer-art-group2-222',
      { stdio: 'pipe' },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['aer-art-group1-111', 'aer-art-group2-222'] },
      'Stopped orphaned containers',
    );
  });

  it('does nothing when no orphans exist', () => {
    _setRuntime(makeRuntime('docker'));
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('skips orphan cleanup for udocker (no ps --filter support)', () => {
    _setRuntime(makeRuntime('udocker'));

    cleanupOrphans();

    expect(mockExecSync).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      { runtime: 'udocker' },
      'Runtime does not support ps --filter, skipping orphan cleanup',
    );
  });

  it('warns and continues when ps fails', () => {
    _setRuntime(makeRuntime('docker'));
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    _setRuntime(makeRuntime('docker'));
    mockExecSync.mockReturnValueOnce('aer-art-a-1\naer-art-b-2\n');
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['aer-art-a-1', 'aer-art-b-2'] },
      'Stopped orphaned containers',
    );
  });
});

// --- initRuntime ---

describe('initRuntime', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CONTAINER_RUNTIME;
    _resetRuntime();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses CONTAINER_RUNTIME env var override', async () => {
    process.env.CONTAINER_RUNTIME = 'podman';
    // commandExists('podman') → which podman succeeds
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which podman') return '/usr/bin/podman\n';
      // isPodmanRootless → podman info
      if (cmd.includes('podman info'))
        return JSON.stringify({ host: { security: { rootless: false } } });
      return '';
    });
    // fs mocks: SELinux check
    mockExistsSync.mockReturnValue(false);

    const rt = await initRuntime();

    expect(rt.kind).toBe('podman');
    expect(rt.bin).toBe('podman');
    expect(rt.capabilities.supportsStdin).toBe(true);
  });

  it('loads saved runtime from runtime.json', async () => {
    const saved = {
      runtime: 'docker',
      confirmedAt: '2026-01-01T00:00:00.000Z',
    };
    // fs.readFileSync for runtime.json
    mockReadFileSync.mockReturnValueOnce(JSON.stringify(saved));
    // commandExists('docker') → which docker
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which docker') return '/usr/bin/docker\n';
      if (cmd === 'docker info') return 'Docker Engine';
      return '';
    });
    mockExistsSync.mockReturnValue(false);

    const rt = await initRuntime();

    expect(rt.kind).toBe('docker');
    expect(rt.bin).toBe('docker');
  });

  it('re-detects when saved runtime binary is gone', async () => {
    // fs.readFileSync returns saved config pointing to udocker
    mockReadFileSync.mockReturnValueOnce(
      JSON.stringify({
        runtime: 'udocker',
        confirmedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    // commandExists checks: udocker gone, docker available
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which udocker') throw new Error('not found');
      if (cmd === 'which docker') return '/usr/bin/docker\n';
      if (cmd === 'docker info') return 'Docker Engine';
      return '';
    });
    mockExistsSync.mockReturnValue(false);
    mockMkdirSync.mockReturnValue(undefined);
    mockWriteFileSync.mockReturnValue(undefined);

    const rt = await initRuntime();

    // Should fall through to auto-detect and find docker
    expect(rt.kind).toBe('docker');
    expect(rt.bin).toBe('docker');
  });

  it('auto-detects runtimes in priority order (docker > podman > udocker)', async () => {
    // No saved config
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    // Only udocker exists
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which docker') throw new Error('not found');
      if (cmd === 'which podman') throw new Error('not found');
      if (cmd === 'which udocker') return '/usr/local/bin/udocker\n';
      if (cmd === 'udocker version') return 'udocker 1.3.1';
      return '';
    });
    mockExistsSync.mockReturnValue(false);
    mockMkdirSync.mockReturnValue(undefined);
    mockWriteFileSync.mockReturnValue(undefined);

    const rt = await initRuntime();

    expect(rt.kind).toBe('udocker');
    expect(rt.bin).toBe('udocker');
    expect(rt.capabilities.supportsStdin).toBe(false);
    expect(rt.capabilities.supportsNaming).toBe(false);
  });
});
