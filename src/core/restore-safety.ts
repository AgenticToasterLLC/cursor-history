/**
 * Restore safety copy, WAL/SHM handling and rollback helpers.
 *
 * Restore replaces live Cursor databases. Before its first write it copies every existing
 * destination (and any `-wal`, `-shm`, `-journal` sitting next to a database) into a
 * restore-safety directory outside Cursor's data, verifies each copy by size and sha256, and
 * records a `manifest.json`. A failed publication is rolled back from that copy. Safety copies are
 * never deleted automatically.
 *
 * Crash-safe publication order for one database `X/state.vscdb` (see `restoreBackup`):
 *   1. stage the new database as a private sibling temporary file and fsync it;
 *   2. rename the old `-wal`/`-shm`/`-journal` aside to `.cursor-history-old-wal-<id>-*`
 *      (they are already in the verified safety copy);
 *   3. rename the staged file over `state.vscdb` and fsync the directory;
 *   4. delete the renamed-aside files.
 * A crash after step 2 leaves the OLD database without its WAL (consistent, recoverable from the
 * safety copy); a crash after step 3 leaves the NEW database with no WAL. At no instant does the
 * new database sit next to the old WAL.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { getDefaultCursorDataPath } from '../lib/platform.js';
import { RestoreSafetyCopyError } from './errors.js';
import {
  assertSafeOutputPath,
  ProtectedPathError,
  realPathThroughAncestors,
} from './write-guard.js';

/** Files that belong to one SQLite database and must travel with it. */
export const DATABASE_COMPANION_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';

