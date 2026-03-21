import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CLI_PATH = path.resolve('dist/cli/index.js');

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Copy a fixture directory to a temp directory and return the path.
 */
export function copyFixture(name: string): string {
  const fixtureDir = path.join('tests', 'e2e', 'fixtures', name);
  if (!fs.existsSync(fixtureDir)) {
    throw new Error(`Fixture not found: ${fixtureDir}`);
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `art-e2e-${name}-`));
  fs.cpSync(fixtureDir, tmpDir, { recursive: true });
  return tmpDir;
}

/**
 * Run `art` CLI via node and return exit code, stdout, stderr.
 */
export function runArt(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
  timeoutMs = 300_000,
): RunResult {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    cwd,
    timeout: timeoutMs,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Clean up a fixture temp directory.
 */
export function cleanupFixture(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/**
 * Read PIPELINE_STATE.json from an __art__ directory.
 */
export function readPipelineState(
  artDir: string,
): Record<string, unknown> | null {
  const stateFile = path.join(artDir, 'PIPELINE_STATE.json');
  if (!fs.existsSync(stateFile)) return null;
  return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
}

/**
 * Check if Docker is available.
 */
export function isDockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a Docker image exists locally.
 */
export function imageExists(imageName: string): boolean {
  try {
    execSync(`docker image inspect ${imageName}`, {
      stdio: 'pipe',
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}
