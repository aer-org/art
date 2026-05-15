/**
 * Persist the most recently opened project directory so the next
 * server start can skip the directory picker. Stored as JSON in
 * `~/.config/aer-art-debug/last-project.json`.
 *
 * Best-effort on both ends: a missing/unreadable file simply means
 * "no auto-restore", and a write failure never blocks loading a
 * project in the running server.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = path.join(
  os.homedir(),
  '.config',
  'aer-art-debug',
  'last-project.json',
);

interface LastProject {
  schemaVersion: 1;
  projectDir: string;
  updatedAt: string;
}

export function loadLastProject(): string | null {
  try {
    const raw = fs.readFileSync(FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<LastProject>;
    if (typeof parsed.projectDir !== 'string') return null;
    return parsed.projectDir;
  } catch {
    return null;
  }
}

export function rememberLastProject(projectDir: string): void {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const data: LastProject = {
      schemaVersion: 1,
      projectDir,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  } catch {
    // Persistence is a UX nicety, never load-critical.
  }
}

export function forgetLastProject(): void {
  try {
    fs.rmSync(FILE, { force: true });
  } catch {
    // ignore
  }
}
