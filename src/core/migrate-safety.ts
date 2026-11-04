/**
 * Pre-write safety for session/workspace migration.
 *
 * Migration writes rows into Cursor's live SQLite databases. Before the first
 * read-write open, `prepareMigrationWrite` (1) refuses to run while Cursor
 * appears to be running, and (2) snapshots every database that will be written
 * into an on-disk safety directory that is never deleted automatically.
 *
 * Consistency: each snapshot is produced with the SQLite online backup API from
 * a read-only connection, so pages still sitting in the `-wal` are included and
 * the copy is a transactionally consistent single file (no `-wal`/`-shm` needed
 * to read it). Every copy is then opened read-only and must pass
 * `PRAGMA integrity_check` before any live database is touched.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, statfs, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { backupDatabase, openDatabase } from './database/index.js';
import { SessionIntegrityError } from './errors.js';
import {
  CursorRunningError,
  assertCursorNotRunning,
  assertSafeOutputPath,
  realPathThroughAncestors,
} from './write-guard.js';
import { getDefaultCursorDataPath } from '../lib/platform.js';

/** Milliseconds SQLite waits for a competing lock before reporting the database busy. */
export const MIGRATION_BUSY_TIMEOUT_MS = 5000;

/** Extra free bytes required on top of the estimated copy size. */
const DISK_HEADROOM_BYTES = 64 * 1024 * 1024;

/** Safety-copy options shared by the core and library migration APIs. */
export interface MigrationSafetyOptions {
  /** Directory that receives the safety copy (a unique subdirectory is created inside). */
  readonly safetyCopyDir?: string;
  /**
   * Skip the safety copy. Refused when any database to be written lives in the
   * platform-default Cursor directory: real user data is never written without
   * a restorable on-disk copy. Only meaningful for custom data paths and fixtures.
   */
  readonly skipSafetyCopy?: boolean;
}

/** One file recorded in the safety manifest. */
export interface MigrationSafetyFile {
  /** Path relative to the safety directory. */
  readonly path: string;
  /** Path of the live database that was copied. */
  readonly originalPath: string;
  readonly size: number;
  readonly sha256: string;
}

/** Description of a completed safety copy. */
export interface MigrationSafetyCopy {
  readonly directory: string;
  readonly manifestPath: string;
  readonly totalBytes: number;
  readonly files: MigrationSafetyFile[];
}

/** Blocking condition reported by dry runs instead of throwing. */
export interface MigrationBlocker {
  readonly code: 'CURSOR_RUNNING';
  readonly message: string;
  readonly evidence: string[];
}

/** Test seam for the free-space probe. @internal */
export const migrationSafetyHooks: {
  statfs: (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
} = { statfs: (path) => statfs(path) };

/** The safety copy could not be created or verified; no live data was written. */
export class MigrationSafetyCopyError extends SessionIntegrityError<
  'MIGRATION_SAFETY_COPY_FAILED',
  { reason: string; directory?: string }
> {
  override readonly name = 'MigrationSafetyCopyError';
  constructor(reason: string, directory?: string) {
    super(
      'MIGRATION_SAFETY_COPY_FAILED',
      `Migration aborted before any change: the safety copy could not be created (${reason}). Nothing was written to Cursor's data.`,
      { reason, ...(directory ? { directory } : {}) }
    );
  }
}

/** Not enough free disk space for the safety copy. */
export class InsufficientDiskSpaceError extends SessionIntegrityError<
  'INSUFFICIENT_DISK_SPACE',
  { requiredBytes: number; availableBytes: number }
> {
  override readonly name = 'InsufficientDiskSpaceError';
  constructor(requiredBytes: number, availableBytes: number) {
    super(
      'INSUFFICIENT_DISK_SPACE',
      `Migration aborted before any change: the safety copy needs about ${String(requiredBytes)} bytes but only ${String(availableBytes)} bytes are free. Free space or set safetyCopyDir to a larger volume.`,
      { requiredBytes, availableBytes }
    );
  }
}

/** `skipSafetyCopy` was requested for the platform-default Cursor directory. */
export class SafetyCopyRefusedError extends SessionIntegrityError<
  'SAFETY_COPY_REQUIRED',
  { reason: string }
> {
  override readonly name = 'SafetyCopyRefusedError';
  constructor() {
    super(
      'SAFETY_COPY_REQUIRED',
      'skipSafetyCopy is not allowed for the platform-default Cursor directory: migration always keeps a restorable on-disk copy of real Cursor data. Use a custom data path or remove skipSafetyCopy.',
      { reason: 'default-cursor-directory' }
    );
  }
}

/** A database is locked by another process (normally a running Cursor). */
export class MigrationDatabaseBusyError extends SessionIntegrityError<
  'CURSOR_RUNNING',
  { operation: string; evidence: string[] }
> {
  override readonly name = 'MigrationDatabaseBusyError';
  constructor(operation = 'migrate') {
    super(
      'CURSOR_RUNNING',
      `Cannot ${operation}: the Cursor database is in use by another process (SQLITE_BUSY/LOCKED). Close Cursor completely and try again.`,
      { operation, evidence: ['database-locked'] }
    );
  }
}

/** True for SQLITE_BUSY / SQLITE_LOCKED style failures from either driver. */
export function isDatabaseBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  const errcode = (error as { errcode?: unknown }).errcode;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true;
  if (errcode === 5 || errcode === 6) return true;
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/iu.test(
    error.message
  );
}

/** Convert a busy/locked failure into the typed error; return other errors unchanged. */
export function translateBusyError(error: unknown, operation = 'migrate'): unknown {
  return isDatabaseBusyError(error) ? new MigrationDatabaseBusyError(operation) : error;
}

