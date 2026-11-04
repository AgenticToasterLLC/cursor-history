import type { Database } from './database/index.js';
import {
  SOURCE_READ_LIMITS_V1_DEFAULTS,
  SqliteSourceReadBudget,
  decodeDeterministicUtf8,
  type SourceFailureOutcome,
} from './source-read-limits.js';
import type { SourceReadLimitsV1 } from './types.js';

/** Composer key/value tables whose identifiers are safe to interpolate into SQL. */
export type ComposerKeyValueTable = 'ItemTable' | 'cursorDiskKV';

export interface ComposerSqliteMetadata {
  readonly rowId: number | bigint;
  readonly key: string;
  readonly byteLength: number;
}

export interface ComposerSqliteValue extends ComposerSqliteMetadata {
  readonly value: string;
}

/**
 * One global Composer bubble row. Unlike ordinary Composer key/value reads,
 * historical bubble streams treat a stored SQL NULL as a visible corrupted
 * message, so the null state is part of the admitted payload identity.
 */
export interface ComposerSqliteBubbleMetadata extends ComposerSqliteMetadata {
  readonly valueIsNull: boolean;
}

export interface ComposerSqliteBubbleValue extends ComposerSqliteBubbleMetadata {
  readonly value: string | null;
}

/**
 * Derive a half-open key range `[lower, upper)` covering every key matched by a
 * trailing-`%` LIKE prefix pattern, or null when the pattern is not a simple
 * literal prefix that a range scan can express.
 */
function prefixUpperBound(body: string): string | null {
  for (let index = body.length - 1; index >= 0; index--) {
    const code = body.charCodeAt(index);
    if (code < 0xffff) {
      return body.slice(0, index) + String.fromCharCode(code + 1);
    }
  }
  return null;
}

function likePrefixRange(pattern: string): { lower: string; upper: string } | null {
  if (!pattern.endsWith('%')) return null;
  const body = pattern.slice(0, -1);
  if (/[%_\\]/u.test(body)) return null;
  const upper = prefixUpperBound(body);
  return upper === null ? null : { lower: body, upper };
}

/** Escape caller-controlled text for a SQLite LIKE prefix using `\` as ESCAPE. */
export function sqliteLikeLiteralPrefix(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

/**
 * Escape caller-controlled text for a SQLite GLOB prefix pattern.
 *
 * GLOB is case-sensitive, so prefix reads stay byte-exact without depending on
 * a connection-scoped PRAGMA. Its `*`, `?`, and `[` metacharacters are
 * bracketed so a native ID that contains them still matches literally.
 */
export function sqliteGlobLiteralPrefix(value: string): string {
  return value.replaceAll('[', '[[]').replaceAll('*', '[*]').replaceAll('?', '[?]');
}

/**
 * Byte-exact prefix predicate that can use the `key` index.
 *
 * SQLite's `LIKE` folds ASCII case, and the `substr(key, 1, length(?)) = ?`
 * form previously used to avoid that folding is not indexable: every prefix
 * read scanned the entire global database (~5.5s per read on a 7.3GB table).
 * GLOB is case-sensitive by default and, with a literal prefix, plans as a
 * covering index range search instead of a full table scan.
 */
function exactPrefixPredicate(
  qualifiedKey: string,
  prefix: string
): { sql: string; params: string[] } {
  // SQLite GLOB stops at NUL; native identifiers must remain byte-exact even
  // for future/noncanonical text. Preserve the released predicate in that case.
  if (prefix.includes('\0')) {
    return {
      sql: `${qualifiedKey} IS NOT NULL AND substr(CAST(${qualifiedKey} AS BLOB), 1, length(CAST(? AS BLOB))) = CAST(? AS BLOB)`,
      params: [prefix, prefix],
    };
  }
  return {
    sql: `${qualifiedKey} IS NOT NULL AND ${qualifiedKey} GLOB ?`,
    params: [`${sqliteGlobLiteralPrefix(prefix)}*`],
  };
}

interface InternalComposerSqliteMetadata extends ComposerSqliteMetadata {
  /** Compatibility for historical in-repo database test doubles only. */
  readonly inlineValue?: unknown;
}

interface InternalComposerSqliteBubbleMetadata extends ComposerSqliteBubbleMetadata {
  /** Compatibility for historical in-repo database test doubles only. */
  readonly inlineValue?: unknown;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error && signal.reason.name === 'AbortError') return signal.reason;
  const error = new Error('The Composer SQLite read was aborted.', {
    ...(signal.reason === undefined ? {} : { cause: signal.reason }),
  });
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function payloadBytes(value: unknown): Uint8Array {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('SQLite returned an unsupported Composer payload value');
}

function declaredLength(value: unknown): number {
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new TypeError('SQLite returned an invalid declared Composer payload length');
  }
  return length;
}

