/**
 * Shared write-safety guard.
 *
 * Every code path that writes a file chosen by a caller (backup output,
 * export output, the catalog sidecar, audit logs) must call
 * `assertSafeOutputPath` first. Code paths that intentionally write live
 * Cursor data (restore, migrate) must call `assertCursorNotRunning` and keep
 * an on-disk safety copy before their first write.
 *
 * Protected locations are derived from the actual resolvers, not from folder
 * names, and compared on real paths (symlinks/junctions resolved through the
 * nearest existing ancestor). Comparison is case-insensitive on Windows and
 * macOS.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  getCursorDataPath,
  getDefaultCursorDataPath,
  getGlobalStoragePath,
} from '../lib/platform.js';
import { SessionIntegrityError } from './errors.js';

/** Why a write target was refused. */
export type ProtectedPathReason =
  | 'inside-cursor-data'
  | 'inside-cursor-global-storage'
  | 'inside-cursor-store'
  | 'database-file-name';

/** Purpose of the attempted write, reported in errors (content-free). */
export type GuardedWritePurpose =
  | 'backup-output'
  | 'export-output'
  | 'training-output'
  | 'catalog'
  | 'audit-log'
  | 'migrate-safety';

/**
 * Refuses a caller-chosen write target inside Cursor's data, or named like a
 * Cursor/Store database. Details carry only the purpose and reason, never paths.
 *
 * @param purpose - What the write was for.
 * @param reason - Which protection rule matched.
 */
export class ProtectedPathError extends SessionIntegrityError<
  'PROTECTED_PATH',
  { purpose: GuardedWritePurpose; reason: ProtectedPathReason }
> {
  override readonly name = 'ProtectedPathError';

  constructor(purpose: GuardedWritePurpose, reason: ProtectedPathReason) {
    super(
      'PROTECTED_PATH',
      `Refusing to write ${purpose} output: the target is ${describeReason(reason)}. Choose a path outside Cursor's data directories.`,
      { purpose, reason }
    );
  }
}

/**
 * Refuses an operation that writes live Cursor data while Cursor appears to
 * be running (a running Cursor can overwrite or corrupt concurrent changes).
 *
 * @param operation - The refused operation (for example `restore` or `migrate`).
 * @param evidence - Content-free evidence kinds, e.g. `process`, `wal`.
 */
export class CursorRunningError extends SessionIntegrityError<
  'CURSOR_RUNNING',
  { operation: string; evidence: string[] }
> {
  override readonly name = 'CursorRunningError';

  constructor(operation: string, evidence: string[]) {
    super(
      'CURSOR_RUNNING',
      `Refusing to ${operation} while Cursor appears to be running (${evidence.join(', ')}). Quit Cursor completely and try again.`,
      { operation, evidence }
    );
  }
}

function describeReason(reason: ProtectedPathReason): string {
  switch (reason) {
    case 'inside-cursor-data':
      return "inside Cursor's workspace data directory";
    case 'inside-cursor-global-storage':
      return "inside Cursor's global storage directory";
    case 'inside-cursor-store':
      return "inside Cursor's agent Store directory";
    case 'database-file-name':
      return 'named like a Cursor database file';
  }
}

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';