function foldCase(value: string): string {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? value.toLowerCase()
    : value;
}

function insideDirectory(child: string, parent: string): boolean {
  const c = foldCase(realPathThroughAncestors(child));
  const p = foldCase(realPathThroughAncestors(parent));
  const rel = relative(p, c);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** True when a database lies inside the platform-default Cursor `User` directory. */
export function touchesDefaultCursorDirectory(databases: readonly string[]): boolean {
  let root: string;
  try {
    root = dirname(getDefaultCursorDataPath());
  } catch {
    return false;
  }
  return databases.some((db) => insideDirectory(db, root));
}

/** Platform cache directory, resolved like the catalog sidecar (env read at call time). */
export function defaultSafetyBaseDir(env: NodeJS.ProcessEnv = process.env): string {
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
  return join(base, 'cursor-history', 'migrate-safety');
}

function existingDatabases(databases: readonly string[]): string[] {
  return [...new Set(databases)].filter((db) => existsSync(db));
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Estimated bytes a safety copy of these databases needs (db plus pending WAL). */
export function estimateSafetyCopyBytes(databases: readonly string[]): number {
  return existingDatabases(databases).reduce(
    (sum, db) => sum + fileSize(db) + fileSize(`${db}-wal`),
    0
  );
}

/** Dry-run helper: report whether a write would be blocked, without throwing. */
export function evaluateMigrationBlockers(databases: readonly string[]): MigrationBlocker[] {
  try {
    assertCursorNotRunning('migrate', existingDatabases(databases));
    return [];
  } catch (error) {
    if (error instanceof CursorRunningError) {
      return [
        { code: 'CURSOR_RUNNING', message: error.message, evidence: [...error.details.evidence] },
      ];
    }
    throw error;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function verifyCopy(path: string): Promise<void> {
  const db = await openDatabase(path);
  try {
    const rows = db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
    const values = rows.map((row) => String(Object.values(row)[0]));
    if (values.length !== 1 || values[0] !== 'ok') {
      throw new Error(`integrity_check failed: ${values.slice(0, 3).join('; ')}`);
    }
  } finally {
    db.close();
  }
}

async function assertFreeSpace(directory: string, requiredBytes: number): Promise<void> {
  let probe = realPathThroughAncestors(directory);
  // statfs needs an existing path: use the nearest existing ancestor of the (not yet created) directory.
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  let available: number;
  try {
    const stats = await migrationSafetyHooks.statfs(probe);
    available = Number(stats.bavail) * Number(stats.bsize);
  } catch (error) {
    throw new MigrationSafetyCopyError(
      `free disk space could not be determined: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const required = requiredBytes + DISK_HEADROOM_BYTES;
  if (available < required) throw new InsufficientDiskSpaceError(required, available);
}

/**
 * Gate every migration write. Order: skip-refusal, Cursor-running check, then
 * the safety copy. Throws before any live database is opened read-write.
 *
 * The copy may take minutes for large global databases (multi-GB).
 *
 * @param databases - Every database that will be written.
 * @param options - Safety directory override and skip escape hatch.
 * @param dataPath - Custom data path in use (for protected-path checks).
 * @returns The completed copy, or undefined when `skipSafetyCopy` was honored.
 */
export async function prepareMigrationWrite(
  databases: readonly string[],
  options: MigrationSafetyOptions = {},
  dataPath?: string
): Promise<MigrationSafetyCopy | undefined> {
  const targets = existingDatabases(databases);
  if (options.skipSafetyCopy && touchesDefaultCursorDirectory(targets)) {
    throw new SafetyCopyRefusedError();
  }
  assertCursorNotRunning('migrate', targets);
  if (options.skipSafetyCopy) return undefined;

  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const override = options.safetyCopyDir ?? process.env['CURSOR_HISTORY_SAFETY_DIR'];
  const base = override ? resolve(override) : defaultSafetyBaseDir();
  const directory = join(base, `${stamp}-${randomUUID().slice(0, 8)}`);
  // Throws ProtectedPathError for anything inside Cursor's data.
  assertSafeOutputPath(directory, 'migrate-safety', dataPath);

  await assertFreeSpace(directory, estimateSafetyCopyBytes(targets));
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new MigrationSafetyCopyError(
      `cannot create safety directory: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const files: MigrationSafetyFile[] = [];
  try {
    for (const [index, original] of targets.entries()) {
      const folder = `db-${String(index + 1)}-${basename(dirname(original)).replace(/[^\w.-]/gu, '_')}`;
      const destination = join(directory, folder, basename(original));
      await mkdir(dirname(destination), { recursive: true });
      await backupDatabase(original, destination, {
        operation: 'backup',
        required: new Set(['onlineBackup']),
      });
      await verifyCopy(destination);
      files.push({
        path: `${folder}/${basename(original)}`,
        originalPath: original,
        size: statSync(destination).size,
        sha256: await sha256File(destination),
      });
    }
    const manifestPath = join(directory, 'manifest.json');
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    await writeFile(
      manifestPath,
      `${JSON.stringify({ version: 1, createdAt: new Date().toISOString(), method: 'sqlite-online-backup', files }, null, 2)}\n`
    );
    return { directory, manifestPath, totalBytes, files };
  } catch (error) {
    if (error instanceof SessionIntegrityError) throw error;
    if (isDatabaseBusyError(error)) throw new MigrationDatabaseBusyError();
    throw new MigrationSafetyCopyError(
      error instanceof Error ? error.message : String(error),
      directory
    );
  }
}