function normalizedRowId(value: unknown, fallback: number): number | bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) return value;
    throw new TypeError('SQLite returned an unsafe numeric Composer row ID');
  }
  if (typeof value === 'string' && /^-?\d+$/u.test(value)) {
    const parsed = BigInt(value);
    return parsed >= BigInt(Number.MIN_SAFE_INTEGER) && parsed <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(parsed)
      : parsed;
  }
  if (value === undefined) return fallback;
  throw new TypeError('SQLite returned an invalid Composer row ID');
}

function normalizeMetadata(
  row: Record<string, unknown>,
  fallbackKey?: string,
  fallbackRowId = 0
): InternalComposerSqliteMetadata {
  const key = typeof row['key'] === 'string' ? row['key'] : fallbackKey;
  if (!key) throw new TypeError('SQLite returned Composer metadata without a key');

  const hasInlineValue = Object.prototype.hasOwnProperty.call(row, 'value');
  const inlineValue = hasInlineValue ? row['value'] : undefined;
  const byteLength =
    row['byteLength'] === undefined
      ? hasInlineValue
        ? payloadBytes(inlineValue).byteLength
        : 0
      : declaredLength(row['byteLength']);
  const rowId = normalizedRowId(row['rowId'], fallbackRowId);

  return {
    rowId,
    key,
    byteLength,
    ...(hasInlineValue ? { inlineValue } : {}),
  };
}

function sqliteBoolean(value: unknown): boolean | undefined {
  if (value === true || value === 1 || value === 1n || value === '1') return true;
  if (value === false || value === 0 || value === 0n || value === '0') return false;
  return undefined;
}

function normalizeBubbleMetadata(
  row: Record<string, unknown>,
  fallbackKey?: string,
  fallbackRowId = 0
): InternalComposerSqliteBubbleMetadata {
  const key = typeof row['key'] === 'string' ? row['key'] : fallbackKey;
  if (!key) throw new TypeError('SQLite returned Composer bubble metadata without a key');

  const hasInlineValue = Object.prototype.hasOwnProperty.call(row, 'value');
  const inlineValue = hasInlineValue ? row['value'] : undefined;
  const projectedNullState = sqliteBoolean(row['valueIsNull']);
  const valueIsNull = projectedNullState ?? (hasInlineValue && inlineValue === null);
  if (projectedNullState === undefined && !hasInlineValue) {
    throw new TypeError('SQLite returned Composer bubble metadata without a null-state projection');
  }
  if (hasInlineValue && (inlineValue === null) !== valueIsNull) {
    throw new TypeError('SQLite returned inconsistent Composer bubble null-state metadata');
  }

  const byteLength =
    row['byteLength'] === undefined
      ? valueIsNull
        ? 0
        : payloadBytes(inlineValue).byteLength
      : declaredLength(row['byteLength']);
  if (valueIsNull && byteLength !== 0) {
    throw new TypeError('SQLite returned a nonzero length for a NULL Composer bubble payload');
  }

  return {
    rowId: normalizedRowId(row['rowId'], fallbackRowId),
    key,
    byteLength,
    valueIsNull,
    ...(hasInlineValue ? { inlineValue } : {}),
  };
}

/** Construct a fresh reset-boundary budget for one catalog scan or logical-session hydration. */
export function createComposerSqliteBudget(
  limits: Readonly<SourceReadLimitsV1> = SOURCE_READ_LIMITS_V1_DEFAULTS,
  outcome: SourceFailureOutcome = 'fatal'
): SqliteSourceReadBudget {
  return new SqliteSourceReadBudget(limits, outcome);
}

/**
 * Byte-length projection for admission. `octet_length(value)` is read from the
 * record header and never loads overflow pages, unlike `length(CAST(value AS
 * BLOB))`, which materializes the payload. The two are exactly equal for every
 * storage class (TEXT, BLOB, NULL, INTEGER, REAL) and for UTF-8/UTF-16 databases
 * (see tests/unit/composer-sqlite-rewrites.test.ts), so the choice is a pure
 * feature detection recorded by the driver when the connection was opened.
 */
function byteLengthSql(db: Database): string {
  return db.composerReadCapabilities?.octetLength === true
    ? 'octet_length(value)'
    : 'length(CAST(value AS BLOB))';
}

/** Largest row set the key-range gather may hold in memory before falling back to paged reads. */
const GATHER_MAX_ROWS = 1_000_000;
/** Rows fetched per key-ordered gather query (independent of the admission page size). */
const GATHER_PAGE_ROWS = 1024;
/** Values prefetched per batched read: row-count and declared-byte bounds. */
const VALUE_BATCH_ROWS = 64;
const VALUE_BATCH_BYTES = 4 * 1024 * 1024;

