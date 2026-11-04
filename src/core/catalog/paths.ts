import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { assertSafeOutputPath } from '../write-guard.js';
import { CATALOG_SCHEMA_VERSION } from './contract.js';
import { CatalogUnavailableError } from './errors.js';

/** Environment variable that overrides the sidecar file path. */
export const CATALOG_PATH_ENV = 'CURSOR_HISTORY_INDEX_PATH';

function fold(p: string): string {
  const normalized = resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? normalized.toLowerCase()
    : normalized;
}

function isInside(child: string, parent: string): boolean {
  const c = fold(child);
  const p = fold(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * True when the path lies inside a Cursor data directory (`.../Cursor/User` or
 * `~/.cursor`). The sidecar must never be written there.
 */
export function isInsideCursorDataDir(candidate: string, home: string = homedir()): boolean {
  const abs = resolve(candidate);
  if (isInside(abs, join(home, '.cursor'))) return true;
  const parts = abs.split(/[\\/]+/u).map((segment) => segment.toLowerCase());
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (parts[i] === 'cursor' && parts[i + 1] === 'user') return true;
  }
  return false;
}

/**
 * Default sidecar path: `CURSOR_HISTORY_INDEX_PATH`, else the platform cache
 * directory. Throws CatalogUnavailableError for a path inside Cursor's data.
 */
export function defaultCatalogPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CATALOG_PATH_ENV];
  let result: string;
  if (override && override.trim() !== '') {
    result = resolve(override);
  } else {
    const home = env['HOME'] || env['USERPROFILE'] || homedir();
    let base: string;
    if (process.platform === 'win32') {
      base = env['LOCALAPPDATA'] || join(home, 'AppData', 'Local');
    } else if (process.platform === 'darwin') {
      base = join(home, 'Library', 'Caches');
    } else {
      const xdg = env['XDG_CACHE_HOME'];
      base = xdg && isAbsolute(xdg) ? xdg : join(home, '.cache');
    }
    result = join(base, 'cursor-history', `catalog-v${CATALOG_SCHEMA_VERSION}.sqlite`);
  }
  assertSafeOutputPath(result, 'catalog');
  const home = env['HOME'] || env['USERPROFILE'] || homedir();
  if (isInsideCursorDataDir(result, home)) {
    throw new CatalogUnavailableError('Catalog path must not be inside Cursor data directories');
  }
  return result;
}
