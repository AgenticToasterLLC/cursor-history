/**
 * Sidecar catalog contract (Wave 2). Authored by the coordinator; implementers
 * C1 (store/lock/fingerprint), C2 (builder/worker/refresh), C3 (library read
 * path) and C4 (tests) code against these types. Changes require coordinator
 * approval.
 *
 * Design: a disposable, versioned snapshot cache of the exact logical
 * session-summary catalog produced by the direct reader for one read scope.
 * A snapshot is reused only when the fingerprint of every source file it was
 * built from is unchanged (then it is provably identical to a direct read);
 * otherwise it is "stale", disclosed as such, and rebuilt in the background.
 * Cursor databases are never written. The sidecar is never authoritative.
 */

/** Sidecar schema version; bump on any incompatible table change (forces rebuild). */
export const CATALOG_SCHEMA_VERSION = 2 as const;

/**
 * Compatibility epoch of the summary projection. Bump whenever direct-path
 * summary output could change for the same sources (reader logic change), so
 * snapshots built by an older reader are never served.
 */
export const CATALOG_PROJECTION_EPOCH = 1 as const;

/** Public catalog state reported with every catalog-backed result. */
export type CatalogState =
  | 'ready' // fresh snapshot: fingerprint verified unchanged; result is identical to a direct read
  | 'stale' // snapshot exists but sources changed since it was built; result is the older snapshot
  | 'building' // no usable snapshot yet; a build is in progress
  | 'degraded' // sidecar unusable (corrupt/locked/unwritable); result came from the direct path
  | 'unavailable'; // catalog disabled or not applicable (e.g. backup sources); direct path used

/** Library option: how a read may use the catalog. */
export type CatalogMode =
  | 'direct' // never use the catalog (library default; unchanged behavior)
  | 'auto' // serve ready or stale snapshots immediately; refresh stale/missing in the background;
  //          with no snapshot, fall back to a direct read (catalogState 'building' + complete direct result)
  | 'strict'; // serve only a ready snapshot; otherwise build synchronously (or direct read) before returning

/** Catalog disclosure attached (additively) to catalog-aware results. */
export interface CatalogInfo {
  state: CatalogState;
  /** True only when the returned rows are known to reflect the sources at verification time. */
  complete: boolean;
  /** ISO time the served snapshot was built (absent for direct reads). */
  snapshotBuiltAt?: string;
  /** ISO time the fingerprint was last verified against the sources. */
  verifiedAt?: string;
  /** When stale: count of fingerprinted source files that changed/appeared/disappeared. */
  changedSources?: number;
  /** True when a background refresh was scheduled or is running for this scope. */
  refreshScheduled?: boolean;
  /** Content-free reason code for degraded/unavailable states (never a message or path). */
  reason?: string;
}

/** Stable identity of one read scope; snapshots are keyed by its canonical JSON sha256. */
export interface CatalogScopeKey {
  /** Resolved Composer workspaceStorage root (normalized) or null when Store-only. */
  dataPath: string | null;
  /** Resolved Store root (normalized) or null. */
  storeRoot: string | null;
  /** Normalized workspace request as given (not the resolved match), or null for unscoped. */
  workspace: string | null;
  includeCrossWorkspaceSources: boolean;
  /** Effective Source Read Limits v1 (resolved, all fields) — limits change results, so they key the snapshot. */
  sourceReadLimits: Record<string, number>;
  schemaVersion: typeof CATALOG_SCHEMA_VERSION;
  projectionEpoch: typeof CATALOG_PROJECTION_EPOCH;
  /** cursor-history package version that built it. */
  readerVersion: string;
  /**
   * Present (true) only when the snapshot must also carry the opt-in search index. It keys the
   * snapshot, so an indexed and a non-indexed build of the same scope never replace each other.
   * Omitted (not false) otherwise so digests of non-indexed scopes are unchanged.
   */
  searchIndex?: true;
}

