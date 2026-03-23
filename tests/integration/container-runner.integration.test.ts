/**
 * Integration tests for container-runner.ts
 * Spawns real containers with alpine to verify full lifecycle.
 * Run with: npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  initRuntime,
  getRuntime,
  _resetRuntime,
  stopContainer,
  cleanupOrphans,
  cleanupRunContainers,
  readonlyMountArgs,
  writableMountArgs,
  hostGatewayArgs,
} from '../../src/container-runtime.js';

import { buildContainerArgs } from '../../src/container-runner.js';

import {
  describeRuntime,
  ensureAlpineImage,
  createTempDir,
  cleanupTempDir,
  runContainer,
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

  describe('basic execution', () => {
    it('runs echo and captures stdout', () => {
      const result = runContainer('docker', [
        'run',
        '--rm',
        ALPINE_IMAGE,
        'echo',
        'hello-docker',
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe('hello-docker');
    });

    it('captures exit code 0', () => {
      const result = runContainer('docker', [
        'run',
        '--rm',
        ALPINE_IMAGE,
        'true',
      ]);
      expect(result.code).toBe(0);
    });

    it('captures non-zero exit code', () => {
      const result = runContainer('docker', [
        'run',
        '--rm',
        ALPINE_IMAGE,
        'sh',
        '-c',
        'exit 42',
      ]);
      expect(result.code).toBe(42);
    });
  });

  describe('buildContainerArgs', () => {
    it('includes expected flags', () => {
      const args = buildContainerArgs(
        [{ hostPath: '/tmp', containerPath: '/workspace', readonly: true }],
        'art-integration-test-args',
        [],
        false,
        false,
        ALPINE_IMAGE,
      );

      expect(args).toContain('run');
      expect(args).toContain('-i');
      expect(args).toContain('--rm');
      expect(args).toContain(ALPINE_IMAGE);
      expect(args.join(' ')).toContain('--name');
      expect(args.join(' ')).toContain('art-integration-test-args');
      expect(args.join(' ')).toContain('/tmp:/workspace:ro');
    });

    it('includes --user for non-root non-1000 uid', () => {
      const uid = process.getuid?.();
      const gid = process.getgid?.();
      if (uid != null && uid !== 0 && uid !== 1000) {
        const args = buildContainerArgs(
          [],
          'art-test-user',
          [],
          false,
          false,
          ALPINE_IMAGE,
        );
        expect(args).toContain('--user');
        expect(args).toContain(`${uid}:${gid}`);
      }
    });

    it('includes --user 0:0 for runAsRoot', () => {
      const args = buildContainerArgs(
        [],
        'art-test-root',
        [],
        false,
        true,
        ALPINE_IMAGE,
      );
      expect(args).toContain('--user');
      expect(args).toContain('0:0');
    });

    it('includes host gateway args on Linux', () => {
      const gwArgs = hostGatewayArgs();
      const args = buildContainerArgs(
        [],
        'art-test-gw',
        [],
        false,
        false,
        ALPINE_IMAGE,
      );
      for (const gw of gwArgs) {
        expect(args).toContain(gw);
      }
    });

    it('includes --gpus all when gpu=true', () => {
      const args = buildContainerArgs(
        [],
        'art-test-gpu',
        [],
        true,
        false,
        ALPINE_IMAGE,
      );
      expect(args).toContain('--gpus');
      expect(args).toContain('all');
    });

    it('includes device passthrough', () => {
      const args = buildContainerArgs(
        [],
        'art-test-dev',
        ['/dev/null'],
        false,
        false,
        ALPINE_IMAGE,
      );
      expect(args).toContain('--device');
      expect(args).toContain('/dev/null:/dev/null');
    });

    it('includes USB cgroup rule for /dev/bus/usb', () => {
      const args = buildContainerArgs(
        [],
        'art-test-usb',
        ['/dev/bus/usb'],
        false,
        false,
        ALPINE_IMAGE,
      );
      expect(args.join(' ')).toContain('/dev/bus/usb:/dev/bus/usb');
      expect(args).toContain('--device-cgroup-rule');
    });

    it('includes run-id label', () => {
      const args = buildContainerArgs(
        [],
        'art-test-label',
        [],
        false,
        false,
        ALPINE_IMAGE,
        undefined,
        'test-run-123',
      );
      expect(args).toContain('--label');
      expect(args).toContain('art-run-id=test-run-123');
    });
  });

  describe('mount verification', () => {
    let tmpDir: string;

    beforeAll(() => {
      tmpDir = createTempDir('docker-mount');
      fs.writeFileSync(path.join(tmpDir, 'testfile.txt'), 'read-me');
    });

    afterAll(() => {
      cleanupTempDir(tmpDir);
    });

    it('readonly mount: can read, cannot write', () => {
      const roArgs = readonlyMountArgs(tmpDir, '/mnt/test');
      const result = runContainer('docker', [
        'run',
        '--rm',
        ...roArgs,
        ALPINE_IMAGE,
        'sh',
        '-c',
        'cat /mnt/test/testfile.txt && touch /mnt/test/newfile.txt 2>/dev/null && echo WRITE_OK || echo WRITE_FAIL',
      ]);
      expect(result.stdout).toContain('read-me');
      expect(result.stdout).toContain('WRITE_FAIL');
      expect(result.stdout).not.toContain('WRITE_OK');
    });

    it('writable mount: can read and write, persists on host', () => {
      const rwArgs = writableMountArgs(tmpDir, '/mnt/test');
      const result = runContainer('docker', [
        'run',
        '--rm',
        ...rwArgs,
        ALPINE_IMAGE,
        'sh',
        '-c',
        'echo "written-by-docker" > /mnt/test/docker-output.txt && echo WRITE_OK',
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('WRITE_OK');

      // Verify persistence on host
      const outputFile = path.join(tmpDir, 'docker-output.txt');
      expect(fs.existsSync(outputFile)).toBe(true);
      expect(fs.readFileSync(outputFile, 'utf-8').trim()).toBe(
        'written-by-docker',
      );
    });
  });

  describe('stdin', () => {
    it('accepts JSON via stdin', () => {
      const input = JSON.stringify({ prompt: 'hello' });
      const result = runContainer(
        'docker',
        ['run', '--rm', '-i', ALPINE_IMAGE, 'cat'],
        { stdin: input },
      );
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe(input);
    });
  });

  describe('timeout and stop', () => {
    it('container can be stopped by name', () => {
      const name = `art-integration-stop-${Date.now()}`;
      // Start a sleeping container in background
      execSync(
        `docker run -d --name ${name} ${ALPINE_IMAGE} sleep 300`,
        { stdio: 'pipe', timeout: 10_000 },
      );

      try {
        // Stop it
        const cmd = stopContainer(name);
        execSync(cmd, { stdio: 'pipe', timeout: 15_000 });

        // Verify it's gone
        const ps = execSync(
          `docker ps --filter name=${name} --format '{{.Names}}'`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        );
        expect(ps.trim()).toBe('');
      } finally {
        // Cleanup just in case
        try {
          execSync(`docker rm -f ${name}`, { stdio: 'pipe' });
        } catch {
          /* already removed */
        }
      }
    });
  });

  describe('output marker parsing', () => {
    it('markers are captured in stdout', () => {
      const payload = JSON.stringify({ status: 'success', result: 'test' });
      const markerLine = `---AER_ART_OUTPUT_START---${payload}---AER_ART_OUTPUT_END---`;
      const result = runContainer('docker', [
        'run',
        '--rm',
        ALPINE_IMAGE,
        'sh',
        '-c',
        `printf '%s\\n' '${markerLine}'`,
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('---AER_ART_OUTPUT_START---');
      expect(result.stdout).toContain('---AER_ART_OUTPUT_END---');
      expect(result.stdout).toContain(payload);
    });
  });

  describe('orphan cleanup', () => {
    it('cleanupOrphans stops aer-art-* containers', () => {
      const name = `aer-art-integration-orphan-${Date.now()}`;
      execSync(
        `docker run -d --name ${name} ${ALPINE_IMAGE} sleep 300`,
        { stdio: 'pipe', timeout: 10_000 },
      );

      try {
        cleanupOrphans();

        const ps = execSync(
          `docker ps --filter name=${name} --format '{{.Names}}'`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        );
        expect(ps.trim()).toBe('');
      } finally {
        try {
          execSync(`docker rm -f ${name}`, { stdio: 'pipe' });
        } catch {
          /* already cleaned */
        }
      }
    });

    it('cleanupRunContainers stops labeled containers', () => {
      const runId = `integration-test-${Date.now()}`;
      const name = `art-integration-labeled-${Date.now()}`;
      execSync(
        `docker run -d --name ${name} --label art-run-id=${runId} ${ALPINE_IMAGE} sleep 300`,
        { stdio: 'pipe', timeout: 10_000 },
      );

      try {
        cleanupRunContainers(runId);

        const ps = execSync(
          `docker ps --filter label=art-run-id=${runId} --format '{{.Names}}'`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        );
        expect(ps.trim()).toBe('');
      } finally {
        try {
          execSync(`docker rm -f ${name}`, { stdio: 'pipe' });
        } catch {
          /* already cleaned */
        }
      }
    });
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

  describe('basic execution', () => {
    it('runs echo and captures stdout', () => {
      const result = runContainer('podman', [
        'run',
        '--rm',
        ALPINE_IMAGE,
        'echo',
        'hello-podman',
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe('hello-podman');
    });

    it('captures non-zero exit code', () => {
      const result = runContainer('podman', [
        'run',
        '--rm',
        ALPINE_IMAGE,
        'sh',
        '-c',
        'exit 42',
      ]);
      expect(result.code).toBe(42);
    });
  });

  describe('buildContainerArgs', () => {
    it('includes expected flags', () => {
      const args = buildContainerArgs(
        [{ hostPath: '/tmp', containerPath: '/workspace', readonly: true }],
        'art-integration-podman-args',
        [],
        false,
        false,
        ALPINE_IMAGE,
      );

      expect(args).toContain('run');
      expect(args).toContain('-i');
      expect(args).toContain('--rm');
      expect(args).toContain(ALPINE_IMAGE);
    });

    it('includes --userns=keep-id for rootless podman', () => {
      const rt = getRuntime();
      if (rt.rootless) {
        const args = buildContainerArgs(
          [],
          'art-test-podman-rootless',
          [],
          false,
          false,
          ALPINE_IMAGE,
        );
        expect(args).toContain('--userns=keep-id');
        // Should NOT contain --user when rootless
        expect(args).not.toContain('--user');
      }
    });

    it('includes --user 0:0 for runAsRoot', () => {
      const rt = getRuntime();
      // runAsRoot bypasses rootless check
      const args = buildContainerArgs(
        [],
        'art-test-podman-root',
        [],
        false,
        true,
        ALPINE_IMAGE,
      );
      if (!rt.rootless) {
        expect(args).toContain('--user');
        expect(args).toContain('0:0');
      }
    });

    it('includes podman host gateway', () => {
      const gwArgs = hostGatewayArgs();
      const args = buildContainerArgs(
        [],
        'art-test-podman-gw',
        [],
        false,
        false,
        ALPINE_IMAGE,
      );
      for (const gw of gwArgs) {
        expect(args).toContain(gw);
      }
    });
  });

  describe('mount verification', () => {
    let tmpDir: string;

    beforeAll(() => {
      tmpDir = createTempDir('podman-mount');
      fs.writeFileSync(path.join(tmpDir, 'testfile.txt'), 'read-me-podman');
    });

    afterAll(() => {
      cleanupTempDir(tmpDir);
    });

    it('readonly mount: can read, cannot write', () => {
      const roArgs = readonlyMountArgs(tmpDir, '/mnt/test');
      const result = runContainer('podman', [
        'run',
        '--rm',
        ...roArgs,
        ALPINE_IMAGE,
        'sh',
        '-c',
        'cat /mnt/test/testfile.txt && touch /mnt/test/newfile.txt 2>/dev/null && echo WRITE_OK || echo WRITE_FAIL',
      ]);
      expect(result.stdout).toContain('read-me-podman');
      expect(result.stdout).toContain('WRITE_FAIL');
    });

    it('writable mount: can read and write, persists on host', () => {
      const rwArgs = writableMountArgs(tmpDir, '/mnt/test');
      const result = runContainer('podman', [
        'run',
        '--rm',
        ...rwArgs,
        ALPINE_IMAGE,
        'sh',
        '-c',
        'echo "written-by-podman" > /mnt/test/podman-output.txt && echo WRITE_OK',
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('WRITE_OK');

      const outputFile = path.join(tmpDir, 'podman-output.txt');
      expect(fs.existsSync(outputFile)).toBe(true);
      expect(fs.readFileSync(outputFile, 'utf-8').trim()).toBe(
        'written-by-podman',
      );
    });
  });

  describe('stdin', () => {
    it('accepts JSON via stdin', () => {
      const input = JSON.stringify({ prompt: 'hello-podman' });
      const result = runContainer(
        'podman',
        ['run', '--rm', '-i', ALPINE_IMAGE, 'cat'],
        { stdin: input },
      );
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe(input);
    });
  });

  describe('timeout and stop', () => {
    it('container can be stopped by name', () => {
      const name = `art-integration-podman-stop-${Date.now()}`;
      execSync(
        `podman run -d --name ${name} ${ALPINE_IMAGE} sleep 300`,
        { stdio: 'pipe', timeout: 10_000 },
      );

      try {
        const cmd = stopContainer(name);
        execSync(cmd, { stdio: 'pipe', timeout: 15_000 });

        const ps = execSync(
          `podman ps --filter name=${name} --format '{{.Names}}'`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        );
        expect(ps.trim()).toBe('');
      } finally {
        try {
          execSync(`podman rm -f ${name}`, { stdio: 'pipe' });
        } catch {
          /* already removed */
        }
      }
    });
  });

  describe('orphan cleanup', () => {
    it('cleanupOrphans stops aer-art-* containers', () => {
      const name = `aer-art-integration-podman-orphan-${Date.now()}`;
      execSync(
        `podman run -d --name ${name} ${ALPINE_IMAGE} sleep 300`,
        { stdio: 'pipe', timeout: 10_000 },
      );

      try {
        cleanupOrphans();

        const ps = execSync(
          `podman ps --filter name=${name} --format '{{.Names}}'`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        );
        expect(ps.trim()).toBe('');
      } finally {
        try {
          execSync(`podman rm -f ${name}`, { stdio: 'pipe' });
        } catch {
          /* already cleaned */
        }
      }
    });

    it('cleanupRunContainers stops labeled containers', () => {
      const runId = `integration-podman-${Date.now()}`;
      const name = `art-integration-podman-labeled-${Date.now()}`;
      execSync(
        `podman run -d --name ${name} --label art-run-id=${runId} ${ALPINE_IMAGE} sleep 300`,
        { stdio: 'pipe', timeout: 10_000 },
      );

      try {
        cleanupRunContainers(runId);

        const ps = execSync(
          `podman ps --filter label=art-run-id=${runId} --format '{{.Names}}'`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
        );
        expect(ps.trim()).toBe('');
      } finally {
        try {
          execSync(`podman rm -f ${name}`, { stdio: 'pipe' });
        } catch {
          /* already cleaned */
        }
      }
    });
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
    // Pull alpine for udocker
    try {
      execSync(`udocker pull ${ALPINE_IMAGE}`, {
        stdio: 'pipe',
        timeout: 120_000,
      });
    } catch {
      // may already exist
    }
  });

  afterAll(() => {
    delete process.env.CONTAINER_RUNTIME;
    _resetRuntime();
  });

  describe('buildContainerArgs', () => {
    it('does not include --rm, --name, -i', () => {
      const args = buildContainerArgs(
        [],
        'art-udocker-test',
        [],
        false,
        false,
        ALPINE_IMAGE,
      );

      expect(args).not.toContain('--rm');
      expect(args).not.toContain('-i');
      // udocker uses container name directly instead of image
      expect(args).toContain('art-udocker-test');
      expect(args).not.toContain(ALPINE_IMAGE);
    });

    it('skips device passthrough', () => {
      const args = buildContainerArgs(
        [],
        'art-udocker-dev',
        ['/dev/null'],
        false,
        false,
        ALPINE_IMAGE,
      );
      expect(args).not.toContain('--device');
    });

    it('skips GPU passthrough', () => {
      const args = buildContainerArgs(
        [],
        'art-udocker-gpu',
        [],
        true,
        false,
        ALPINE_IMAGE,
      );
      expect(args).not.toContain('--gpus');
    });

    it('does not include --label (no supportsPsFilter)', () => {
      const args = buildContainerArgs(
        [],
        'art-udocker-label',
        [],
        false,
        false,
        ALPINE_IMAGE,
        undefined,
        'test-run-123',
      );
      expect(args).not.toContain('--label');
    });
  });

  describe('basic execution with prepare/cleanup lifecycle', () => {
    const containerName = `art-integration-udocker-exec-${Date.now()}`;

    afterAll(() => {
      try {
        execSync(`udocker rm ${containerName}`, { stdio: 'pipe' });
      } catch {
        /* already cleaned */
      }
    });

    it('runs echo via udocker after prepare', () => {
      // Create and setup container
      execSync(`udocker create --name=${containerName} ${ALPINE_IMAGE}`, {
        stdio: 'pipe',
        timeout: 30_000,
      });
      execSync(`udocker setup --execmode=F1 ${containerName}`, {
        stdio: 'pipe',
        timeout: 30_000,
      });

      // Run command
      const result = runContainer('udocker', [
        'run',
        containerName,
        'echo',
        'hello-udocker',
      ]);
      expect(result.stdout.trim()).toContain('hello-udocker');
    });
  });
});