function compareRowIds(left: number | bigint, right: number | bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The released rowid-keyset statement, kept as the fallback and as the semantic oracle. */
function legacyRowIdPageSql(table: string, columns: string, where: string): string {
  return `SELECT CAST(${table}.rowid AS TEXT) AS rowId, key, ${columns} FROM ${table} WHERE ${where} AND (? IS NULL OR ${table}.rowid > ?) ORDER BY ${table}.rowid ASC LIMIT ?`;
}

interface RowIdOrderedSpec<T extends ComposerSqliteMetadata> {
  readonly table: string;
  /** Projection after `rowId, key`. */
  readonly columns: string;
  /** Predicate (and its parameters) selecting the rows; identical for both strategies. */
  readonly where: string;
  readonly params: readonly unknown[];
  /** Key range covering every match, when the pattern is a safe literal prefix. */
  readonly range: { lower: string; upper: string } | null;
  /** Whether the optimized strategy is allowed for this predicate on this connection. */
  readonly optimizable: boolean;
  readonly normalize: (
    row: Record<string, unknown>,
    fallbackKey?: string,
    fallbackRowId?: number
  ) => T;
}

/**
 * Collect every row of a key range through a key keyset (an index range stream),
 * so SQLite never builds a TEMP B-TREE for `ORDER BY rowid`, then order by rowid
 * in JS. Returns undefined (before any budget is charged) when the range is
 * larger than the gather bound, in which case the caller uses the released
 * paged statement.
 */
function gatherRowIdOrdered<T extends ComposerSqliteMetadata>(
  db: Database,
  spec: RowIdOrderedSpec<T>,
  budget: SqliteSourceReadBudget,
  signal?: AbortSignal
): T[] | undefined {
  const range = spec.range!;
  const remaining = budget.limits.sqliteRowCount - budget.rowCount;
  const cap = Math.min(GATHER_MAX_ROWS, remaining + 1);
  const select = `SELECT CAST(${spec.table}.rowid AS TEXT) AS rowId, key, ${spec.columns} FROM ${spec.table} WHERE key `;
  const tail = ` ? COLLATE BINARY AND key < ? COLLATE BINARY AND ${spec.where} ORDER BY key COLLATE BINARY ASC LIMIT ?`;
  const first = db.prepare(`${select}>=${tail}`);
  const later = db.prepare(`${select}>${tail}`);
  const rows: T[] = [];
  let afterKey: string | undefined;
  while (true) {
    throwIfAborted(signal);
    const raw = (afterKey === undefined ? first : later).all(
      afterKey ?? range.lower,
      range.upper,
      ...spec.params,
      GATHER_PAGE_ROWS
    ) as Array<Record<string, unknown>>;
    for (const row of raw) {
      rows.push(spec.normalize(row));
      if (rows.length > cap) return undefined;
    }
    if (raw.length < GATHER_PAGE_ROWS) break;
    const lastKey = raw[raw.length - 1]!['key'];
    if (typeof lastKey !== 'string') {
      throw new TypeError('SQLite returned Composer metadata without a key');
    }
    afterKey = lastKey;
  }
  rows.sort((left, right) => compareRowIds(left.rowId, right.rowId));
  return rows;
}

/**
 * Admitted metadata pages in rowid order. A page is yielded only after the
 * budget admitted it, exactly as the released loops did.
 */
function* rowIdOrderedPages<T extends ComposerSqliteMetadata>(
  db: Database,
  spec: RowIdOrderedSpec<T>,
  budget: SqliteSourceReadBudget,
  signal?: AbortSignal
): Generator<T[]> {
  const pageRows = budget.limits.sqlitePageRows;
  if (spec.optimizable && spec.range) {
    const gathered = gatherRowIdOrdered(db, spec, budget, signal);
    if (gathered) {
      for (let start = 0; start < gathered.length; start += pageRows) {
        throwIfAborted(signal);
        const page = gathered.slice(start, start + pageRows);
        budget.admitMetadataPage(page.map(({ byteLength }) => byteLength));
        yield page;
      }
      return;
    }
  }

  const statement = db.prepare(legacyRowIdPageSql(spec.table, spec.columns, spec.where));
  let afterRowId: number | bigint | null = null;
  while (true) {
    throwIfAborted(signal);
    const rawPage = statement.all(...spec.params, afterRowId, afterRowId, pageRows) as Array<
      Record<string, unknown>
    >;
    if (rawPage.length === 0) break;

    const fallbackBase: number =
      typeof afterRowId === 'number' && Number.isSafeInteger(afterRowId) ? afterRowId : -1;
    const page = rawPage.map((row, index) =>
      spec.normalize(row, undefined, fallbackBase + index + 1)
    );
    budget.admitMetadataPage(page.map(({ byteLength }) => byteLength));
    yield page;

    // Historical in-repo test adapters return the complete old payload page
    // without row IDs. Production SQLite always supplies rowId for this query.
    const legacyInlinePage = rawPage.some(
      (row) => row['rowId'] === undefined && row['byteLength'] === undefined
    );
    if (legacyInlinePage || rawPage.length < pageRows) break;
    afterRowId = page[page.length - 1]!.rowId;
  }
}

/**
 * The key range for an exact byte prefix, or null when the prefix needs the
 * released predicate: NUL (GLOB stops at NUL), an empty prefix, or anything
 * whose UTF-8 binding is not a plain monotonic code-point range.
 */
function exactPrefixKeyRange(prefix: string): { lower: string; upper: string } | null {
  if (prefix.length === 0 || prefix.includes('\0')) return null;
  const upper = prefixUpperBound(prefix);
  if (upper === null) return null;
  const range = { lower: prefix, upper };
  return safeKeyRange(range) ? range : null;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function hasLoneSurrogate(value: string): boolean {
  return LONE_SURROGATE.test(value);
}

/** Ranges with lone surrogates would be re-encoded by the binding and stop being supersets. */
function safeKeyRange(range: { lower: string; upper: string }): boolean {
  return (
    !hasLoneSurrogate(range.lower) && !hasLoneSurrogate(range.upper) && !range.lower.includes('\0')
  );
}

function composerMetadataSpec(
  db: Database,
  table: ComposerKeyValueTable,
  keyPattern: string
): RowIdOrderedSpec<InternalComposerSqliteMetadata> {
  const range = likePrefixRange(keyPattern);
  return {
    table,
    columns: `${byteLengthSql(db)} AS byteLength`,
    where: `key LIKE ? ESCAPE '\\' AND value IS NOT NULL`,
    params: [keyPattern],
    range: range && safeKeyRange(range) ? range : null,
    optimizable: db.composerReadCapabilities?.byteExactLike === true,
    normalize: normalizeMetadata,
  };
}

function bubbleColumns(db: Database): string {
  return `COALESCE(${byteLengthSql(db)}, 0) AS byteLength, value IS NULL AS valueIsNull`;
}

function bubbleLikeSpec(
  db: Database,
  keyPattern: string
): RowIdOrderedSpec<InternalComposerSqliteBubbleMetadata> {
  const range = likePrefixRange(keyPattern);
  return {
    table: 'cursorDiskKV',
    columns: bubbleColumns(db),
    where: `key LIKE ? ESCAPE '\\'`,
    params: [keyPattern],
    range: range && safeKeyRange(range) ? range : null,
    optimizable: db.composerReadCapabilities?.byteExactLike === true,
    normalize: normalizeBubbleMetadata,
  };
}

function bubbleExactPrefixSpec(
  db: Database,
  keyPrefix: string
): RowIdOrderedSpec<InternalComposerSqliteBubbleMetadata> {
  const predicate = exactPrefixPredicate('cursorDiskKV.key', keyPrefix);
  return {
    table: 'cursorDiskKV',
    columns: bubbleColumns(db),
    where: predicate.sql,
    params: predicate.params,
    range: exactPrefixKeyRange(keyPrefix),
    optimizable: db.composerReadCapabilities !== undefined,
    normalize: normalizeBubbleMetadata,
  };
}

/** Admit the metadata for one exact key without crossing the payload boundary. */
export function getBoundedComposerMetadataByKey(
  db: Database,
  table: ComposerKeyValueTable,
  key: string,
  budget: SqliteSourceReadBudget,
  signal?: AbortSignal
): ComposerSqliteMetadata | undefined {
  throwIfAborted(signal);
  const raw = db
    .prepare(
      `SELECT CAST(rowid AS TEXT) AS rowId, key, ${byteLengthSql(db)} AS byteLength FROM ${table} WHERE key = ? COLLATE BINARY AND value IS NOT NULL`
    )
    .get(key) as Record<string, unknown> | undefined;
  if (!raw) return undefined;
  const metadata = normalizeMetadata(raw, key);
  budget.admitMetadataPage([metadata.byteLength]);
  return metadata;
}

/**
 * One key from a catalog scan that never materializes payloads.
 *
 * Session discovery, bubble counting, and native ID-spelling collection consume
 * only keys. Selecting just `key` keeps these scans on the covering key index;
 * referencing `value` in the projection instead forces SQLite to read every
 * matched payload out of its overflow pages, which made catalog scans
 * proportional to total payload bytes rather than to key count.
 */
export interface ComposerSqliteKey {
  readonly key: string;
}

/** Iterate finite row-ID-keyset metadata pages using the operation's page bound. */
export function forEachBoundedComposerMetadata(
  db: Database,
  table: ComposerKeyValueTable,
  keyPattern: string,
  budget: SqliteSourceReadBudget,
  visit: (metadata: ComposerSqliteMetadata) => void,
  signal?: AbortSignal
): void {
  const spec = composerMetadataSpec(db, table, keyPattern);
  for (const page of rowIdOrderedPages(db, spec, budget, signal)) {
    for (const metadata of page) {
      throwIfAborted(signal);
      visit(metadata);
    }
  }
}

/**
 * Iterate keys under a `LIKE` prefix without projecting or ordering by payload.
 *
 * Callers use this only to aggregate keys, so pages are keyset-advanced on the
 * key itself. That matches the covering key index's native order and lets
 * SQLite stream the range without the temporary B-tree sort that an
 * `ORDER BY rowid` page requires. Physical row order is deliberately not
 * promised, and NULL-valued rows are included because they still carry a key.
 */
export function forEachBoundedComposerKeyMetadata(
  db: Database,
  table: ComposerKeyValueTable,
  keyPattern: string,
  budget: SqliteSourceReadBudget,
  visit: (metadata: ComposerSqliteKey) => void,
  signal?: AbortSignal
): void {
  const pageRows = budget.limits.sqlitePageRows;
  const range = likePrefixRange(keyPattern);
  // A half-open range with exactly one lower-bound parameter lets SQLite bind
  // the keyset cursor into the index range. Expressing the same bounds as
  // `key LIKE ? AND key > ?` hides the cursor from the planner, which then
  // rescans the entire range for every page and makes the scan quadratic:
  // measured ~14s versus ~0.4s for 153k keys.
  const firstPage = db.prepare(
    range
      ? `SELECT key FROM ${table} WHERE key >= ? AND key < ? ORDER BY key ASC LIMIT ?`
      : `SELECT key FROM ${table} WHERE key LIKE ? ESCAPE '\\' ORDER BY key ASC LIMIT ?`
  );
  const laterPage = db.prepare(
    range
      ? `SELECT key FROM ${table} WHERE key > ? AND key < ? ORDER BY key ASC LIMIT ?`
      : `SELECT key FROM ${table} WHERE key LIKE ? ESCAPE '\\' AND key > ? ORDER BY key ASC LIMIT ?`
  );
  let afterKey: string | null = null;
  while (true) {
    throwIfAborted(signal);
    const params: unknown[] = range
      ? afterKey === null
        ? [range.lower, range.upper, pageRows]
        : [afterKey, range.upper, pageRows]
      : afterKey === null
        ? [keyPattern, pageRows]
        : [keyPattern, afterKey, pageRows];
    const rawPage = (afterKey === null ? firstPage : laterPage).all(...params) as Array<
      Record<string, unknown>
    >;
    if (rawPage.length === 0) break;

    const page: ComposerSqliteKey[] = rawPage.map((row) => {
      const key = typeof row['key'] === 'string' ? row['key'] : undefined;
      if (!key) throw new TypeError('SQLite returned Composer metadata without a key');
      return { key };
    });
    budget.admitMetadataPage(page.map(() => 0));
    for (const metadata of page) {
      throwIfAborted(signal);
      visit(metadata);
    }

    if (rawPage.length < pageRows) break;
    afterKey = page[page.length - 1]!.key;
  }
}

/**
 * Iterate global bubble metadata including stored SQL NULL rows. NULL rows are
 * charged as one SQLite row and zero declared payload bytes. This API is kept
 * bubble-specific so ordinary Composer metadata continues to exclude NULL.
 */
export function forEachBoundedComposerBubbleMetadata(
  db: Database,
  keyPattern: string,
  budget: SqliteSourceReadBudget,
  visit: (metadata: ComposerSqliteBubbleMetadata) => void,
  signal?: AbortSignal
): void {
  for (const page of rowIdOrderedPages(db, bubbleLikeSpec(db, keyPattern), budget, signal)) {
    for (const metadata of page) {
      throwIfAborted(signal);
      visit(metadata);
    }
  }
}

/** Iterate nullable global bubbles for one exact, case-sensitive byte prefix. */
export function forEachBoundedComposerBubbleMetadataByExactPrefix(
  db: Database,
  keyPrefix: string,
  budget: SqliteSourceReadBudget,
  visit: (metadata: ComposerSqliteBubbleMetadata) => void,
  signal?: AbortSignal
): void {
  for (const page of rowIdOrderedPages(db, bubbleExactPrefixSpec(db, keyPrefix), budget, signal)) {
    for (const metadata of page) {
      throwIfAborted(signal);
      visit(metadata);
    }
  }
}

interface FetchedValueRow {
  readonly key?: unknown;
  readonly value?: unknown;
  readonly valueIsNull?: unknown;
}

/**
 * Prefetches payloads for one admitted page in bounded batches. Each row is
 * still checked and charged individually, in page order, when its consumer asks
 * for it; prefetching only changes how many statements cross the adapter.
 * The `rowid = ? AND key = ? COLLATE BINARY` identity check is evaluated by SQL
 * for every row (a join against the admitted `(rowid, key)` pairs), so a row
 * whose key bytes changed is simply absent and reported as changed.
 */
class ValueBatcher {
  private readonly statements = new Map<number, ReturnType<Database['prepare']>>();
  private page: readonly ComposerSqliteMetadata[] = [];
  private rows: Array<FetchedValueRow | undefined> = [];
  private fetchedUpTo = 0;

  constructor(
    private readonly db: Database,
    private readonly table: string,
    private readonly nullState: boolean
  ) {}

  begin(page: readonly ComposerSqliteMetadata[]): void {
    this.page = page;
    this.rows = new Array(page.length);
    this.fetchedUpTo = 0;
  }

  take(index: number): FetchedValueRow | undefined {
    if (index >= this.fetchedUpTo) this.fetchChunk(index);
    const row = this.rows[index];
    this.rows[index] = undefined;
    return row;
  }

  private fetchChunk(start: number): void {
    let end = start;
    let bytes = 0;
    while (end < this.page.length && end - start < VALUE_BATCH_ROWS) {
      const metadata = this.page[end]!;
      if (end > start && bytes + metadata.byteLength > VALUE_BATCH_BYTES) break;
      bytes += metadata.byteLength;
      end++;
    }
    const count = end - start;
    let statement = this.statements.get(count);
    if (!statement) {
      const tuples = Array.from({ length: count }, () => '(?,?,?)').join(',');
      const nullState = this.nullState ? ', t.value IS NULL AS valueIsNull' : '';
      statement = this.db.prepare(
        `WITH w(i, r, k) AS (VALUES ${tuples}) SELECT w.i AS i, t.key AS key, CAST(t.value AS BLOB) AS value${nullState} FROM w JOIN ${this.table} AS t ON t.rowid = w.r AND t.key = w.k COLLATE BINARY`
      );
      this.statements.set(count, statement);
    }
    const params: unknown[] = [];
    for (let offset = 0; offset < count; offset++) {
      const metadata = this.page[start + offset]!;
      params.push(offset, metadata.rowId, metadata.key);
    }
    const found = statement.all(...params) as Array<FetchedValueRow & { i?: unknown }>;
    for (const row of found) {
      const offset = Number(row.i);
      if (Number.isInteger(offset) && offset >= 0 && offset < count) {
        this.rows[start + offset] = row;
      }
    }
    this.fetchedUpTo = end;
  }
}

function readAdmittedComposerValue(
  db: Database,
  table: ComposerKeyValueTable,
  metadata: ComposerSqliteMetadata,
  budget: SqliteSourceReadBudget,
  signal?: AbortSignal,
  prefetched?: () => FetchedValueRow | undefined
): ComposerSqliteValue {
  throwIfAborted(signal);
  const internal = metadata as InternalComposerSqliteMetadata;
  let rawValue: unknown;
  let returnedKey = metadata.key;
  if (Object.prototype.hasOwnProperty.call(internal, 'inlineValue')) {
    rawValue = internal.inlineValue;
  } else {
    const row = prefetched
      ? prefetched()
      : (db
          .prepare(
            `SELECT key, CAST(value AS BLOB) AS value FROM ${table} WHERE ${table}.rowid = ? AND key = ? COLLATE BINARY`
          )
          .get(metadata.rowId, metadata.key) as { key?: unknown; value?: unknown } | undefined);
    if (!row || row.value === undefined || row.value === null) {
      throw new Error('Composer SQLite payload changed after metadata admission.');
    }
    if (typeof row.key !== 'string') {
      throw new TypeError('SQLite returned a Composer payload without a key');
    }
    returnedKey = row.key;
    rawValue = row.value;
  }
  if (returnedKey !== metadata.key) {
    throw new Error('Composer SQLite row identity changed after metadata admission.');
  }

  const bytes = payloadBytes(rawValue);
  if (bytes.byteLength !== metadata.byteLength) {
    throw new Error('Composer SQLite payload length changed after metadata admission.');
  }
  budget.admitDecodedValue(bytes.byteLength);
  const value = decodeDeterministicUtf8(bytes, 'sqlite', budget.outcome).text;
  return { ...metadata, value };
}

function readAdmittedComposerBubbleValue(
  db: Database,
  metadata: ComposerSqliteBubbleMetadata,
  budget: SqliteSourceReadBudget,
  signal?: AbortSignal,
  prefetched?: () => FetchedValueRow | undefined
): ComposerSqliteBubbleValue {
  throwIfAborted(signal);
  const internal = metadata as InternalComposerSqliteBubbleMetadata;
  let rawValue: unknown;
  let returnedKey = metadata.key;
  let returnedValueIsNull: boolean;
  if (Object.prototype.hasOwnProperty.call(internal, 'inlineValue')) {
    rawValue = internal.inlineValue;
    returnedValueIsNull = rawValue === null;
  } else {
    const row = prefetched
      ? prefetched()
      : (db
          .prepare(
            `SELECT key, CAST(value AS BLOB) AS value, value IS NULL AS valueIsNull FROM cursorDiskKV WHERE cursorDiskKV.rowid = ? AND key = ? COLLATE BINARY`
          )
          .get(metadata.rowId, metadata.key) as FetchedValueRow | undefined);
    if (!row || row.value === undefined) {
      throw new Error('Composer SQLite payload changed after metadata admission.');
    }
    if (typeof row.key !== 'string') {
      throw new TypeError('SQLite returned a Composer bubble payload without a key');
    }
    const projectedNullState = sqliteBoolean(row.valueIsNull);
    if (projectedNullState === undefined) {
      throw new TypeError(
        'SQLite returned a Composer bubble payload without a null-state projection'
      );
    }
    returnedKey = row.key;
    rawValue = row.value;
    returnedValueIsNull = projectedNullState;
  }

  if (returnedKey !== metadata.key) {
    throw new Error('Composer SQLite row identity changed after metadata admission.');
  }
  if (returnedValueIsNull !== metadata.valueIsNull || (rawValue === null) !== returnedValueIsNull) {
    throw new Error('Composer SQLite payload changed after metadata admission.');
  }
  if (returnedValueIsNull) {
    budget.admitDecodedValue(0);
    return { ...metadata, value: null };
  }

  const bytes = payloadBytes(rawValue);
  if (bytes.byteLength !== metadata.byteLength) {
    throw new Error('Composer SQLite payload length changed after metadata admission.');
  }
  budget.admitDecodedValue(bytes.byteLength);
  const value = decodeDeterministicUtf8(bytes, 'sqlite', budget.outcome).text;
  return { ...metadata, value };
}

/** Metadata preflight followed by one sequential exact-key payload fetch. */
export function readBoundedComposerValueByKey(
  db: Database,
  table: ComposerKeyValueTable,
  key: string,
  budget: SqliteSourceReadBudget,
  signal?: AbortSignal
): string | undefined {
  const metadata = getBoundedComposerMetadataByKey(db, table, key, budget, signal);
  if (!metadata) return undefined;
  return readAdmittedComposerValue(db, table, metadata, budget, signal).value;
}

/** Read the first row in row-ID order for a LIKE pattern through the same preflight. */
export function readFirstBoundedComposerValue(
  db: Database,
  table: ComposerKeyValueTable,
  keyPattern: string,
  budget: SqliteSourceReadBudget,
  signal?: AbortSignal
): ComposerSqliteValue | undefined {
  throwIfAborted(signal);
  const raw = db
    .prepare(
      `SELECT CAST(${table}.rowid AS TEXT) AS rowId, key, ${byteLengthSql(db)} AS byteLength FROM ${table} WHERE key LIKE ? ESCAPE '\\' AND value IS NOT NULL ORDER BY ${table}.rowid ASC LIMIT 1`
    )
    .get(keyPattern) as Record<string, unknown> | undefined;
  if (!raw) return undefined;
  const metadata = normalizeMetadata(raw, keyPattern);
  budget.admitMetadataPage([metadata.byteLength]);
  return readAdmittedComposerValue(db, table, metadata, budget, signal);
}

/** Read the first global bubble row in row-ID order, including a stored SQL NULL. */
export function readFirstBoundedComposerBubbleValue(
  db: Database,
  keyPattern: string,
  budget: SqliteSourceReadBudget,
  signal?: AbortSignal
): ComposerSqliteBubbleValue | undefined {
  throwIfAborted(signal);
  const raw = db
    .prepare(
      `SELECT CAST(cursorDiskKV.rowid AS TEXT) AS rowId, key, ${bubbleColumns(db)} FROM cursorDiskKV WHERE key LIKE ? ESCAPE '\\' ORDER BY cursorDiskKV.rowid ASC LIMIT 1`
    )
    .get(keyPattern) as Record<string, unknown> | undefined;
  if (!raw) return undefined;
  const metadata = normalizeBubbleMetadata(raw, keyPattern);
  budget.admitMetadataPage([metadata.byteLength]);
  return readAdmittedComposerBubbleValue(db, metadata, budget, signal);
}

/**
 * First or last bubble row (by rowid) of one exact prefix. The extreme rowid is
 * found with a covering-index `min`/`max` over the key range, so no TEMP B-TREE
 * sorts or projects the composer's other bubbles; the winning row is then read
 * by rowid. Falls back to the released ordered `LIMIT 1` statement.
 */
function readExtremeBubbleByExactPrefix(
  db: Database,
  keyPrefix: string,
  direction: 'ASC' | 'DESC',
  budget: SqliteSourceReadBudget,
  signal?: AbortSignal
): ComposerSqliteBubbleValue | undefined {
  const predicate = exactPrefixPredicate('cursorDiskKV.key', keyPrefix);
  throwIfAborted(signal);
  const range = db.composerReadCapabilities !== undefined ? exactPrefixKeyRange(keyPrefix) : null;
  let raw: Record<string, unknown> | undefined;
  if (range) {
    const aggregate = direction === 'ASC' ? 'min' : 'max';
    const extreme = db
      .prepare(
        `SELECT CAST(${aggregate}(cursorDiskKV.rowid) AS TEXT) AS rowId FROM cursorDiskKV WHERE key >= ? COLLATE BINARY AND key < ? COLLATE BINARY AND ${predicate.sql}`
      )
      .get(range.lower, range.upper, ...predicate.params) as Record<string, unknown> | undefined;
    const extremeRowId = extreme?.['rowId'];
    if (extremeRowId === undefined || extremeRowId === null) return undefined;
    raw = db
      .prepare(
        `SELECT CAST(cursorDiskKV.rowid AS TEXT) AS rowId, key, ${bubbleColumns(db)} FROM cursorDiskKV WHERE cursorDiskKV.rowid = ? AND ${predicate.sql}`
      )
      .get(normalizedRowId(extremeRowId, 0), ...predicate.params) as
      Record<string, unknown> | undefined;
  } else {
    raw = db
      .prepare(
        `SELECT CAST(cursorDiskKV.rowid AS TEXT) AS rowId, key, ${bubbleColumns(db)} FROM cursorDiskKV WHERE ${predicate.sql} ORDER BY cursorDiskKV.rowid ${direction} LIMIT 1`
      )
      .get(...predicate.params) as Record<string, unknown> | undefined;
  }
  if (!raw) return undefined;
  const metadata = normalizeBubbleMetadata(raw, keyPrefix);
  budget.admitMetadataPage([metadata.byteLength]);
  return readAdmittedComposerBubbleValue(db, metadata, budget, signal);
}

/** Read the first nullable global bubble for one exact byte prefix. */
export function readFirstBoundedComposerBubbleValueByExactPrefix(
  db: Database,
  keyPrefix: string,
  budget: SqliteSourceReadBudget,
  signal?: AbortSignal
): ComposerSqliteBubbleValue | undefined {
  return readExtremeBubbleByExactPrefix(db, keyPrefix, 'ASC', budget, signal);
}

/**
 * Read the last nullable global bubble for one exact byte prefix.
 *
 * This is physical row-ID order only, not chronological order. Session time
 * extrema must consider all valid directly stored message timestamps.
 */
export function readLastBoundedComposerBubbleValueByExactPrefix(
  db: Database,
  keyPrefix: string,
  budget: SqliteSourceReadBudget,
  signal?: AbortSignal
): ComposerSqliteBubbleValue | undefined {
  return readExtremeBubbleByExactPrefix(db, keyPrefix, 'DESC', budget, signal);
}

/** Admit full metadata pages, then fetch and release each matching payload in bounded batches. */
export function forEachBoundedComposerValue(
  db: Database,
  table: ComposerKeyValueTable,
  keyPattern: string,
  budget: SqliteSourceReadBudget,
  visit: (row: ComposerSqliteValue) => void,
  signal?: AbortSignal
): void {
  const batcher =
    db.composerReadCapabilities !== undefined ? new ValueBatcher(db, table, false) : undefined;
  const spec = composerMetadataSpec(db, table, keyPattern);
  for (const page of rowIdOrderedPages(db, spec, budget, signal)) {
    batcher?.begin(page);
    for (let index = 0; index < page.length; index++) {
      throwIfAborted(signal);
      visit(
        readAdmittedComposerValue(
          db,
          table,
          page[index]!,
          budget,
          signal,
          batcher && (() => batcher.take(index))
        )
      );
    }
  }
}

function visitBubbleValues(
  db: Database,
  spec: RowIdOrderedSpec<InternalComposerSqliteBubbleMetadata>,
  budget: SqliteSourceReadBudget,
  visit: (row: ComposerSqliteBubbleValue) => void,
  signal?: AbortSignal
): void {
  const batcher =
    db.composerReadCapabilities !== undefined
      ? new ValueBatcher(db, 'cursorDiskKV', true)
      : undefined;
  for (const page of rowIdOrderedPages(db, spec, budget, signal)) {
    batcher?.begin(page);
    for (let index = 0; index < page.length; index++) {
      throwIfAborted(signal);
      visit(
        readAdmittedComposerBubbleValue(
          db,
          page[index]!,
          budget,
          signal,
          batcher && (() => batcher.take(index))
        )
      );
    }
  }
}

/**
 * Admit full global-bubble metadata pages, then fetch each nullable payload in
 * bounded batches. Physical row-ID order is preserved, including SQL NULL rows.
 */
export function forEachBoundedComposerBubbleValue(
  db: Database,
  keyPattern: string,
  budget: SqliteSourceReadBudget,
  visit: (row: ComposerSqliteBubbleValue) => void,
  signal?: AbortSignal
): void {
  visitBubbleValues(db, bubbleLikeSpec(db, keyPattern), budget, visit, signal);
}

/** Fetch nullable global bubbles under one exact, case-sensitive byte prefix. */
export function forEachBoundedComposerBubbleValueByExactPrefix(
  db: Database,
  keyPrefix: string,
  budget: SqliteSourceReadBudget,
  visit: (row: ComposerSqliteBubbleValue) => void,
  signal?: AbortSignal
): void {
  visitBubbleValues(db, bubbleExactPrefixSpec(db, keyPrefix), budget, visit, signal);
}
