/**
 * Sidecar catalog store: one SQLite file (WAL, sidecar only) holding the latest
 * complete snapshot per read scope. Cursor databases are never touched.
 *
 * Driver choice: the repo's driver layer (`src/core/database`), selected with the
 * `readWrite` capability. The contract's `openCatalogStore` is synchronous while
 * driver selection is async, so callers must first `await ensureCatalogDriver()`
 * (or use `openCatalogStoreAsync`); `openCatalogStore` then uses the registry's
 * synchronous `openSync`. Without a prepared driver it throws
 * CatalogUnavailableError.
 *
 * Permissions: on POSIX the file is created 0600 before SQLite touches it and
 * the directory 0700. On Windows no persistent-file ACL helper exists in the
 * repo (private-temp only covers temp dirs); the default per-user
 * %LOCALAPPDATA% ACL applies and POSIX mode bits are not meaningful.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { registry } from '../database/registry.js';
import '../database/index.js'; // registers the drivers
import type { Database, DatabaseOperationRequest } from '../database/types.js';
import {
  CATALOG_PROJECTION_EPOCH,
  CATALOG_SCHEMA_VERSION,
  type CatalogScopeKey,
  type CatalogSnapshotHeader,
  type CatalogStore,
  type SourceFingerprint,
} from './contract.js';
import { CatalogUnavailableError } from './errors.js';
import { defaultCatalogPath } from './paths.js';

const BUSY_TIMEOUT_MS = 5000;

const CATALOG_REQUEST: DatabaseOperationRequest = {
  operation: 'migrate',
  required: new Set(['readWrite']),
};

/** Sidecar schema (also reported by the implementer). */
export const CATALOG_SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_key_digest TEXT NOT NULL UNIQUE,
  scope_key_json TEXT NOT NULL,
  fingerprint_json TEXT NOT NULL,
  built_at TEXT NOT NULL,
  build_ms INTEGER NOT NULL,
  row_count INTEGER NOT NULL,
  diagnostics_json TEXT NOT NULL,
  scope_json TEXT,
  search_indexed INTEGER NOT NULL DEFAULT 0,
  search_message_count INTEGER,
  search_index_bytes INTEGER
);
CREATE TABLE IF NOT EXISTS snapshot_rows (
  snapshot_id INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  row_json TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, ordinal)
) WITHOUT ROWID;
-- Opt-in search index (schema v2). Per snapshot there is one contentless FTS5 trigram table
-- search_fts_<snapshot_id>(body) holding lowercased message text postings only (no bodies);
-- its rowid is message_locator.row_id.
CREATE TABLE IF NOT EXISTS search_sessions (
  snapshot_id INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, ordinal)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS message_locator (
  snapshot_id INTEGER NOT NULL,
  row_id INTEGER NOT NULL,
  session_ordinal INTEGER NOT NULL,
  message_index INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, row_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS scope_state (
  scope_key_digest TEXT PRIMARY KEY,
  verified_at TEXT,
  last_error_code TEXT,
  last_error_at TEXT
);
`;

/** Per-scope verification/error state. */
export interface CatalogScopeState {
  verifiedAt?: string;
  lastError?: { code: string; at: string };
}

/** Store with the additional (non-contract) accessors C2/C3 may use. */
export interface CatalogStoreExtended extends CatalogStore {
  getScopeState(scopeKeyDigest: string): CatalogScopeState | undefined;
  recordScopeError(scopeKeyDigest: string, code: string, at: string): void;
  listSnapshotHeaders(): CatalogSnapshotHeader[];
  /** Start filling the search index of a published snapshot (opt-in; see contract.ts). */
  beginSearchIndex(snapshotId: number): SearchIndexWriter;
  /**
   * Candidate sessions whose indexed text contains the query as a case-insensitive substring
   * (a superset: FTS5 trigram phrase match). The query must be eligible (see search-index.ts).
   * Returns session id -> message indexes.
   */
  searchCandidates(snapshotId: number, query: string): Map<string, number[]>;
}

/** Incremental writer for one snapshot's search index; only `finish()` makes it searchable. */
export interface SearchIndexWriter {
  /** Index one session's messages (text is indexed as given; callers pass lowercased content). */
  addSession(sessionId: string, messages: ReadonlyArray<{ index: number; text: string }>): void;
  /** Mark the index complete and record message count and bytes on the snapshot header. */
  finish(): { messageCount: number; indexBytes?: number };
  /** Drop a partially written index. */
  abort(): void;
}

/** FTS5 phrase for a literal string: doubled quotes inside double quotes. */
export function toFtsPhrase(query: string): string {
  return `"${query.replaceAll('"', '""')}"`;
}

