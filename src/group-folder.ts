import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';

// Up to 200 chars total. Stitched stage names compound per nesting level
// (e.g. `origin__template0__stage`), so the cap needs headroom for several
// levels beyond the base `<group>__pipeline_<stage>` prefix.
const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const RESERVED_FOLDERS = new Set(['global']);

// External folder overrides — allows groups to live outside GROUPS_DIR (e.g., __art__/)
const externalFolders = new Map<string, string>();

export function registerExternalGroupFolder(
  folder: string,
  absolutePath: string,
): void {
  externalFolders.set(folder, absolutePath);
}

export function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid group folder "${folder}"`);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

export function resolveGroupFolderPath(folder: string): string {
  // Check external overrides first (art mode)
  const external = externalFolders.get(folder);
  if (external) return external;

  // Inherit parent's external mapping for virtual sub-groups (e.g.
  // "art-myapp__pipeline_build"), so per-stage artifacts (conversations,
  // .state/logs) live under the project's __art__/ rather than GROUPS_DIR
  // (which is the engine install location and may be read-only when
  // installed as an npm package).
  for (const [parent, parentPath] of externalFolders) {
    if (folder.startsWith(`${parent}__`)) {
      assertValidGroupFolder(folder);
      const suffix = folder.slice(parent.length + 2);
      const stagesBase = path.resolve(parentPath, '.stages');
      const resolved = path.resolve(stagesBase, suffix);
      ensureWithinBase(stagesBase, resolved);
      return resolved;
    }
  }

  assertValidGroupFolder(folder);
  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

export function resolveGroupIpcPath(folder: string): string {
  assertValidGroupFolder(folder);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, folder);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}
