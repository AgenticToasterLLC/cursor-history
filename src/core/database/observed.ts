import {
  observeAdapterIo,
  type AdapterIoEventInput,
  type OperationIoContext,
} from '../io-observer.js';
import {
  describeSql,
  diagnosticsNow,
  emitDiagnostic,
  type DiagnosticStatementOp,
} from '../diagnostics.js';
import type { Database, DatabaseOperationRequest, RunResult, Statement } from './types.js';

type IoIdentity = Pick<
  AdapterIoEventInput,
  'logicalSessionId' | 'sourceRole' | 'representation' | 'resourceClass'
>;

function requestIdentity(request: DatabaseOperationRequest): IoIdentity {
  return request.ioResource ?? { resourceClass: 'unclassified-resource' };
}

function selectsRawPayload(sql: string): boolean {
  const projection = sql.match(/\bSELECT\b([\s\S]*?)\bFROM\b/iu)?.[1];
  if (!projection) return false;
  // Declared byte lengths are catalog metadata: the engine evaluates value
  // length without returning the raw bytes across the adapter boundary.
  const withoutMetadataPreflights = projection
    .replace(/\blength\s*\(\s*cast\s*\(\s*(?:value|data)\s+as\s+blob\s*\)\s*\)/giu, '')
    .replace(/\b(?:value|data)\s+is\s+(?:not\s+)?null(?:\s+as\s+\w+)?/giu, '');
  return /\b(?:value|data)\b/iu.test(withoutMetadataPreflights);
}

function eventIdentity(sql: string, params: readonly unknown[], fallback: IoIdentity): IoIdentity {
  const parameterStrings = params.filter((value): value is string => typeof value === 'string');
  const composerToken = parameterStrings.find((value) => value.startsWith('composerData:'));
  const bubbleToken = parameterStrings.find((value) => value.startsWith('bubbleId:'));
  const logicalSessionId = composerToken
    ? composerToken.slice('composerData:'.length)
    : bubbleToken?.slice('bubbleId:'.length).split(':')[0];
  if (/\bsqlite_master\b/iu.test(sql)) {
    return { ...fallback, resourceClass: 'workspace-database-schema' };
  }
  // The fallback describes the database's intended use, not permission to
  // weaken a statement that actually crosses the adapter with raw payload.
  // Keep this check ahead of the workspace-index fast path so instrumentation
  // and poison mutations fail closed if that reviewed projection ever starts
  // selecting Composer JSON.
  if (fallback.resourceClass === 'workspace-session-index' && selectsRawPayload(sql)) {
    return { ...fallback, resourceClass: 'workspace-conversation' };
  }
  // A scoped off-workspace database is opened under this reviewed identity
  // solely for UUID projection. The SQL mentions composerData as a key name,
  // but it does not select the Composer JSON payload and must not be relabeled
  // as a global conversation read.
  if (fallback.resourceClass === 'workspace-session-index') {
    return fallback;
  }
  if (/\bjson_extract\b/iu.test(sql) && /\bworkspace(?:Identifier|Uri)\b/iu.test(sql)) {
    return { ...fallback, resourceClass: 'global-composer-membership' };
  }
  if (bubbleToken && !selectsRawPayload(sql)) {
    return {
      ...fallback,
      resourceClass: 'global-bubble-index',
      ...(logicalSessionId ? { logicalSessionId } : {}),
    };
  }
  if (composerToken && !selectsRawPayload(sql)) {
    return {
      ...fallback,
      resourceClass: 'global-composer-membership',
      ...(logicalSessionId ? { logicalSessionId } : {}),
    };
  }
  if (/\bbubbleId\b/iu.test(sql) || bubbleToken) {
    return {
      ...fallback,
      resourceClass: 'global-bubble',
      ...(logicalSessionId ? { logicalSessionId } : {}),
    };
  }
  if (/\bcomposerData\b/iu.test(sql) || composerToken) {
    return {
      ...fallback,
      resourceClass: 'global-composer',
      ...(logicalSessionId ? { logicalSessionId } : {}),
    };
  }
  if (/\bblobs\b/iu.test(sql)) {
    return { ...fallback, resourceClass: 'store-leaf' };
  }
  if (/\bmeta\b/iu.test(sql)) {
    return { ...fallback, resourceClass: 'store-database' };
  }
  return fallback;
}

function isKeyValueStatement(sql: string): boolean {
  return /\b(?:ItemTable|cursorDiskKV|blobs|meta)\b/iu.test(sql);
}

function emit(
  context: OperationIoContext,
  operation: AdapterIoEventInput['operation'],
  identity: IoIdentity,
  adapter: AdapterIoEventInput['adapter'] = 'sqlite'
): void {
  observeAdapterIo(context, { adapter, operation, ...identity });
}

class ObservedStatement implements Statement {
  private described: { sqlShape: string; fingerprint: string } | undefined;

  constructor(
    private readonly inner: Statement,
    private readonly sql: string,
    private readonly context: OperationIoContext,
    private readonly fallback: IoIdentity
  ) {}

