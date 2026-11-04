import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPhaseSequence,
  createProfileCollector,
  describeSql,
  emitDiagnostic,
  fingerprintSqlShape,
  normalizeSqlShape,
  withPhase,
  type DiagnosticEvent,
} from '../../src/core/diagnostics.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sql shape normalization', () => {
  it('collapses whitespace and strips literals', () => {
    const shape = normalizeSqlShape(
      "SELECT  key\n  FROM cursorDiskKV\tWHERE key = 'secret''s' AND n > 42 AND f = 1.5e3 AND x = 0xFF AND y = \"quoted\" LIMIT ?"
    );
    expect(shape).toBe(
      'SELECT key FROM cursorDiskKV WHERE key = ? AND n > ? AND f = ? AND x = ? AND y = ? LIMIT ?'
    );
    expect(shape).not.toContain('secret');
  });

  it('keeps identifiers containing digits and placeholders', () => {
    expect(normalizeSqlShape('SELECT col1 FROM t2 WHERE a = ?')).toBe(
      'SELECT col1 FROM t2 WHERE a = ?'
    );
  });

  it('fingerprints are 12 hex chars and equal for equal shapes', () => {
    const a = describeSql("SELECT 1 FROM t WHERE k = 'a'");
    const b = describeSql('SELECT   2 FROM t WHERE k =   "b"');
    expect(a.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toBe(fingerprintSqlShape(a.sqlShape));
  });
});

describe('profile collector', () => {
  it('aggregates phases, queries and db opens', () => {
    const collector = createProfileCollector();
    const events: DiagnosticEvent[] = [
      { type: 'phase', name: 'A', durationMs: 2, counters: { rows: 3 } },
      { type: 'phase', name: 'A', durationMs: 5, counters: { rows: 4 } },
      {
        type: 'query',
        adapter: 'sqlite',
        fingerprint: 'abc',
        sqlShape: 'SELECT ?',
        durationMs: 1,
        rowsReturned: 2,
        op: 'all',
        resourceClass: 'global-composer',
      },
      {
        type: 'query',
        adapter: 'sqlite',
        fingerprint: 'abc',
        sqlShape: 'SELECT ?',
        durationMs: 3,
        rowsReturned: 1,
        op: 'get',
        resourceClass: 'global-composer',
      },
      {
        type: 'db-open',
        adapter: 'sqlite',
        resourceClass: 'global-session-index',
        durationMs: 4,
        readOnly: true,
      },
    ];
    for (const event of events) collector.onEvent(event);
    const json = JSON.parse(JSON.stringify(collector.toJSON())) as ReturnType<
      typeof collector.toJSON
    >;
    expect(json.phases['A']).toEqual({ count: 2, totalMs: 7, maxMs: 5, counters: { rows: 7 } });
    expect(json.queries).toEqual([
      {
        fingerprint: 'abc',
        sqlShape: 'SELECT ?',
        count: 2,
        totalMs: 4,
        maxMs: 3,
        rows: 3,
        ops: { all: 1, get: 1 },
      },
    ]);
    expect(json.dbOpens['global-session-index']).toEqual({
      count: 1,
      totalMs: 4,
      maxMs: 4,
      readOnly: 1,
    });
  });
});

describe('phase helpers', () => {
  it('withPhase times sync and async work and reports failures', async () => {
    const events: DiagnosticEvent[] = [];
    const sink = { onEvent: (event: DiagnosticEvent) => void events.push(event) };
    expect(withPhase(sink, 'sync', () => 7)).toBe(7);
    await expect(withPhase(sink, 'async', async () => 8)).resolves.toBe(8);
    expect(() =>
      withPhase(sink, 'boom', () => {
        throw new Error('x');
      })
    ).toThrow('x');
    await expect(withPhase(sink, 'reject', () => Promise.reject(new Error('y')))).rejects.toThrow(
      'y'
    );
    expect(events.map((e) => (e.type === 'phase' ? e.name : ''))).toEqual([
      'sync',
      'async',
      'boom',
      'reject',
    ]);
  });

  it('phase sequence closes the previous phase on next()', () => {
    const events: DiagnosticEvent[] = [];
    const seq = createPhaseSequence({ onEvent: (event) => void events.push(event) });
    seq.next('one');
    seq.next('two', () => ({ n: 1 }));
    seq.next('three', () => ({ n: 2 }));
    seq.end();
    expect(events.map((e) => (e.type === 'phase' ? e.name : ''))).toEqual(['one', 'two', 'three']);
  });

  it('swallows sink exceptions', () => {
    const sink = {
      onEvent: () => {
        throw new Error('sink failure');
      },
    };
    expect(() => emitDiagnostic(sink, { type: 'phase', name: 'p', durationMs: 1 })).not.toThrow();
    expect(withPhase(sink, 'p', () => 3)).toBe(3);
    const seq = createPhaseSequence(sink);
    expect(() => {
      seq.next('a');
      seq.end();
    }).not.toThrow();
  });

  it('does not read a clock or run counters without a sink', () => {
    const now = vi.spyOn(performance, 'now');
    const date = vi.spyOn(Date, 'now');
    const counters = vi.fn();
    expect(withPhase(undefined, 'p', () => 1, counters)).toBe(1);
    const seq = createPhaseSequence(undefined);
    seq.next('a', counters);
    seq.end(counters);
    expect(createPhaseSequence(undefined)).toBe(seq);
    expect(now).not.toHaveBeenCalled();
    expect(date).not.toHaveBeenCalled();
    expect(counters).not.toHaveBeenCalled();
  });
});
