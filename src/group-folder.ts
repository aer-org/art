import path from 'path';

import { getDataDir } from './config.js';

// Up to 200 chars total. Stitched stage names compound per nesting level
// (e.g. `origin__template0__stage`), so the cap needs headroom for several
// levels beyond the base `<group>__pipeline_<stage>` prefix.
const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const RESERVED_FOLDERS = new Set(['global']);

// External folder mappings — every group must be registered before its path
// can be resolved. The main project group (e.g. "art-myapp") is registered to
// the project's __art__/ directory. Virtual sub-groups (e.g.
// "art-myapp__pipeline_build") inherit their parent's mapping and resolve to
// the parent's .stages/ subtree.
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
  // Direct external mapping (the main project group)
  const external = externalFolders.get(folder);
  if (external) return external;

  // Virtual sub-group: inherit parent's external mapping and resolve under
  // the parent's .stages/ subtree (e.g. "art-myapp__pipeline_build" →
  // "<parent>/.stages/pipeline_build").
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

  throw new Error(
    `No external mapping registered for group folder "${folder}". ` +
      `Call registerExternalGroupFolder() before resolving group paths.`,
  );
}

export function resolveGroupIpcPath(folder: string): string {
  assertValidGroupFolder(folder);
  const ipcBaseDir = path.resolve(getDataDir(), 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, folder);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}
