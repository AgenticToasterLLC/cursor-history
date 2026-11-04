/**
 * Content-free performance diagnostics.
 *
 * A DiagnosticsSink receives timing events for phases, SQL statements and
 * database opens. Events never carry parameter values, row values, keys,
 * paths, titles or message text. Sinks are best-effort: exceptions thrown by a
 * sink are swallowed so diagnostics can never break or alter a read. When no
 * sink is configured every helper here is a pass-through that neither reads a
 * clock nor allocates.
 */

import { createHash } from 'node:crypto';

/** SQL statement operation reported on a query diagnostic event. */
export type DiagnosticStatementOp = 'get' | 'all' | 'iterate' | 'run' | 'prepare';

/** A named phase of a larger read operation. */
export interface PhaseDiagnosticEvent {
  readonly type: 'phase';
  readonly name: string;
  readonly durationMs: number;
  /** Optional numeric counters such as workspacesOpened, rows, decodedBytes. */
  readonly counters?: Readonly<Record<string, number>>;
}

/** One SQL statement call. `sqlShape` has whitespace collapsed and literals replaced by `?`. */
export interface QueryDiagnosticEvent {
  readonly type: 'query';
  readonly adapter: 'sqlite';
  /** First 12 hex characters of sha256(sqlShape). */
  readonly fingerprint: string;
  readonly sqlShape: string;
  readonly durationMs: number;
  readonly rowsReturned: number;
  readonly op: DiagnosticStatementOp;
  readonly resourceClass: string;
}

/** One database open. */
export interface DbOpenDiagnosticEvent {
  readonly type: 'db-open';
  readonly adapter: 'sqlite';
  readonly resourceClass: string;
  readonly durationMs: number;
  readonly readOnly: boolean;
}

/** Union of every content-free event a {@link DiagnosticsSink} can receive. */
export type DiagnosticEvent = PhaseDiagnosticEvent | QueryDiagnosticEvent | DbOpenDiagnosticEvent;

/** Receives content-free diagnostic events. Exceptions thrown here are ignored. */
export interface DiagnosticsSink {
  /**
   * Receive one content-free diagnostic event.
   *
   * @param event - Phase, query or database-open timing; never contains parameters, rows, keys, paths or message text.
   * @returns Nothing; the return value is ignored and thrown errors are swallowed by the library.
   */
  onEvent(event: DiagnosticEvent): void;
}

/** Deliver an event to a sink, ignoring any sink failure. */
export function emitDiagnostic(sink: DiagnosticsSink | undefined, event: DiagnosticEvent): void {
  if (!sink) return;
  try {
    sink.onEvent(event);
  } catch {
    // Diagnostics must never alter a read.
  }
}

/** Monotonic millisecond clock; only called when a sink is configured. */
export function diagnosticsNow(): number {
  return performance.now();
}

let processDefaultSink: DiagnosticsSink | undefined;

/**
 * Process-wide fallback sink used when a read context is created without an
 * explicit one. Intended for the CLI `--profile` flag only; pass undefined to clear.
 */
export function setProcessDiagnosticsSink(sink: DiagnosticsSink | undefined): void {
  processDefaultSink = sink;
}

export function getProcessDiagnosticsSink(): DiagnosticsSink | undefined {
  return processDefaultSink;
}

/**
 * Create a sink from a plain callback.
 *
 * @param onEvent - Callback invoked for each diagnostic event.
 * @returns A sink delivering events to the callback.
 */
export function createDiagnosticsSink(onEvent: (event: DiagnosticEvent) => void): DiagnosticsSink {
  return { onEvent };
}

/**
 * Collapse whitespace and replace quoted strings and numeric literals with `?`.
 * Placeholders and interpolated table names are preserved.
 */