/** Real path of `p`, resolving through the nearest existing ancestor. */
export function realPathThroughAncestors(p: string): string {
  let current = resolve(p);
  const tail: string[] = [];
  for (;;) {
    if (existsSync(current)) {
      let real: string;
      try {
        real = realpathSync.native(current);
      } catch {
        real = current;
      }
      return tail.length ? join(real, ...tail.reverse()) : real;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(p);
    tail.push(basename(current));
    current = parent;
  }
}

function key(p: string): string {
  const normalized = realPathThroughAncestors(p).replace(/[\\/]+$/u, '');
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function isInside(child: string, parent: string): boolean {
  const c = key(child);
  const p = key(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Protected roots for the current environment (resolved, deduplicated). */
export interface ProtectedRoots {
  data: string[];
  globalStorage: string[];
  store: string[];
}

/**
 * Resolve every location a write must never land in: the active Composer
 * root (honoring CURSOR_DATA_PATH / a custom data path), the platform default
 * Composer root, both global storage dirs, and the Store roots.
 *
 * @param customDataPath - Optional explicit data path in use by the caller.
 * @returns The protected roots, deduplicated.
 */
export function resolveProtectedRoots(customDataPath?: string): ProtectedRoots {
  const data = new Set<string>();
  const globalStorage = new Set<string>();
  const store = new Set<string>();
  const add = (set: Set<string>, value: () => string): void => {
    try {
      const v = value();
      if (v) set.add(resolve(v));
    } catch {
      // A resolver may throw on unsupported platforms; skip it.
    }
  };
  add(data, () => getCursorDataPath(customDataPath));
  add(data, () => getDefaultCursorDataPath());
  add(globalStorage, () => getGlobalStoragePath(customDataPath));
  add(globalStorage, () => join(dirname(getDefaultCursorDataPath()), 'globalStorage'));
  add(store, () => join(homedir(), '.cursor'));
  const storeEnv = process.env['CURSOR_STORE_ROOT'];
  if (storeEnv) store.add(resolve(storeEnv));
  return { data: [...data], globalStorage: [...globalStorage], store: [...store] };
}

const DATABASE_NAME = /^(?:state\.vscdb|store\.db)(?:$|[-.])|\.vscdb(?:$|-wal$|-shm$|-journal$)/iu;

/**
 * Return why `target` is protected, or undefined when it is safe to write.
 *
 * @param target - Caller-chosen output path.
 * @param customDataPath - Optional explicit data path in use by the caller.
 * @returns The matching protection reason, or undefined.
 */
export function protectedPathReason(
  target: string,
  customDataPath?: string
): ProtectedPathReason | undefined {
  if (DATABASE_NAME.test(basename(target))) return 'database-file-name';
  const roots = resolveProtectedRoots(customDataPath);
  if (roots.data.some((root) => isInside(target, root))) return 'inside-cursor-data';
  if (roots.globalStorage.some((root) => isInside(target, root)))
    return 'inside-cursor-global-storage';
  if (roots.store.some((root) => isInside(target, root))) return 'inside-cursor-store';
  return undefined;
}

/**
 * Throw ProtectedPathError when `target` is inside Cursor's data or is named
 * like a database file. Call before creating, renaming over, truncating or
 * deleting any caller-chosen path.
 *
 * @param target - Caller-chosen output path.
 * @param purpose - What the write is for (reported in the error).
 * @param customDataPath - Optional explicit data path in use by the caller.
 * @throws ProtectedPathError when the target is protected.
 */
export function assertSafeOutputPath(
  target: string,
  purpose: GuardedWritePurpose,
  customDataPath?: string
): void {
  const reason = protectedPathReason(target, customDataPath);
  if (reason) throw new ProtectedPathError(purpose, reason);
}

/** Content-free evidence that Cursor is running. */
export interface CursorRunningEvidence {
  running: boolean;
  evidence: Array<'process' | 'wal'>;
}

function cursorProcessRunning(): boolean {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'tasklist',
        ['/FI', 'IMAGENAME eq Cursor.exe', '/NH', '/FO', 'CSV'],
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 10_000,
        }
      );
      return /"Cursor\.exe"/iu.test(out);
    }
    const name = process.platform === 'darwin' ? 'Cursor' : 'cursor';
    execFileSync('pgrep', ['-x', name], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect a running Cursor: a Cursor process, or a non-empty `-wal` next to any
 * of the given databases (an open WAL-mode connection keeps unmerged pages there).
 *
 * @param databases - Database paths the operation will write.
 * @returns Whether Cursor appears to be running, with content-free evidence.
 */
export function detectCursorRunning(databases: readonly string[]): CursorRunningEvidence {
  const evidence: Array<'process' | 'wal'> = [];
  if (cursorProcessRunning()) evidence.push('process');
  for (const db of databases) {
    try {
      if (statSync(`${db}-wal`).size > 0) {
        evidence.push('wal');
        break;
      }
    } catch {
      // No WAL file: nothing pending.
    }
  }
  return { running: evidence.length > 0, evidence };
}

/**
 * Throw CursorRunningError when Cursor appears to be running. Restore and
 * migrate call this before their first write to live data.
 *
 * CURSOR_HISTORY_SKIP_RUNNING_CHECK=1 lets tests on synthetic fixtures run
 * while a developer's Cursor is open. It is ignored whenever any target
 * database is inside the platform-default Cursor directories, so it can never
 * disable the check for real Cursor data.
 *
 * @param operation - The operation being guarded (`restore`, `migrate`).
 * @param databases - Database paths the operation will write.
 * @throws CursorRunningError when Cursor appears to be running.
 */
export function assertCursorNotRunning(operation: string, databases: readonly string[]): void {
  if (process.env['CURSOR_HISTORY_SKIP_RUNNING_CHECK'] === '1') {
    let defaultRoots: string[] = [];
    try {
      const defaultData = getDefaultCursorDataPath();
      defaultRoots = [defaultData, join(dirname(defaultData), 'globalStorage')];
    } catch {
      defaultRoots = [];
    }
    const touchesRealCursor = databases.some((db) =>
      defaultRoots.some((root) => isInside(db, root))
    );
    if (!touchesRealCursor) return;
  }
  const result = detectCursorRunning(databases);
  if (result.running) throw new CursorRunningError(operation, result.evidence);
}