function ftsTable(snapshotId: number): string {
  return `search_fts_${Math.trunc(snapshotId)}`;
}

/** Select a readWrite-capable driver; must complete before openCatalogStore(). */
export async function ensureCatalogDriver(): Promise<void> {
  try {
    await registry.ensureDriver(CATALOG_REQUEST);
  } catch {
    throw new CatalogUnavailableError('No SQLite driver can open the catalog');
  }
}

/** Async convenience: prepare the driver, then open the store. */
export async function openCatalogStoreAsync(options?: { path?: string }): Promise<CatalogStore> {
  await ensureCatalogDriver();
  return openCatalogStore(options);
}

function isBusy(error: unknown): boolean {
  const text = `${(error as { code?: string })?.code ?? ''} ${(error as Error)?.message ?? ''}`;
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked/iu.test(text);
}

function createOwnerOnly(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) return;
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o600);
    } catch {
      // best effort
    }
  }
}

function moveAside(path: string): void {
  const stamp = `${Date.now()}-${process.pid}`;
  try {
    renameSync(path, `${path}.corrupt-${stamp}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      try {
        unlinkSync(path);
      } catch {
        throw new CatalogUnavailableError('Catalog file is corrupt and cannot be replaced');
      }
    }
  }
  for (const suffix of ['-wal', '-shm']) {
    try {
      unlinkSync(path + suffix);
    } catch {
      // absent
    }
  }
}

function readMeta(db: Database): Map<string, string> {
  const rows = db.prepare('SELECT key, value FROM meta').all() as Array<{
    key: string;
    value: string;
  }>;
  return new Map(rows.map((r) => [r.key, r.value]));
}

/** Open + validate. Throws a plain Error on corruption/incompatibility (recoverable). */
function openAndInit(path: string): Database {
  createOwnerOnly(path);
  const db = registry.openSync(path, { readonly: false });
  try {
    db.runSQL(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.prepare('PRAGMA journal_mode = WAL').get();
    db.runSQL('PRAGMA synchronous = NORMAL');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{
      name: string;
    }>;
    if (tables.length === 0) {
      db.runSQL('BEGIN IMMEDIATE');
      try {
        db.runSQL(CATALOG_SCHEMA_DDL);
        const ins = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
        ins.run('schema_version', String(CATALOG_SCHEMA_VERSION));
        ins.run('projection_epoch', String(CATALOG_PROJECTION_EPOCH));
        ins.run('created_at', new Date().toISOString());
        db.runSQL('COMMIT');
      } catch (error) {
        try {
          db.runSQL('ROLLBACK');
        } catch {
          // ignore
        }
        throw error;
      }
      return db;
    }
    const meta = readMeta(db);
    if (
      meta.get('schema_version') !== String(CATALOG_SCHEMA_VERSION) ||
      meta.get('projection_epoch') !== String(CATALOG_PROJECTION_EPOCH)
    ) {
      throw new Error('catalog schema or projection epoch mismatch');
    }
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // ignore
    }
    throw error;
  }
}

/** Open (creating or recovering) the sidecar store. Synchronous; see module comment. */
export function openCatalogStore(options?: { path?: string }): CatalogStoreExtended {
  const path = options?.path ?? defaultCatalogPath();
  if (!registry.hasActiveDriver()) {
    throw new CatalogUnavailableError('Catalog driver not prepared');
  }
  let db: Database | undefined;
  try {
    db = openAndInit(path);
  } catch (first) {
    if (first instanceof CatalogUnavailableError || isBusy(first)) {
      throw first instanceof CatalogUnavailableError
        ? first
        : new CatalogUnavailableError('Catalog is locked by another process');
    }
    try {
      moveAside(path);
      db = openAndInit(path);
    } catch (second) {
      if (second instanceof CatalogUnavailableError) throw second;
      throw new CatalogUnavailableError('Catalog could not be opened or recreated');
    }
  }
  return new SqliteCatalogStore(path, db);
}

interface SnapshotRow {
  snapshot_id: number;
  scope_key_digest: string;
  scope_key_json: string;
  fingerprint_json: string;
  built_at: string;
  build_ms: number;
  row_count: number;
  diagnostics_json: string;
  scope_json: string | null;
  search_indexed?: number;
  search_message_count?: number | null;
  search_index_bytes?: number | null;
}

function toHeader(r: SnapshotRow): CatalogSnapshotHeader {
  return {
    snapshotId: Number(r.snapshot_id),
    scopeKeyDigest: r.scope_key_digest,
    scopeKey: JSON.parse(r.scope_key_json) as CatalogScopeKey,
    fingerprint: JSON.parse(r.fingerprint_json) as SourceFingerprint,
    builtAt: r.built_at,
    buildMs: Number(r.build_ms),
    rowCount: Number(r.row_count),
    diagnosticsJson: r.diagnostics_json,
    scopeJson: r.scope_json,
    ...(Number(r.search_indexed) === 1
      ? {
          searchIndexed: true,
          ...(r.search_message_count != null
            ? { searchMessageCount: Number(r.search_message_count) }
            : {}),
          ...(r.search_index_bytes != null
            ? { searchIndexBytes: Number(r.search_index_bytes) }
            : {}),
        }
      : {}),
  };
}

class SqliteCatalogStore implements CatalogStoreExtended {
  private closed = false;

  constructor(
    readonly path: string,
    private readonly db: Database
  ) {}

  getSnapshotHeader(scopeKeyDigest: string): CatalogSnapshotHeader | undefined {
    const row = this.db
      .prepare('SELECT * FROM snapshots WHERE scope_key_digest = ?')
      .get(scopeKeyDigest) as SnapshotRow | undefined;
    return row ? toHeader(row) : undefined;
  }

  listSnapshotHeaders(): CatalogSnapshotHeader[] {
    return (
      this.db.prepare('SELECT * FROM snapshots ORDER BY snapshot_id').all() as SnapshotRow[]
    ).map(toHeader);
  }

  readRows(snapshotId: number, offset: number, limit: number | 'all'): string[] {
    const lim = limit === 'all' ? -1 : Math.max(0, Math.floor(limit));
    const rows = this.db
      .prepare(
        'SELECT row_json FROM snapshot_rows WHERE snapshot_id = ? ORDER BY ordinal LIMIT ? OFFSET ?'
      )
      .all(snapshotId, lim, Math.max(0, Math.floor(offset))) as Array<{ row_json: string }>;
    return rows.map((r) => r.row_json);
  }

  publishSnapshot(
    header: Omit<CatalogSnapshotHeader, 'snapshotId'>,
    rowsJson: Iterable<string>
  ): number {
    const db = this.db;
    db.runSQL('BEGIN IMMEDIATE');
    try {
      // The unique(scope_key_digest) constraint requires the previous snapshot to be
      // removed before the header insert; both happen in this one transaction.
      const old = db
        .prepare('SELECT snapshot_id FROM snapshots WHERE scope_key_digest = ?')
        .get(header.scopeKeyDigest) as { snapshot_id: number } | undefined;
      if (old) {
        this.deleteSnapshot(Number(old.snapshot_id));
      }
      const result = db
        .prepare(
          `INSERT INTO snapshots (scope_key_digest, scope_key_json, fingerprint_json, built_at,
             build_ms, row_count, diagnostics_json, scope_json) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
        )
        .run(
          header.scopeKeyDigest,
          JSON.stringify(header.scopeKey),
          JSON.stringify(header.fingerprint),
          header.builtAt,
          Math.round(header.buildMs),
          header.diagnosticsJson,
          header.scopeJson
        );
      const id = Number(result.lastInsertRowid);
      const insert = db.prepare(
        'INSERT INTO snapshot_rows (snapshot_id, ordinal, row_json) VALUES (?, ?, ?)'
      );
      let count = 0;
      for (const row of rowsJson) {
        insert.run(id, count, row);
        count += 1;
      }
      db.prepare('UPDATE snapshots SET row_count = ? WHERE snapshot_id = ?').run(count, id);
      db.prepare(
        `INSERT INTO scope_state (scope_key_digest, verified_at, last_error_code, last_error_at)
         VALUES (?, ?, NULL, NULL)
         ON CONFLICT(scope_key_digest) DO UPDATE SET verified_at = excluded.verified_at,
           last_error_code = NULL, last_error_at = NULL`
      ).run(header.scopeKeyDigest, header.builtAt);
      db.runSQL('COMMIT');
      return id;
    } catch (error) {
      try {
        db.runSQL('ROLLBACK');
      } catch {
        // ignore
      }
      throw error;
    }
  }

  /** Remove a snapshot with its rows and search index. Caller owns the transaction. */
  private deleteSnapshot(id: number): void {
    const db = this.db;
    db.prepare('DELETE FROM snapshot_rows WHERE snapshot_id = ?').run(id);
    this.dropSearchIndex(id);
    db.prepare('DELETE FROM snapshots WHERE snapshot_id = ?').run(id);
  }

  private dropSearchIndex(id: number): void {
    const db = this.db;
    db.runSQL(`DROP TABLE IF EXISTS ${ftsTable(id)}`);
    db.prepare('DELETE FROM message_locator WHERE snapshot_id = ?').run(id);
    db.prepare('DELETE FROM search_sessions WHERE snapshot_id = ?').run(id);
  }

  beginSearchIndex(snapshotId: number): SearchIndexWriter {
    const db = this.db;
    const table = ftsTable(snapshotId);
    db.runSQL('BEGIN IMMEDIATE');
    try {
      const exists = db
        .prepare('SELECT 1 AS one FROM snapshots WHERE snapshot_id = ?')
        .get(snapshotId);
      if (!exists) throw new Error('snapshot not found');
      this.dropSearchIndex(snapshotId);
      db.runSQL(
        `CREATE VIRTUAL TABLE ${table} USING fts5(body, content='', columnsize=0, tokenize='trigram case_sensitive 0')`
      );
      db.runSQL('COMMIT');
    } catch (error) {
      try {
        db.runSQL('ROLLBACK');
      } catch {
        // ignore
      }
      throw error;
    }
    let ordinal = 0;
    let rowId = 0;
    // Each session is its own short transaction so the writer lock is never held across the
    // (asynchronous, long) hydration of the next session.
    return {
      addSession: (sessionId, messages) => {
        db.runSQL('BEGIN IMMEDIATE');
        try {
          db.prepare(
            'INSERT INTO search_sessions (snapshot_id, ordinal, session_id) VALUES (?, ?, ?)'
          ).run(snapshotId, ordinal, sessionId);
          const insertFts = db.prepare(`INSERT INTO ${table} (rowid, body) VALUES (?, ?)`);
          const insertLoc = db.prepare(
            'INSERT INTO message_locator (snapshot_id, row_id, session_ordinal, message_index) VALUES (?, ?, ?, ?)'
          );
          for (const message of messages) {
            if (message.text.length < 3) continue; // no trigram: can never match an eligible query
            rowId += 1;
            insertFts.run(rowId, message.text);
            insertLoc.run(snapshotId, rowId, ordinal, message.index);
          }
          db.runSQL('COMMIT');
        } catch (error) {
          try {
            db.runSQL('ROLLBACK');
          } catch {
            // ignore
          }
          throw error;
        }
        ordinal += 1;
      },
      finish: () => {
        let indexBytes: number | undefined;
        try {
          const r = db
            .prepare('SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name LIKE ?')
            .get(`${table}%`) as { bytes: number | null } | undefined;
          if (r?.bytes != null) indexBytes = Number(r.bytes);
        } catch {
          // dbstat unavailable in this driver build
        }
        db.prepare(
          'UPDATE snapshots SET search_indexed = 1, search_message_count = ?, search_index_bytes = ? WHERE snapshot_id = ?'
        ).run(rowId, indexBytes ?? null, snapshotId);
        return { messageCount: rowId, ...(indexBytes !== undefined ? { indexBytes } : {}) };
      },
      abort: () => {
        try {
          db.runSQL('BEGIN IMMEDIATE');
          this.dropSearchIndex(snapshotId);
          db.runSQL('COMMIT');
        } catch {
          try {
            db.runSQL('ROLLBACK');
          } catch {
            // ignore
          }
        }
      },
    };
  }

  searchCandidates(snapshotId: number, query: string): Map<string, number[]> {
    const table = ftsTable(snapshotId);
    const rows = this.db
      .prepare(
        `SELECT s.session_id AS session_id, l.message_index AS message_index
           FROM ${table} AS f
           JOIN message_locator AS l ON l.snapshot_id = ? AND l.row_id = f.rowid
           JOIN search_sessions AS s ON s.snapshot_id = l.snapshot_id AND s.ordinal = l.session_ordinal
          WHERE ${table} MATCH ?
          ORDER BY s.ordinal, l.message_index`
      )
      .all(snapshotId, toFtsPhrase(query)) as Array<{ session_id: string; message_index: number }>;
    const out = new Map<string, number[]>();
    for (const row of rows) {
      const list = out.get(row.session_id);
      if (list) list.push(Number(row.message_index));
      else out.set(row.session_id, [Number(row.message_index)]);
    }
    return out;
  }

  touchVerified(snapshotId: number, verifiedAt: string): void {
    const row = this.db
      .prepare('SELECT scope_key_digest FROM snapshots WHERE snapshot_id = ?')
      .get(snapshotId) as { scope_key_digest: string } | undefined;
    if (!row) return;
    this.db
      .prepare(
        `INSERT INTO scope_state (scope_key_digest, verified_at) VALUES (?, ?)
         ON CONFLICT(scope_key_digest) DO UPDATE SET verified_at = excluded.verified_at`
      )
      .run(row.scope_key_digest, verifiedAt);
  }

  getScopeState(scopeKeyDigest: string): CatalogScopeState | undefined {
    const r = this.db
      .prepare('SELECT * FROM scope_state WHERE scope_key_digest = ?')
      .get(scopeKeyDigest) as
      | { verified_at: string | null; last_error_code: string | null; last_error_at: string | null }
      | undefined;
    if (!r) return undefined;
    const state: CatalogScopeState = {};
    if (r.verified_at) state.verifiedAt = r.verified_at;
    if (r.last_error_code && r.last_error_at) {
      state.lastError = { code: r.last_error_code, at: r.last_error_at };
    }
    return state;
  }

  recordScopeError(scopeKeyDigest: string, code: string, at: string): void {
    this.db
      .prepare(
        `INSERT INTO scope_state (scope_key_digest, last_error_code, last_error_at) VALUES (?, ?, ?)
         ON CONFLICT(scope_key_digest) DO UPDATE SET last_error_code = excluded.last_error_code,
           last_error_at = excluded.last_error_at`
      )
      .run(scopeKeyDigest, code, at);
  }

  prune(options: { maxSnapshots: number; maxAgeDays: number }): void {
    const db = this.db;
    const cutoff = new Date(Date.now() - options.maxAgeDays * 86_400_000).toISOString();
    db.runSQL('BEGIN IMMEDIATE');
    try {
      const doomed = new Set<number>();
      const old = db
        .prepare('SELECT snapshot_id FROM snapshots WHERE built_at < ?')
        .all(cutoff) as Array<{ snapshot_id: number }>;
      for (const r of old) doomed.add(Number(r.snapshot_id));
      const over = db
        .prepare(
          'SELECT snapshot_id FROM snapshots ORDER BY built_at DESC, snapshot_id DESC LIMIT -1 OFFSET ?'
        )
        .all(Math.max(0, options.maxSnapshots)) as Array<{ snapshot_id: number }>;
      for (const r of over) doomed.add(Number(r.snapshot_id));
      for (const id of doomed) this.deleteSnapshot(id);
      db.runSQL(
        'DELETE FROM scope_state WHERE scope_key_digest NOT IN (SELECT scope_key_digest FROM snapshots)' +
          ' AND last_error_code IS NULL'
      );
      db.runSQL('COMMIT');
    } catch (error) {
      try {
        db.runSQL('ROLLBACK');
      } catch {
        // ignore
      }
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
