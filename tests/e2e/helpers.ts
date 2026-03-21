import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Install the package globally from a local tarball (npm pack → npm install -g).
 * Call once in globalSetup or beforeAll. Returns the tarball path for cleanup.
 */
export function installGlobal(): string {
  // npm pack outputs build logs + filename; grab the last non-empty line
  const output = execSync('npm pack --pack-destination /tmp', {
    encoding: 'utf-8',
    timeout: 60_000,
  });
  const lines = output.trim().split('\n').filter(Boolean);
  const tarball = lines[lines.length - 1].trim();
  const tgzPath = path.join('/tmp', tarball);
  execSync(`npm install -g "${tgzPath}"`, {
    stdio: 'pipe',
    timeout: 60_000,
  });
  return tgzPath;
}

/**
 * Uninstall the globally installed package.
 */
export function uninstallGlobal(): void {
  try {
    execSync('npm uninstall -g @aer-org/art', {
      stdio: 'pipe',
      timeout: 30_000,
    });
  } catch {
    // best effort
  }
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
 * Run `art` CLI via the globally installed binary.
 */
export function runArt(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
  timeoutMs = 300_000,
): RunResult {
  const result = spawnSync('art', args, {
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
 * List files included in the npm package (npm pack --dry-run).
 * Returns an array of relative file paths.
 */
export function listPackageFiles(): string[] {
  const output = execSync('npm pack --dry-run 2>&1', {
    encoding: 'utf-8',
    timeout: 60_000,
  });
  const files: string[] = [];
  for (const line of output.split('\n')) {
    // npm notice <size> <path>
    const match = line.match(/^npm notice\s+[\d.]+\s*[kMG]?B\s+(.+)$/);
    if (match) files.push(match[1].trim());
  }
  return files;
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
