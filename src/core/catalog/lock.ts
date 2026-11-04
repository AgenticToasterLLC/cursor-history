/**
 * Cross-process single-writer lock for building one catalog scope.
 *
 * Algorithm:
 *  1. Lockfile `<store>.locks/<digest>.lock` is created with `openSync(path, 'wx')`
 *     (atomic) and holds JSON `{pid, hostname, startedAt, nonce}`.
 *  2. On EEXIST the holder is inspected. It is stale when (same host and the pid
 *     is dead: `kill(pid, 0)` throws ESRCH) or `now - startedAt > ttlMs`. An
 *     unparsable file is stale only once its mtime is older than a short grace
 *     (another process may be between create and write).
 *  3. Recovery is serialized by a short-lived `<digest>.lock.recover` mutex
 *     (itself created with 'wx', stale after RECOVER_STALE_MS). Under the mutex
 *     the lock is re-read and re-checked, our new content is written to a temp
 *     file and renamed over the lock (the lock path is never absent), then the
 *     lock is re-read and ownership verified by nonce. Because only one
 *     recoverer runs at a time and re-checks staleness, two processes cannot
 *     both recover the same stale lock.
 *  4. `release` unlinks the lock only if it still carries our nonce.
 */
import { randomBytes } from 'node:crypto';
import { assertAcceptableCatalogPath } from './identity.js';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import type { CatalogLock } from './contract.js';

interface LockContent {
  pid: number;
  hostname: string;
  startedAt: number;
  nonce: string;
}

const RECOVER_STALE_MS = 10_000;
const UNPARSABLE_GRACE_MS = 2_000;

function readLock(path: string): { raw: string; content: LockContent | undefined } | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockContent>;
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.hostname === 'string' &&
      typeof parsed.startedAt === 'number'
    ) {
      return { raw, content: parsed as LockContent };
    }
  } catch {
    // fall through
  }
  return { raw, content: undefined };
}

function pidIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function isStale(path: string, ttlMs: number, now: number): boolean {
  const lock = readLock(path);
  if (!lock) return false; // vanished; caller retries acquisition
  if (!lock.content) {
    try {
      return now - statSync(path).mtimeMs > UNPARSABLE_GRACE_MS;
    } catch {
      return false;
    }
  }
  const { pid, hostname: host, startedAt } = lock.content;
  if (now - startedAt > ttlMs) return true;
  return host === hostname() && pidIsDead(pid);
}

function serialize(nonce: string): string {
  const content: LockContent = {
    pid: process.pid,
    hostname: hostname(),
    startedAt: Date.now(),
    nonce,
  };
  return JSON.stringify(content);
}

function tryCreate(path: string, body: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  return true;
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

function recoverStale(path: string, ttlMs: number, nonce: string): boolean {
  const mutex = `${path}.recover`;
  if (!tryCreate(mutex, serialize(nonce))) {
    try {
      if (Date.now() - statSync(mutex).mtimeMs > RECOVER_STALE_MS) safeUnlink(mutex);
    } catch {
      // ignore
    }
    return false;
  }
  try {
    if (!isStale(path, ttlMs, Date.now())) return false;
    const tmp = `${path}.${nonce}.tmp`;
    try {
      const body = serialize(nonce);
      if (!tryCreate(tmp, body)) return false;
      renameSync(tmp, path);
    } catch {
      safeUnlink(tmp);
      return false;
    }
    return readLock(path)?.content?.nonce === nonce;
  } finally {
    safeUnlink(mutex);
  }
}

/** Create a lock manager whose lockfiles live in `<storePath>.locks/`. */
export function createCatalogLock(storePath: string): CatalogLock {
  // Lock files may only live next to an accepted catalog path (guard + identity).
  assertAcceptableCatalogPath(storePath);
  const dir = `${storePath}.locks`;
  return {
    tryAcquire(scopeKeyDigest: string, ttlMs: number) {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${scopeKeyDigest}.lock`);
      const nonce = randomBytes(12).toString('hex');
      let held = false;
      for (let attempt = 0; attempt < 3 && !held; attempt += 1) {
        if (tryCreate(path, serialize(nonce))) {
          held = true;
        } else if (isStale(path, ttlMs, Date.now())) {
          held = recoverStale(path, ttlMs, nonce);
          if (!held) return undefined;
        } else if (!readLock(path)) {
          continue; // vanished between EEXIST and read; retry
        } else {
          return undefined;
        }
      }
      if (!held) return undefined;
      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          if (readLock(path)?.content?.nonce === nonce) safeUnlink(path);
        },
      };
    },
  };
}
