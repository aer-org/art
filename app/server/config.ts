import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PORT = Number(process.env.AER_ART_APP_PORT ?? 4000);
export const APP_ROOT = path.resolve(__dirname, '..');
export const WEB_DIST = path.join(APP_ROOT, 'web', 'dist');

export const ART_BIN = process.env.ART_BIN ?? 'art';
export const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';

export const ART_DIR_NAME = '__art__';

export function childProcessEnv(): NodeJS.ProcessEnv {
  const nodeDir = path.dirname(process.execPath);
  const currentPath = process.env.PATH ?? '';
  const pathParts = currentPath.split(path.delimiter).filter(Boolean);
  const PATH = pathParts.includes(nodeDir)
    ? currentPath
    : [nodeDir, ...pathParts].join(path.delimiter);

  return {
    ...process.env,
    PATH,
  };
}