/** One fingerprinted source file. Missing files are recorded with exists=false. */
export interface SourceFileFingerprint {
  /** Absolute normalized path. */
  path: string;
  exists: boolean;
  size?: number;
  /** mtime in nanoseconds as a decimal string (fs.stat bigint) to avoid precision loss. */
  mtimeNs?: string;
}

/**
 * Fingerprint of everything a scope's direct read can depend on: for every
 * SQLite source both the db file and its -wal (and -shm presence is ignored);
 * every workspace.json; Store meta.json/store.db/transcript files; and the
 * directory listings (names) of workspaceStorage and Store roots so that added
 * or removed workspaces/sessions are detected.
 * Computing it must not open any database and must not read file contents
 * other than directory listings.
 */
export interface SourceFingerprint {
  files: SourceFileFingerprint[];
  /** sha256 over sorted directory listings of the enumerated roots. */
  listingsDigest: string;
  /** sha256 over the canonical serialization of files + listingsDigest. */
  digest: string;
}

/** Stored snapshot header. */
export interface CatalogSnapshotHeader {
  snapshotId: number;
  scopeKeyDigest: string;
  scopeKey: CatalogScopeKey;
  fingerprint: SourceFingerprint;
  builtAt: string;
  buildMs: number;
  rowCount: number;
  /** Diagnostics (content-free) the direct path returned with the full catalog. */
  diagnosticsJson: string;
  /** Scope outcome the direct path returned (WorkspaceScopeResolution JSON) or null. */
  scopeJson: string | null;
  /**
   * Search index (schema v2, opt-in). True only after the index pass finished for THIS snapshot
   * (header written by the store when the index writer completes). Absent/false means
   * "summary-only"; verified search then falls back to the direct scan.
   *
   * Sensitivity: the index is a contentless FTS5 trigram table. No message body is stored, but
   * trigram postings still let someone with the sidecar infer substrings of the indexed text
   * (which is the lowercased message `content` the matcher sees). It is therefore opt-in.
   */
  searchIndexed?: boolean;
  /** Number of message rows in the search index (content-free count). */
  searchMessageCount?: number;
  /** Approximate on-disk bytes of the search index (FTS5 shadow tables); absent if the driver cannot report it. */
  searchIndexBytes?: number;
}

/**
 * C1: the sidecar store. One SQLite file (WAL mode) under the cache dir:
 * CURSOR_HISTORY_INDEX_PATH, else <platform cache dir>/cursor-history/catalog-v<schema>.sqlite
 * (Windows: %LOCALAPPDATA%\cursor-history\..., macOS: ~/Library/Caches/..., Linux: $XDG_CACHE_HOME or ~/.cache).
 * File created owner-only. Corrupt/incompatible file: rename aside and recreate.
 */
export interface CatalogStore {
  readonly path: string;
  /** Latest complete snapshot for a scope, or undefined. */
  getSnapshotHeader(scopeKeyDigest: string): CatalogSnapshotHeader | undefined;
  /**
   * Read summary rows of a snapshot in stored (direct-path) order, as the exact
   * JSON the direct path produced. offset/limit apply to stored order.
   */
  readRows(snapshotId: number, offset: number, limit: number | 'all'): string[];
  /** Atomically publish a complete snapshot (rows in order); replaces the scope's previous one in one transaction. */
  publishSnapshot(
    header: Omit<CatalogSnapshotHeader, 'snapshotId'>,
    rowsJson: Iterable<string>
  ): number;
  /** Record a successful verification time without rebuilding. */
  touchVerified(snapshotId: number, verifiedAt: string): void;
  /** Delete snapshots not used for N days / beyond a count cap. */
  prune(options: { maxSnapshots: number; maxAgeDays: number }): void;
  close(): void;
}

/**
 * C1: cross-process single-writer lock for building one scope (and a global
 * store-maintenance lock). Lockfile next to the store with pid + start time;
 * stale locks (dead pid or older than ttl) are recovered.
 */
export interface CatalogLock {
  tryAcquire(scopeKeyDigest: string, ttlMs: number): { release(): void } | undefined;
}

