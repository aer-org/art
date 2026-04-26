/**
 * Integration tests for container-runtime.ts
 * No mocks — calls real docker/podman/udocker binaries.
 * Run with: npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import os from 'os';

import {
  initRuntime,
  getRuntime,
  getRuntimeCapabilities,
  ensureContainerRuntimeRunning,
  hostGatewayArgs,
  readonlyMountArgs,
  writableMountArgs,
  stopContainer,
  cleanupOrphans,
  cleanupRunContainers,
  ensureImage,
  prepareContainer,
  cleanupContainer,
  getProxyBindHost,
  _resetRuntime,
} from '../../src/container-runtime.js';

import {
  describeRuntime,
  ensureAlpineImage,
  detectSystemSELinux,
  isDockerActuallyPodman,
  ALPINE_IMAGE,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------

describeRuntime('docker', () => {
  beforeAll(async () => {
    _resetRuntime();
    process.env.CONTAINER_RUNTIME = 'docker';
    await initRuntime();
    ensureAlpineImage('docker');
  });

  afterAll(() => {
    delete process.env.CONTAINER_RUNTIME;
    _resetRuntime();
  });

  it('initRuntime returns docker config', () => {
    const rt = getRuntime();
    expect(rt.kind).toBe('docker');
    expect(rt.bin).toBe('docker');
  });

  it('capabilities are fully enabled', () => {
    const caps = getRuntimeCapabilities();
    expect(caps.canBuild).toBe(true);
    expect(caps.supportsAutoRemove).toBe(true);
    expect(caps.supportsNaming).toBe(true);
    expect(caps.supportsAddHost).toBe(true);
    expect(caps.supportsDevices).toBe(true);
    expect(caps.supportsDeviceCgroupRule).toBe(true);
    expect(caps.supportsPsFilter).toBe(true);
    expect(caps.supportsUser).toBe(true);
    expect(caps.supportsStdin).toBe(true);
  });

  it('ensureContainerRuntimeRunning succeeds', () => {
    expect(() => ensureContainerRuntimeRunning()).not.toThrow();
  });

  it('detects bridge interface on Linux', () => {
    const rt = getRuntime();
    if (os.platform() === 'linux') {
      const ifaces = os.networkInterfaces();
      if (ifaces['docker0']) {
        expect(rt.bridgeInterface).toBe('docker0');
      } else {
        expect(rt.bridgeInterface).toBeNull();
      }
    }
  });

  it('proxy bind host is valid', () => {
    const host = getProxyBindHost();
    expect(host).toBeTruthy();
    // On Linux with docker0: should be the bridge IP
    // On macOS/WSL: should be 127.0.0.1
    if (os.platform() === 'linux') {
      const ifaces = os.networkInterfaces();
      const docker0 = ifaces['docker0'];
      if (docker0) {
        const ipv4 = docker0.find((a) => a.family === 'IPv4');
        expect(host).toBe(ipv4?.address);
      }
    }
  });

  it('hostGatewayArgs on Linux includes --add-host', () => {
    const args = hostGatewayArgs();
    if (os.platform() === 'linux') {
      expect(args).toContain('--add-host=host.docker.internal:host-gateway');
    }
  });

  it('readonlyMountArgs without SELinux', () => {
    const rt = getRuntime();
    const args = readonlyMountArgs('/tmp/test', '/workspace');
    if (!rt.selinux) {
      expect(args).toEqual(['-v', '/tmp/test:/workspace:ro']);
    } else {
      expect(args).toEqual(['-v', '/tmp/test:/workspace:ro,z']);
    }
  });

  it('writableMountArgs without SELinux', () => {
    const rt = getRuntime();
    const args = writableMountArgs('/tmp/test', '/workspace');
    if (!rt.selinux) {
      expect(args).toEqual(['-v', '/tmp/test:/workspace']);
    } else {
      expect(args).toEqual(['-v', '/tmp/test:/workspace:z']);
    }
  });

  it('stopContainer returns docker stop command', () => {
    const cmd = stopContainer('test-container');
    expect(cmd).toBe('docker stop test-container');
  });

  it('cleanupOrphans runs without error', () => {
    expect(() => cleanupOrphans()).not.toThrow();
  });

  it('cleanupRunContainers runs without error', () => {
    expect(() => cleanupRunContainers('nonexistent-run-id')).not.toThrow();
  });

  it('ensureImage finds alpine', () => {
    const name = ensureImage(ALPINE_IMAGE);
    expect(name).toBe(ALPINE_IMAGE);
  });

  it('ensureImage throws for nonexistent image', () => {
    expect(() => ensureImage('nonexistent-image-abc123:latest')).toThrow();
  });

  it('SELinux detection matches system state', () => {
    const rt = getRuntime();
    // Docker kind doesn't apply SELinux labels (only podman does in our code)
    expect(rt.selinux).toBe(false);
  });

  it('rootless is false for docker kind', () => {
    const rt = getRuntime();
    // Our code only detects rootless for podman — docker always reports false
    expect(rt.rootless).toBe(false);
  });

  it('hostGateway is host.docker.internal', () => {
    const rt = getRuntime();
    expect(rt.hostGateway).toBe('host.docker.internal');
  });
});

// ---------------------------------------------------------------------------
// Podman
// ---------------------------------------------------------------------------

describeRuntime('podman', () => {
  beforeAll(async () => {
    _resetRuntime();
    process.env.CONTAINER_RUNTIME = 'podman';
    await initRuntime();
    ensureAlpineImage('podman');
  });

  afterAll(() => {
    delete process.env.CONTAINER_RUNTIME;
    _resetRuntime();
  });

  it('initRuntime returns podman config', () => {
    const rt = getRuntime();
    expect(rt.kind).toBe('podman');
    expect(rt.bin).toBe('podman');
  });

  it('capabilities are fully enabled', () => {
    const caps = getRuntimeCapabilities();
    expect(caps.canBuild).toBe(true);
    expect(caps.supportsAutoRemove).toBe(true);
    expect(caps.supportsNaming).toBe(true);
    expect(caps.supportsAddHost).toBe(true);
    expect(caps.supportsDevices).toBe(true);
    expect(caps.supportsDeviceCgroupRule).toBe(true);
    expect(caps.supportsPsFilter).toBe(true);
    expect(caps.supportsUser).toBe(true);
    expect(caps.supportsStdin).toBe(true);
  });

  it('ensureContainerRuntimeRunning succeeds', () => {
    expect(() => ensureContainerRuntimeRunning()).not.toThrow();
  });

  it('rootless detection matches podman info', () => {
    const rt = getRuntime();
    try {
      const output = execSync('podman info --format json', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10_000,
      });
      const info = JSON.parse(output);
      const actualRootless = info?.host?.security?.rootless === true;
      expect(rt.rootless).toBe(actualRootless);
    } catch {
      // If podman info fails, just check UID-based fallback
      const uid = process.getuid?.();
      expect(rt.rootless).toBe(uid != null && uid !== 0);
    }
  });

  it('detects bridge interface', () => {
    const rt = getRuntime();
    const ifaces = os.networkInterfaces();
    if (ifaces['podman0']) {
      expect(rt.bridgeInterface).toBe('podman0');
    } else if (ifaces['cni-podman0']) {
      expect(rt.bridgeInterface).toBe('cni-podman0');
    } else {
      expect(rt.bridgeInterface).toBeNull();
    }
  });

  it('hostGateway is host.containers.internal', () => {
    const rt = getRuntime();
    expect(rt.hostGateway).toBe('host.containers.internal');
  });

  it('hostGatewayArgs on Linux includes podman gateway', () => {
    const args = hostGatewayArgs();
    if (os.platform() === 'linux') {
      expect(args).toContain(
        '--add-host=host.containers.internal:host-gateway',
      );
    }
  });

  it('proxy bind host is valid', () => {
    const host = getProxyBindHost();
    expect(host).toBeTruthy();
  });

  it('SELinux detection matches system state', () => {
    const rt = getRuntime();
    const systemSELinux = detectSystemSELinux();
    expect(rt.selinux).toBe(systemSELinux);
  });

  it('readonlyMountArgs respects SELinux state', () => {
    const rt = getRuntime();
    const args = readonlyMountArgs('/tmp/test', '/workspace');
    if (rt.selinux) {
      expect(args).toEqual(['-v', '/tmp/test:/workspace:ro,z']);
    } else {
      expect(args).toEqual(['-v', '/tmp/test:/workspace:ro']);
    }
  });

  it('writableMountArgs respects SELinux state', () => {
    const rt = getRuntime();
    const args = writableMountArgs('/tmp/test', '/workspace');
    if (rt.selinux) {
      expect(args).toEqual(['-v', '/tmp/test:/workspace:z']);
    } else {
      expect(args).toEqual(['-v', '/tmp/test:/workspace']);
    }
  });

  it('stopContainer returns podman stop command', () => {
    const cmd = stopContainer('test-container');
    expect(cmd).toBe('podman stop test-container');
  });

  it('cleanupOrphans runs without error', () => {
    expect(() => cleanupOrphans()).not.toThrow();
  });

  it('cleanupRunContainers runs without error', () => {
    expect(() => cleanupRunContainers('nonexistent-run-id')).not.toThrow();
  });

  it('ensureImage finds alpine', () => {
    const name = ensureImage(ALPINE_IMAGE);
    expect(name).toBe(ALPINE_IMAGE);
  });

  it('ensureImage throws for nonexistent image', () => {
    expect(() => ensureImage('nonexistent-image-abc123:latest')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// udocker
// ---------------------------------------------------------------------------

describeRuntime('udocker', () => {
  beforeAll(async () => {
    _resetRuntime();
    process.env.CONTAINER_RUNTIME = 'udocker';
    await initRuntime();
  });

  afterAll(() => {
    delete process.env.CONTAINER_RUNTIME;
    _resetRuntime();
  });

  it('initRuntime returns udocker config', () => {
    const rt = getRuntime();
    expect(rt.kind).toBe('udocker');
    expect(rt.bin).toBe('udocker');
  });

  it('capabilities are restricted', () => {
    const caps = getRuntimeCapabilities();
    expect(caps.canBuild).toBe(false);
    expect(caps.supportsAutoRemove).toBe(false);
    expect(caps.supportsNaming).toBe(false);
    expect(caps.supportsAddHost).toBe(false);
    expect(caps.supportsDevices).toBe(false);
    expect(caps.supportsDeviceCgroupRule).toBe(false);
    expect(caps.supportsPsFilter).toBe(false);
    expect(caps.supportsUser).toBe(true);
    expect(caps.supportsStdin).toBe(false);
  });

  it('ensureContainerRuntimeRunning succeeds', () => {
    expect(() => ensureContainerRuntimeRunning()).not.toThrow();
  });

  it('hostGateway is localhost', () => {
    const rt = getRuntime();
    expect(rt.hostGateway).toBe('localhost');
  });

  it('bridge interface is null', () => {
    const rt = getRuntime();
    expect(rt.bridgeInterface).toBeNull();
  });

  it('hostGatewayArgs returns empty (no --add-host support)', () => {
    const args = hostGatewayArgs();
    expect(args).toEqual([]);
  });

  it('proxy bind host is 127.0.0.1', () => {
    const host = getProxyBindHost();
    expect(host).toBe('127.0.0.1');
  });

  it('cleanupOrphans skips (no supportsPsFilter)', () => {
    // Should not throw — just skips internally
    expect(() => cleanupOrphans()).not.toThrow();
  });

  it('cleanupRunContainers skips (no supportsPsFilter)', () => {
    expect(() => cleanupRunContainers('any-id')).not.toThrow();
  });

  it('SELinux is false for udocker', () => {
    const rt = getRuntime();
    // udocker doesn't use SELinux labels regardless of system state
    expect(rt.selinux).toBe(false);
  });

  it('rootless is false for udocker kind', () => {
    const rt = getRuntime();
    // Our code only detects rootless for podman — udocker always reports false
    expect(rt.rootless).toBe(false);
  });

  describe('container lifecycle', () => {
    const testContainerName = `art-integration-udocker-${Date.now()}`;
    let prepared = false;

    it('prepareContainer creates F1 container', () => {
      // First ensure we have an image — pull alpine via udocker
      try {
        execSync(`udocker pull ${ALPINE_IMAGE}`, {
          stdio: 'pipe',
          timeout: 120_000,
        });
      } catch {
        // may already exist
      }

      expect(() => {
        prepareContainer(ALPINE_IMAGE, testContainerName);
        prepared = true;
      }).not.toThrow();
    });

    it('cleanupContainer removes the container', () => {
      if (!prepared) return;
      expect(() => cleanupContainer(testContainerName)).not.toThrow();
    });
  });
});