function fold(path: string): string {
  const normalized = realPathThroughAncestors(path).replace(/[\\/]+$/u, '');
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function isInside(child: string, parent: string): boolean {
  const c = fold(child);
  const p = fold(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** True when `targetPath` resolves to the platform-default (live) Cursor workspaceStorage. */
export function isLiveDefaultTarget(targetPath: string): boolean {
  try {
    return fold(targetPath) === fold(getDefaultCursorDataPath());
  } catch {
    return false;
  }
}

/** Environment variable that overrides the default restore-safety base directory. */
export const RESTORE_SAFETY_DIR_ENV = 'CURSOR_HISTORY_RESTORE_SAFETY_DIR';

/** Default base directory for restore safety copies (platform cache directory). */
export function defaultRestoreSafetyRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[RESTORE_SAFETY_DIR_ENV];
  if (override && override.trim() !== '') return resolve(override);
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
  return join(base, 'cursor-history', 'restore-safety');
}

/**
 * Resolve and validate the safety base directory. Refuses anything inside Cursor's data.
 *
 * @throws ProtectedPathError when the directory is inside a protected root or the User directory.
 */
export function resolveRestoreSafetyRoot(override: string | undefined, targetPath: string): string {
  const root = resolve(override ?? defaultRestoreSafetyRoot());
  assertSafeOutputPath(root, 'restore-safety', targetPath);
  const userDir = dirname(resolve(targetPath));
  if (isInside(root, userDir)) throw new ProtectedPathError('restore-safety', 'inside-cursor-data');
  return root;
}

/** Size and sha256 of a file, streamed in chunks. */
export function hashFile(path: string): { size: number; sha256: string } {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(path, constants.O_RDONLY);
  let size = 0;
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
  } finally {
    closeSync(descriptor);
  }
  return { size, sha256: hash.digest('hex') };
}

function regularFileExists(path: string): boolean {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile()) throw new Error(`Not a regular file: ${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Existing `-wal`/`-shm`/`-journal` companions of a database path (regular files only). */
export function existingCompanions(databasePath: string): string[] {
  return DATABASE_COMPANION_SUFFIXES.map((suffix) => `${databasePath}${suffix}`).filter(
    regularFileExists
  );
}

/** One entry of the safety `manifest.json`. */
export interface RestoreSafetyManifestEntry {
  /** Path relative to the Cursor User directory, with forward slashes. */
  path: string;
  size: number;
  sha256: string;
}

/** A created, verified safety copy. */
export interface CreatedRestoreSafetyCopy {
  directory: string;
  manifestPath: string;
  entries: RestoreSafetyManifestEntry[];
}

function toRelative(userDir: string, absolute: string): string {
  const rel = relative(userDir, absolute);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new RestoreSafetyCopyError('path-outside-user-directory');
  }
  return rel.split(sep).join('/');
}

/**
 * Copy every source into `<safetyRoot>/<ISO-timestamp>-<id>/<path relative to userDir>`, verify
 * each copy (size + sha256), then write `manifest.json`. Live files are only read.
 *
 * @throws RestoreSafetyCopyError on any failure; nothing live has been touched at that point.
 */
export function createRestoreSafetyCopy(
  userDir: string,
  sources: readonly string[],
  safetyRoot: string
): CreatedRestoreSafetyCopy {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const directory = join(safetyRoot, `${stamp}-${randomUUID().slice(0, 8)}`);
  const entries: RestoreSafetyManifestEntry[] = [];
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const source of sources) {
      const rel = toRelative(userDir, source);
      const copy = join(directory, ...rel.split('/'));
      mkdirSync(dirname(copy), { recursive: true, mode: 0o700 });
      copyFileSync(source, copy, constants.COPYFILE_EXCL);
      const original = hashFile(source);
      const copied = hashFile(copy);
      if (original.size !== copied.size || original.sha256 !== copied.sha256) {
        throw new RestoreSafetyCopyError('verify-failed', directory);
      }
      entries.push({ path: rel, size: original.size, sha256: original.sha256 });
    }
    const manifestPath = join(directory, 'manifest.json');
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          version: 1,
          createdAt: new Date().toISOString(),
          description:
            'cursor-history restore safety copy. To roll back, copy each file back to <User directory>/<path> while Cursor is closed.',
          files: entries,
        },
        null,
        2
      ),
      { flag: 'wx', mode: 0o600 }
    );
    return { directory, manifestPath, entries };
  } catch (error) {
    if (error instanceof RestoreSafetyCopyError) throw error;
    throw new RestoreSafetyCopyError('copy-failed', directory, error);
  }
}

/** fsync a private staging file we own (Windows requires a writable descriptor). */
function fsyncPath(path: string): void {
  const descriptor = openSync(path, constants.O_RDWR);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Rename existing companions aside so they can never be replayed onto a new database.
 *
 * @returns Pairs describing what was moved (aside path, original path).
 */
export function moveCompanionsAside(
  databasePath: string,
  id: string
): Array<{ aside: string; original: string }> {
  const moved: Array<{ aside: string; original: string }> = [];
  for (const original of existingCompanions(databasePath)) {
    const aside = join(dirname(original), `.cursor-history-old-wal-${id}-${basename(original)}`);
    renameSync(original, aside);
    moved.push({ aside, original });
  }
  return moved;
}

/** Best-effort removal of renamed-aside files; returns paths that could not be removed. */
export function removeAsideFiles(asides: readonly string[]): string[] {
  const failed: string[] = [];
  for (const aside of asides) {
    try {
      unlinkSync(aside);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failed.push(aside);
    }
  }
  return failed;
}

function isCompanion(path: string): boolean {
  return DATABASE_COMPANION_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

/**
 * Return every entry of a safety copy to its original location. Idempotent: files that already
 * match the safety copy are left alone. Databases are restored before their companions, so a
 * crash mid-rollback leaves an old database without a WAL, never a mismatched pair.
 *
 * A destination is only overwritten while it holds what restore itself left there (the published
 * content, or nothing). Anything else was changed by someone else after publication and is
 * reported as a failure instead of being clobbered.
 *
 * @param publishedHashes - sha256 restore published at each relative path.
 * @returns Relative paths that could not be restored (empty on full success).
 */
export function rollbackFromSafetyCopy(
  userDir: string,
  safety: CreatedRestoreSafetyCopy,
  id: string,
  publishedHashes: ReadonlyMap<string, string>
): string[] {
  const failures: string[] = [];
  const ordered = [...safety.entries].sort(
    (a, b) => Number(isCompanion(a.path)) - Number(isCompanion(b.path))
  );
  for (const entry of ordered) {
    const destination = join(userDir, ...entry.path.split('/'));
    const source = join(safety.directory, ...entry.path.split('/'));
    const staging = join(dirname(destination), `.cursor-history-restore-${id}-${randomUUID()}.tmp`);
    try {
      if (existsSync(destination)) {
        const current = hashFile(destination);
        if (current.size === entry.size && current.sha256 === entry.sha256) continue;
        if (current.sha256 !== publishedHashes.get(entry.path)) {
          throw new Error('Destination changed after publication; refusing to overwrite it.');
        }
      }
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, staging, constants.COPYFILE_EXCL);
      const staged = hashFile(staging);
      if (staged.size !== entry.size || staged.sha256 !== entry.sha256) {
        throw new Error('Safety copy no longer matches its manifest.');
      }
      fsyncPath(staging);
      renameSync(staging, destination);
    } catch {
      failures.push(entry.path);
      try {
        unlinkSync(staging);
      } catch {
        // Staging may not exist; the failure above is what matters.
      }
    }
  }
  return failures;
}
