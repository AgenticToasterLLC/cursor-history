/**
 * Catalog file identity. A file is only ever modified, renamed or deleted by
 * the catalog when it is positively identified as a cursor-history catalog.
 *
 * Identification (read-only, no SQLite involved at this level):
 *  - SQLite header magic `SQLite format 3\0` at offset 0, and
 *  - `PRAGMA application_id` (header offset 68, big-endian) equal to
 *    CATALOG_APPLICATION_ID, written before the file ever enters WAL mode.
 * The store additionally requires a `meta` row `application = CATALOG_MARKER`.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { basename } from 'node:path';

import { assertSafeOutputPath } from '../write-guard.js';
import { CatalogUnavailableError } from './errors.js';

/** Fixed 32-bit application id of cursor-history catalogs ("CHCT"). */
export const CATALOG_APPLICATION_ID = 0x43484354;
/** `meta.application` value of a cursor-history catalog. */
export const CATALOG_MARKER_KEY = 'application';
export const CATALOG_MARKER_VALUE = 'cursor-history-catalog';

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const DEFAULT_NAME = /^catalog-v\d+\.sqlite$/iu;

/** What a path currently holds, judged from its first 100 bytes only. */
export type HeaderKind =
  | 'absent'
  | 'empty'
  | 'ours' // SQLite header with our application_id
  | 'sqlite-other' // SQLite header, other application_id
  | 'not-sqlite'; // anything else (text, ZIP, garbage, directory)

/** True for the catalog's own default file name (`catalog-v<N>.sqlite`). */
export function hasDefaultCatalogName(path: string): boolean {
  return DEFAULT_NAME.test(basename(path));
}

/** Classify a path without opening it for write. */
export function classifyHeader(path: string): HeaderKind {
  if (!existsSync(path)) return 'absent';
  let st;
  try {
    st = statSync(path);
  } catch {
    return 'not-sqlite';
  }
  if (!st.isFile()) return 'not-sqlite';
  if (st.size === 0) return 'empty';
  const buf = Buffer.alloc(100);
  let n = 0;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    n = readSync(fd, buf, 0, 100, 0);
  } catch {
    return 'not-sqlite';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
  if (n < 100 || !buf.subarray(0, 16).equals(SQLITE_MAGIC)) return 'not-sqlite';
  return buf.readUInt32BE(68) === CATALOG_APPLICATION_ID ? 'ours' : 'sqlite-other';
}

/**
 * Cheap acceptance test used before touching anything next to a catalog path
 * (lock directory, sidecar files): the shared write guard must pass and the
 * path must be absent, one of our catalogs, or a recoverable file at the
 * default catalog name.
 *
 * @throws ProtectedPathError for protected locations.
 * @throws CatalogUnavailableError (reason NOT_A_CATALOG) for foreign files.
 */
export function assertAcceptableCatalogPath(path: string): void {
  assertSafeOutputPath(path, 'catalog');
  const kind = classifyHeader(path);
  if (kind === 'absent' || kind === 'ours') return;
  if (hasDefaultCatalogName(path)) return;
  throw new CatalogUnavailableError('Path is not a cursor-history catalog', 'NOT_A_CATALOG');
}