export function normalizeSqlShape(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/"(?:[^"]|"")*"/g, '?')
    .replace(/\b0[xX][0-9a-fA-F]+\b/g, '?')
    .replace(/\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First 12 hex characters of the sha256 of an already-normalized shape. */
export function fingerprintSqlShape(sqlShape: string): string {
  return createHash('sha256').update(sqlShape).digest('hex').slice(0, 12);
}

/** Normalize a statement and fingerprint it. */
export function describeSql(sql: string): { sqlShape: string; fingerprint: string } {
  const sqlShape = normalizeSqlShape(sql);
  return { sqlShape, fingerprint: fingerprintSqlShape(sqlShape) };
}

type Counters = Readonly<Record<string, number>> | undefined;

/**
 * Time `fn` as a phase. Sync/async safe: a returned promise is timed until it
 * settles. With no sink this returns `fn()` directly (no clock, no allocation).
 * `counters` is evaluated after completion (also on failure) to attach counters.
 */
export function withPhase<T>(
  sink: DiagnosticsSink | undefined,
  name: string,
  fn: () => T,
  counters?: () => Counters
): T {
  if (!sink) return fn();
  const start = diagnosticsNow();
  const finish = (): void => {
    let c: Counters;
    try {
      c = counters?.();
    } catch {
      c = undefined;
    }
    emitDiagnostic(sink, {
      type: 'phase',
      name,
      durationMs: diagnosticsNow() - start,
      ...(c ? { counters: c } : {}),
    });
  };
  let result: T;
  try {
    result = fn();
  } catch (error) {
    finish();
    throw error;
  }
  if (
    result !== null &&
    typeof result === 'object' &&
    typeof (result as { then?: unknown }).then === 'function'
  ) {
    return (result as unknown as Promise<unknown>).then(
      (value) => {
        finish();
        return value;
      },
      (error: unknown) => {
        finish();
        throw error;
      }
    ) as T;
  }
  finish();
  return result;
}

/** Phase-timer helper bound to a sink. */
export interface PhaseTimer {
  run<T>(name: string, fn: () => T, counters?: () => Counters): T;
}

export function createPhaseTimer(sink: DiagnosticsSink | undefined): PhaseTimer {
  return { run: (name, fn, counters) => withPhase(sink, name, fn, counters) };
}

/**
 * Linear phase marker for long functions where wrapping a callback would force
 * restructuring. `next(name)` closes the open phase and opens another; `end()`
 * closes the open phase. Phases left open by a throw are simply not reported.
 * With no sink a shared no-op is returned (no allocation, no clock).
 */
export interface PhaseSequence {
  next(name: string, counters?: () => Counters): void;
  end(counters?: () => Counters): void;
}

const NOOP_SEQUENCE: PhaseSequence = Object.freeze({
  next(): void {},
  end(): void {},
});

export function createPhaseSequence(sink: DiagnosticsSink | undefined): PhaseSequence {
  if (!sink) return NOOP_SEQUENCE;
  let name: string | undefined;
  let start = 0;
  const close = (counters?: () => Counters): void => {
    if (name === undefined) return;
    let c: Counters;
    try {
      c = counters?.();
    } catch {
      c = undefined;
    }
    emitDiagnostic(sink, {
      type: 'phase',
      name,
      durationMs: diagnosticsNow() - start,
      ...(c ? { counters: c } : {}),
    });
    name = undefined;
  };
  return {
    next(nextName, counters): void {
      close(counters);
      name = nextName;
      start = diagnosticsNow();
    },
    end(counters): void {
      close(counters);
    },
  };
}

/** Aggregated timing for one named phase. */
export interface PhaseSummary {
  count: number;
  totalMs: number;
  maxMs: number;
  counters: Record<string, number>;
}

/** Aggregated timing and row counts for one SQL fingerprint. */
export interface QuerySummary {
  fingerprint: string;
  sqlShape: string;
  count: number;
  totalMs: number;
  maxMs: number;
  rows: number;
  ops: Record<string, number>;
}

/** Aggregated database-open timing for one resource class. */
export interface DbOpenSummary {
  count: number;
  totalMs: number;
  maxMs: number;
  readOnly: number;
}

/** JSON-serializable, content-free profile produced by a {@link ProfileCollector}. */
export interface ProfileSummary {
  phases: Record<string, PhaseSummary>;
  queries: QuerySummary[];
  dbOpens: Record<string, DbOpenSummary>;
}

/** Sink that aggregates events into a {@link ProfileSummary}. */
export interface ProfileCollector extends DiagnosticsSink {
  /**
   * Snapshot the aggregated profile.
   *
   * @returns Phases, queries (slowest first) and database opens collected so far.
   */
  toJSON(): ProfileSummary;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * Create a collector that aggregates events into a JSON-serializable summary.
 *
 * @returns A new empty profile collector usable as a diagnostics sink.
 */
export function createProfileCollector(): ProfileCollector {
  const phases = new Map<string, PhaseSummary>();
  const queries = new Map<string, QuerySummary>();
  const dbOpens = new Map<string, DbOpenSummary>();
  return {
    onEvent(event: DiagnosticEvent): void {
      if (event.type === 'phase') {
        let p = phases.get(event.name);
        if (!p) phases.set(event.name, (p = { count: 0, totalMs: 0, maxMs: 0, counters: {} }));
        p.count += 1;
        p.totalMs += event.durationMs;
        p.maxMs = Math.max(p.maxMs, event.durationMs);
        for (const [k, v] of Object.entries(event.counters ?? {})) {
          p.counters[k] = (p.counters[k] ?? 0) + v;
        }
      } else if (event.type === 'query') {
        let q = queries.get(event.fingerprint);
        if (!q) {
          queries.set(
            event.fingerprint,
            (q = {
              fingerprint: event.fingerprint,
              sqlShape: event.sqlShape,
              count: 0,
              totalMs: 0,
              maxMs: 0,
              rows: 0,
              ops: {},
            })
          );
        }
        q.count += 1;
        q.totalMs += event.durationMs;
        q.maxMs = Math.max(q.maxMs, event.durationMs);
        q.rows += event.rowsReturned;
        q.ops[event.op] = (q.ops[event.op] ?? 0) + 1;
      } else {
        let d = dbOpens.get(event.resourceClass);
        if (!d) {
          dbOpens.set(event.resourceClass, (d = { count: 0, totalMs: 0, maxMs: 0, readOnly: 0 }));
        }
        d.count += 1;
        d.totalMs += event.durationMs;
        d.maxMs = Math.max(d.maxMs, event.durationMs);
        if (event.readOnly) d.readOnly += 1;
      }
    },
    toJSON(): ProfileSummary {
      const phaseOut: Record<string, PhaseSummary> = {};
      for (const [k, v] of phases) {
        phaseOut[k] = {
          ...v,
          totalMs: round(v.totalMs),
          maxMs: round(v.maxMs),
          counters: { ...v.counters },
        };
      }
      const dbOut: Record<string, DbOpenSummary> = {};
      for (const [k, v] of dbOpens) {
        dbOut[k] = { ...v, totalMs: round(v.totalMs), maxMs: round(v.maxMs) };
      }
      return {
        phases: phaseOut,
        queries: [...queries.values()]
          .map((q) => ({
            ...q,
            totalMs: round(q.totalMs),
            maxMs: round(q.maxMs),
            ops: { ...q.ops },
          }))
          .sort((a, b) => b.totalMs - a.totalMs),
        dbOpens: dbOut,
      };
    },
  };
}
