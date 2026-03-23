/**
 * Integration tests for container-runner.ts
 * Spawns real containers with alpine to verify full lifecycle.
 * Run with: npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawn as cpSpawn } from 'child_process';
import http from 'http';
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
  getProxyBindHost,
} from '../../src/container-runtime.js';

import { buildContainerArgs } from '../../src/container-runner.js';

import {
  describeRuntime,
  ensureAlpineImage,
  createTempDir,
  cleanupTempDir,
  runContainer,
  FULL_RUNTIMES,
  ALPINE_IMAGE,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Docker & Podman — shared tests (parameterized)
// ---------------------------------------------------------------------------

for (const { kind, bin } of FULL_RUNTIMES) {
  describeRuntime(kind, () => {
    beforeAll(async () => {
      _resetRuntime();
      process.env.CONTAINER_RUNTIME = kind;
      await initRuntime();
      ensureAlpineImage(bin);
    });

    afterAll(() => {
      delete process.env.CONTAINER_RUNTIME;
      _resetRuntime();
    });

    describe('basic execution', () => {
      it('runs echo and captures stdout', () => {
        const result = runContainer(bin, [
          'run',
          '--rm',
          ALPINE_IMAGE,
          'echo',
          `hello-${kind}`,
        ]);
        expect(result.code).toBe(0);
        expect(result.stdout.trim()).toBe(`hello-${kind}`);
      });

      it('captures exit code 0', () => {
        const result = runContainer(bin, [
          'run',
          '--rm',
          ALPINE_IMAGE,
          'true',
        ]);
        expect(result.code).toBe(0);
      });

      it('captures non-zero exit code', () => {
        const result = runContainer(bin, [
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
          `art-integration-${kind}-args`,
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
        expect(args.join(' ')).toContain(`art-integration-${kind}-args`);
        expect(args.join(' ')).toContain('/tmp:/workspace:ro');
      });

      it('includes --user 0:0 for runAsRoot', () => {
        const rt = getRuntime();
        if (!rt.rootless) {
          const args = buildContainerArgs(
            [],
            `art-test-${kind}-root`,
            [],
            false,
            true,
            ALPINE_IMAGE,
          );
          expect(args).toContain('--user');
          expect(args).toContain('0:0');
        }
      });

      it('includes host gateway args on Linux', () => {
        const gwArgs = hostGatewayArgs();
        const args = buildContainerArgs(
          [],
          `art-test-${kind}-gw`,
          [],
          false,
          false,
          ALPINE_IMAGE,
        );
        for (const gw of gwArgs) {
          expect(args).toContain(gw);
        }
      });

      it('includes run-id label', () => {
        const args = buildContainerArgs(
          [],
          `art-test-${kind}-label`,
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
        tmpDir = createTempDir(`${kind}-mount`);
        fs.writeFileSync(path.join(tmpDir, 'testfile.txt'), `read-me-${kind}`);
      });

      afterAll(() => {
        cleanupTempDir(tmpDir);
      });

      it('readonly mount: can read, cannot write', () => {
        const roArgs = readonlyMountArgs(tmpDir, '/mnt/test');
        const result = runContainer(bin, [
          'run',
          '--rm',
          ...roArgs,
          ALPINE_IMAGE,
          'sh',
          '-c',
          'cat /mnt/test/testfile.txt && touch /mnt/test/newfile.txt 2>/dev/null && echo WRITE_OK || echo WRITE_FAIL',
        ]);
        expect(result.stdout).toContain(`read-me-${kind}`);
        expect(result.stdout).toContain('WRITE_FAIL');
        expect(result.stdout).not.toContain('WRITE_OK');
      });

      it('writable mount: can read and write, persists on host', () => {
        const rwArgs = writableMountArgs(tmpDir, '/mnt/test');
        const result = runContainer(bin, [
          'run',
          '--rm',
          ...rwArgs,
          ALPINE_IMAGE,
          'sh',
          '-c',
          `echo "written-by-${kind}" > /mnt/test/${kind}-output.txt && echo WRITE_OK`,
        ]);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('WRITE_OK');

        const outputFile = path.join(tmpDir, `${kind}-output.txt`);
        expect(fs.existsSync(outputFile)).toBe(true);
        expect(fs.readFileSync(outputFile, 'utf-8').trim()).toBe(
          `written-by-${kind}`,
        );
      });

      it('mounted files are accessible with correct uid mapping', () => {
        const rwDir = createTempDir(`${kind}-uid`);
        try {
          // Write a file as host user
          const testFile = path.join(rwDir, 'host-file.txt');
          fs.writeFileSync(testFile, 'host-owned');

          const rwArgs = writableMountArgs(rwDir, '/mnt/uid-test');
          const rt = getRuntime();
          const uid = process.getuid?.() ?? 0;
          const gid = process.getgid?.() ?? 0;

          // Build user args matching actual container-runner logic
          const userArgs: string[] = [];
          if (rt.kind === 'podman' && rt.rootless) {
            userArgs.push('--userns=keep-id');
          } else if (uid !== 0 && uid !== 1000) {
            userArgs.push('--user', `${uid}:${gid}`);
          }

          const result = runContainer(bin, [
            'run',
            '--rm',
            ...rwArgs,
            ...userArgs,
            ALPINE_IMAGE,
            'sh',
            '-c',
            'cat /mnt/uid-test/host-file.txt && echo "container-wrote" > /mnt/uid-test/container-file.txt && id -u',
          ]);
          expect(result.stdout).toContain('host-owned');

          // Verify the container-written file exists on host
          const containerFile = path.join(rwDir, 'container-file.txt');
          expect(fs.existsSync(containerFile)).toBe(true);

          // Verify ownership matches the UID the container ran as
          const stat = fs.statSync(containerFile);
          if (userArgs.includes('--userns=keep-id') || userArgs.includes(`${uid}:${gid}`)) {
            // Container ran as host uid → file should be owned by host uid
            expect(stat.uid).toBe(uid);
          } else {
            // Container ran as default user (root=0 or node=1000)
            // Just verify file was created successfully
            expect(fs.readFileSync(containerFile, 'utf-8').trim()).toBe('container-wrote');
          }
        } finally {
          cleanupTempDir(rwDir);
        }
      });
    });

    describe('stdin', () => {
      it('accepts JSON via stdin', () => {
        const input = JSON.stringify({ prompt: `hello-${kind}` });
        const result = runContainer(
          bin,
          ['run', '--rm', '-i', ALPINE_IMAGE, 'cat'],
          { stdin: input },
        );
        expect(result.code).toBe(0);
        expect(result.stdout.trim()).toBe(input);
      });
    });

    describe('host gateway connectivity', () => {
      it('container can reach host via gateway', async () => {
        const rt = getRuntime();
        const bindHost = getProxyBindHost();
        const gwArgs = hostGatewayArgs();

        // Start a temporary HTTP server on the proxy bind address
        const server = http.createServer((_req, res) => {
          res.writeHead(200, { Connection: 'close' });
          res.end('GATEWAY_OK');
        });
        server.unref();

        await new Promise<void>((resolve) => {
          server.listen(0, bindHost, () => resolve());
        });
        const port = (server.address() as { port: number }).port;

        try {
          // Must use async spawn — spawnSync blocks the event loop,
          // preventing the HTTP server from handling requests.
          const stdout = await new Promise<string>((resolve, reject) => {
            const proc = cpSpawn(bin, [
              'run',
              '--rm',
              ...gwArgs,
              ALPINE_IMAGE,
              'wget',
              '-q',
              '-O-',
              '-T',
              '5',
              `http://${rt.hostGateway}:${port}/`,
            ]);
            let out = '';
            proc.stdout.on('data', (d: Buffer) => {
              out += d.toString();
            });
            proc.on('close', () => resolve(out));
            proc.on('error', reject);
            setTimeout(() => {
              proc.kill();
              reject(new Error('gateway test timed out'));
            }, 15_000);
          });
          expect(stdout).toContain('GATEWAY_OK');
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      });
    });

    describe('timeout and stop', () => {
      it('container can be stopped by name', () => {
        const name = `art-integration-${kind}-stop-${Date.now()}`;
        execSync(
          `${bin} run -d --name ${name} ${ALPINE_IMAGE} sleep 300`,
          { stdio: 'pipe', timeout: 10_000 },
        );

        try {
          const cmd = stopContainer(name);
          execSync(cmd, { stdio: 'pipe', timeout: 15_000 });

          const ps = execSync(
            `${bin} ps --filter name=${name} --format '{{.Names}}'`,
            { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
          );
          expect(ps.trim()).toBe('');
        } finally {
          try {
            execSync(`${bin} rm -f ${name}`, { stdio: 'pipe' });
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
        const result = runContainer(bin, [
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
        const name = `aer-art-integration-${kind}-orphan-${Date.now()}`;
        execSync(
          `${bin} run -d --name ${name} ${ALPINE_IMAGE} sleep 300`,
          { stdio: 'pipe', timeout: 10_000 },
        );

        try {
          cleanupOrphans();

          const ps = execSync(
            `${bin} ps --filter name=${name} --format '{{.Names}}'`,
            { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
          );
          expect(ps.trim()).toBe('');
        } finally {
          try {
            execSync(`${bin} rm -f ${name}`, { stdio: 'pipe' });
          } catch {
            /* already cleaned */
          }
        }
      });

      it('cleanupRunContainers stops labeled containers', () => {
        const runId = `integration-${kind}-${Date.now()}`;
        const name = `art-integration-${kind}-labeled-${Date.now()}`;
        execSync(
          `${bin} run -d --name ${name} --label art-run-id=${runId} ${ALPINE_IMAGE} sleep 300`,
          { stdio: 'pipe', timeout: 10_000 },
        );

        try {
          cleanupRunContainers(runId);

          const ps = execSync(
            `${bin} ps --filter label=art-run-id=${runId} --format '{{.Names}}'`,
            { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
          );
          expect(ps.trim()).toBe('');
        } finally {
          try {
            execSync(`${bin} rm -f ${name}`, { stdio: 'pipe' });
          } catch {
            /* already cleaned */
          }
        }
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Podman-specific tests
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
      expect(args).not.toContain('--user');
    }
  });
});

// ---------------------------------------------------------------------------
// Docker-specific tests
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

  it('includes --user for non-root non-1000 uid', () => {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid != null && uid !== 0 && uid !== 1000) {
      const args = buildContainerArgs(
        [],
        'art-test-docker-user',
        [],
        false,
        false,
        ALPINE_IMAGE,
      );
      expect(args).toContain('--user');
      expect(args).toContain(`${uid}:${gid}`);
    }
  });

  it('includes --gpus all when gpu=true', () => {
    const args = buildContainerArgs(
      [],
      'art-test-docker-gpu',
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
      'art-test-docker-dev',
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
      'art-test-docker-usb',
      ['/dev/bus/usb'],
      false,
      false,
      ALPINE_IMAGE,
    );
    expect(args.join(' ')).toContain('/dev/bus/usb:/dev/bus/usb');
    expect(args).toContain('--device-cgroup-rule');
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
      execSync(`udocker create --name=${containerName} ${ALPINE_IMAGE}`, {
        stdio: 'pipe',
        timeout: 30_000,
      });
      execSync(`udocker setup --execmode=F1 ${containerName}`, {
        stdio: 'pipe',
        timeout: 30_000,
      });

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