  private beforeQuery(params: readonly unknown[]): IoIdentity {
    const identity = eventIdentity(this.sql, params, this.fallback);
    emit(this.context, 'query', identity);
    if (isKeyValueStatement(this.sql)) emit(this.context, 'get', identity, 'key-value');
    return identity;
  }

  // diag: only reached when a sink is configured.
  private report(
    op: DiagnosticStatementOp,
    identity: IoIdentity,
    start: number,
    rowsReturned: number
  ): void {
    const sink = this.context.diagnostics;
    this.described ??= describeSql(this.sql);
    emitDiagnostic(sink, {
      type: 'query',
      adapter: 'sqlite',
      fingerprint: this.described.fingerprint,
      sqlShape: this.described.sqlShape,
      durationMs: diagnosticsNow() - start,
      rowsReturned,
      op,
      resourceClass: identity.resourceClass,
    });
  }

  get(...params: unknown[]): unknown {
    const identity = this.beforeQuery(params);
    if (!this.context.diagnostics) return this.inner.get(...params);
    const start = diagnosticsNow();
    let rows = 0;
    try {
      const row = this.inner.get(...params);
      rows = row === undefined || row === null ? 0 : 1;
      return row;
    } finally {
      this.report('get', identity, start, rows);
    }
  }

  all(...params: unknown[]): unknown[] {
    const identity = this.beforeQuery(params);
    if (!this.context.diagnostics) return this.inner.all(...params);
    const start = diagnosticsNow();
    let rows = 0;
    try {
      const result = this.inner.all(...params);
      rows = result.length;
      return result;
    } finally {
      this.report('all', identity, start, rows);
    }
  }

  run(...params: unknown[]): RunResult {
    const identity = this.beforeQuery(params);
    if (!this.context.diagnostics) return this.inner.run(...params);
    const start = diagnosticsNow();
    try {
      return this.inner.run(...params);
    } finally {
      this.report('run', identity, start, 0);
    }
  }
}

class ObservedDatabase implements Database {
  private readonly fallback: IoIdentity;

  constructor(
    private readonly inner: Database,
    private readonly context: OperationIoContext,
    request: DatabaseOperationRequest
  ) {
    this.fallback = requestIdentity(request);
  }

  prepare(sql: string): Statement {
    const identity = eventIdentity(sql, [], this.fallback);
    emit(this.context, 'prepare', identity);
    if (!this.context.diagnostics) {
      return new ObservedStatement(this.inner.prepare(sql), sql, this.context, this.fallback);
    }
    const start = diagnosticsNow();
    let prepared: Statement;
    try {
      prepared = this.inner.prepare(sql);
    } finally {
      const { sqlShape, fingerprint } = describeSql(sql);
      emitDiagnostic(this.context.diagnostics, {
        type: 'query',
        adapter: 'sqlite',
        fingerprint,
        sqlShape,
        durationMs: diagnosticsNow() - start,
        rowsReturned: 0,
        op: 'prepare',
        resourceClass: identity.resourceClass,
      });
    }
    return new ObservedStatement(prepared, sql, this.context, this.fallback);
  }

  runSQL(sql: string): void {
    const identity = eventIdentity(sql, [], this.fallback);
    emit(this.context, 'prepare', identity);
    emit(this.context, 'query', identity);
    if (!this.context.diagnostics) {
      this.inner.runSQL(sql);
      return;
    }
    const start = diagnosticsNow();
    try {
      this.inner.runSQL(sql);
    } finally {
      const { sqlShape, fingerprint } = describeSql(sql);
      emitDiagnostic(this.context.diagnostics, {
        type: 'query',
        adapter: 'sqlite',
        fingerprint,
        sqlShape,
        durationMs: diagnosticsNow() - start,
        rowsReturned: 0,
        op: 'run',
        resourceClass: identity.resourceClass,
      });
    }
  }

  close(): void {
    this.inner.close();
  }
}

/** Emit the driver-open boundary, then wrap every statement boundary. */
export function openObservedDatabase(
  context: OperationIoContext | undefined,
  request: DatabaseOperationRequest,
  open: () => Database,
  readOnly = true
): Database {
  if (!context) return open();
  emit(context, 'open', requestIdentity(request));
  if (!context.diagnostics) return new ObservedDatabase(open(), context, request);
  const start = diagnosticsNow();
  let database: Database;
  try {
    database = open();
  } finally {
    emitDiagnostic(context.diagnostics, {
      type: 'db-open',
      adapter: 'sqlite',
      resourceClass: requestIdentity(request).resourceClass,
      durationMs: diagnosticsNow() - start,
      readOnly,
    });
  }
  return new ObservedDatabase(database, context, request);
}

/** Emit immediately before an online SQLite backup call. */
export function observeDatabaseBackup(request: DatabaseOperationRequest): void {
  if (!request.io) return;
  emit(request.io, 'backup', requestIdentity(request));
}
