import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe } from 'vitest';

import type { RuntimeKind } from '../../src/container-runtime.js';

export const ALPINE_IMAGE = 'alpine:latest';

/**
 * Docker/Podman runtimes that share full capabilities.
 * Used to parameterize common tests across both runtimes.
 */
export const FULL_RUNTIMES: Array<{ kind: RuntimeKind; bin: string }> = [
  { kind: 'docker', bin: 'docker' },
  { kind: 'podman', bin: 'podman' },
];

/**
 * Check if a container runtime binary is available and functional.
 * For docker: accepts podman-docker alias (tests docker CLI compatibility).
 */
export function isRuntimeAvailable(kind: RuntimeKind): boolean {
  try {
    switch (kind) {
      case 'docker':
        execSync('docker info', { stdio: 'pipe', timeout: 10_000 });
        return true;
      case 'podman':
        execSync('podman info', { stdio: 'pipe', timeout: 10_000 });
        return true;
      case 'udocker':
        execSync('udocker version', { stdio: 'pipe', timeout: 10_000 });
        return true;
    }
  } catch {
    return false;
  }
}

/**
 * Check if the docker binary is actually podman (podman-docker alias).
 */
export function isDockerActuallyPodman(): boolean {
  try {
    const info = execSync('docker info', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    return info.toLowerCase().includes('podman');
  } catch {
    return false;
  }
}

/**
 * Detect if SELinux is enforcing on this system.
 */
export function detectSystemSELinux(): boolean {
  if (os.platform() !== 'linux') return false;
  try {
    const out = execSync('getenforce', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 3_000,
    }).trim();
    return out !== 'Disabled';
  } catch {
    return false;
  }
}

/**
 * Conditionally run a describe block only when the given runtime is available.
 * Skips with a message when unavailable.
 */
export function describeRuntime(
  kind: RuntimeKind,
  fn: () => void,
): ReturnType<typeof describe> {
  const available = isRuntimeAvailable(kind);
  return describe.skipIf(!available)(`Runtime: ${kind}`, fn);
}

/**
 * Ensure alpine image is available for the given runtime.
 */
export function ensureAlpineImage(bin: string): void {
  try {
    execSync(`${bin} image inspect ${ALPINE_IMAGE}`, {
      stdio: 'pipe',
      timeout: 10_000,
    });
  } catch {
    execSync(`${bin} pull ${ALPINE_IMAGE}`, {
      stdio: 'pipe',
      timeout: 120_000,
    });
  }
}

/**
 * Create a temporary directory that is cleaned up after the callback.
 */
export function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `art-integration-${prefix}-`));
}

export function cleanupTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/**
 * Run a container with the given runtime binary and return stdout/stderr/code.
 * Uses spawnSync to avoid shell quoting issues with arguments.
 */
export function runContainer(
  bin: string,
  args: string[],
  options?: { stdin?: string; timeout?: number },
): { code: number; stdout: string; stderr: string } {
  const { stdin, timeout = 30_000 } = options ?? {};
  const result = spawnSync(bin, args, {
    encoding: 'utf-8',
    timeout,
    input: stdin,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}