/** C2: build job protocol between the library and the builder worker_thread. */
export type IndexerRequest = {
  type: 'build';
  jobId: string;
  scopeKey: CatalogScopeKey;
  /** Serializable direct-read config used to reproduce the scope exactly. */
  readConfig: Record<string, unknown>;
  storePath: string;
};
export type IndexerResponse =
  | { type: 'progress'; jobId: string; phase: string }
  | { type: 'done'; jobId: string; snapshotId: number; rowCount: number; buildMs: number }
  | { type: 'failed'; jobId: string; code: string; message: string }; // message content-free

/** C3: public status for MCP/CLI (content-free). */
export interface CatalogStatus {
  enabled: boolean;
  path?: string;
  sizeBytes?: number;
  schemaVersion: number;
  projectionEpoch: number;
  scopes: Array<{
    scopeKeyDigest: string;
    workspace: string | null;
    state: CatalogState;
    rowCount?: number;
    snapshotBuiltAt?: string;
    verifiedAt?: string;
    buildMs?: number;
    building: boolean;
    lastError?: { code: string; at: string };
  }>;
}

// ============================================================================
// Module APIs (signatures each workstream must export exactly)
// ============================================================================

/** Inputs that determine which files a scope's fingerprint covers. */
export interface FingerprintInputs {
  /** Composer workspaceStorage root, or null. */
  dataPath: string | null;
  /** Composer global state.vscdb path (sibling globalStorage), or null. */
  globalDbPath: string | null;
  /** Store root (~/.cursor or CURSOR_STORE_ROOT), or null. */
  storeRoot: string | null;
}

/** C1 `src/core/catalog/paths.ts` */
export type DefaultCatalogPath = (env?: NodeJS.ProcessEnv) => string;
/** C1 `src/core/catalog/store.ts`. Throws CatalogUnavailableError (code CATALOG_UNAVAILABLE) when unusable. */
export type OpenCatalogStore = (options?: { path?: string }) => CatalogStore;
/** C1 `src/core/catalog/lock.ts` */
export type CreateCatalogLock = (storePath: string) => CatalogLock;
/** C1 `src/core/catalog/fingerprint.ts`: stat-only, never opens a database. */
export type ComputeSourceFingerprint = (inputs: FingerprintInputs) => Promise<SourceFingerprint>;
/** C1 `src/core/catalog/fingerprint.ts`: number of files that changed, appeared or disappeared (listing change counts as 1). */
export type CountFingerprintChanges = (
  before: SourceFingerprint,
  after: SourceFingerprint
) => number;
/** C1 `src/core/catalog/scope-key.ts`: sha256 hex of the canonical (sorted-key) JSON of the scope key. */
export type DigestScopeKey = (key: CatalogScopeKey) => string;

/**
 * C2 `src/core/catalog/builder.ts`: build one snapshot in the current thread
 * (used by the worker and by strict mode). Computes the fingerprint BEFORE the
 * direct read (so a concurrent source change makes the snapshot stale, never
 * falsely fresh), runs the direct read with catalog:'direct', publishes atomically.
 */
export type BuildCatalogSnapshot = (
  request: IndexerRequest,
  options?: { signal?: AbortSignal }
) => Promise<IndexerResponse>;

/**
 * C2 `src/core/catalog/refresh.ts`: fire-and-forget background build in a
 * worker_thread. Single-flight per scope per process; cross-process via
 * CatalogLock (if another process holds the lock, returns alreadyRunning).
 * The worker is unref'd so it never keeps the process alive, and is
 * terminated by cancelCatalogRefreshes().
 */
export type RequestCatalogRefresh = (request: Omit<IndexerRequest, 'type' | 'jobId'>) => {
  jobId: string;
  alreadyRunning: boolean;
};
/** C2: resolves when the scope's running build finishes, or undefined on timeout/none running. */
export type WaitForCatalogBuild = (
  scopeKeyDigest: string,
  timeoutMs: number
) => Promise<IndexerResponse | undefined>;
/** C2: terminate all running build workers (process shutdown / tests). */
export type CancelCatalogRefreshes = () => Promise<void>;
