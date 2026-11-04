import { describe, expect, it } from 'vitest';

import {
  createComposerSqliteBudget,
  forEachBoundedComposerBubbleMetadataByExactPrefix,
  forEachBoundedComposerBubbleValue,
  forEachBoundedComposerBubbleValueByExactPrefix,
  forEachBoundedComposerMetadata,
  forEachBoundedComposerValue,
  getBoundedComposerMetadataByKey,
  readFirstBoundedComposerBubbleValueByExactPrefix,
  readLastBoundedComposerBubbleValueByExactPrefix,
} from '../../src/core/composer-sqlite.js';
import { betterSqlite3Driver } from '../../src/core/database/drivers/better-sqlite3.js';
import { nodeSqliteDriver } from '../../src/core/database/drivers/node-sqlite.js';
import type { Database, DatabaseDriver } from '../../src/core/database/types.js';
import { resolveSourceReadLimits } from '../../src/core/source-read-limits.js';

const drivers: DatabaseDriver[] = [];
for (const driver of [betterSqlite3Driver, nodeSqliteDriver]) {
  if (await driver.isAvailable()) drivers.push(driver);
}

// Frozen released SQL: the oracle. It never uses octet_length, key ranges or batching.
const RELEASED_PREFIX =
  'key IS NOT NULL AND substr(CAST(key AS BLOB), 1, length(CAST(? AS BLOB))) = CAST(? AS BLOB)';
const RELEASED_BUBBLE_ORACLE = `SELECT CAST(cursorDiskKV.rowid AS TEXT) AS rowId, key, COALESCE(length(CAST(value AS BLOB)), 0) AS byteLength, CAST(value AS BLOB) AS value, value IS NULL AS valueIsNull FROM cursorDiskKV WHERE`;

interface OracleRow {
  rowId: string;
  key: string;
  byteLength: number;
  value: string | null;
}

function oracleRows(
  db: Database,
  where: string,
  params: unknown[],
  table = 'cursorDiskKV',
  skipNull = false
): OracleRow[] {
  const sql = `SELECT CAST(${table}.rowid AS TEXT) AS rowId, key, COALESCE(length(CAST(value AS BLOB)), 0) AS byteLength, CAST(value AS BLOB) AS value FROM ${table} WHERE ${where}${
    skipNull ? ' AND value IS NOT NULL' : ''
  } ORDER BY ${table}.rowid ASC`;
  return (
    db.prepare(sql).all(...params) as Array<{
      rowId: string;
      key: string;
      byteLength: number;
      value: Uint8Array | null;
    }>
  ).map((row) => ({
    rowId: row.rowId,
    key: row.key,
    byteLength: Number(row.byteLength),
    value: row.value === null ? null : Buffer.from(row.value).toString('utf8'),
  }));
}

/** The same connection with every Composer read capability hidden, so the released SQL runs. */
function withoutCapabilities(db: Database): Database {
  return {
    prepare: (sql) => db.prepare(sql),
    runSQL: (sql) => db.runSQL(sql),
    close: () => db.close(),
  };
}

function seedCorpus(db: Database): void {
  db.runSQL('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  db.runSQL('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  const insert = db.prepare('INSERT INTO cursorDiskKV(rowid, key, value) VALUES (?, ?, ?)');
  const ids = [
    'ABC',
    'abc',
    'Abc',
    'a%b',
    'a_b',
    'a\\b',
    'a*b',
    'a?b',
    '[x]',
    'é',
    'é',
    '中文😀',
    'a\0b',
    'a\0',
    'z',
    'Z',
    '~',
    '￿',
    'a￿',
    'a￿￿',
    'x퟿',
    'y😀',
    'same',
    'same-longer',
  ];
  // Rowids deliberately run against key order, with one id above 2^53.
  let rowId = 5000n;
  let index = 0;
  for (const id of ids) {
    for (const suffix of ['z', 'a', 'm', 'b']) {
      const value =
        suffix === 'a'
          ? null
          : suffix === 'b'
            ? [12345, 1.5, '', Buffer.alloc(0), 'a\0tail', Buffer.from('blob-é')][index++ % 6]
            : JSON.stringify({ id, suffix, pad: 'x'.repeat((index * 37) % 400) });
      insert.run(rowId--, `bubbleId:${id}:${suffix}`, value);
    }
  }
  insert.run(9007199254740993n, 'bubbleId:ABC:big-rowid', 'large');
  insert.run(-3n, 'bubbleId:ABC:negative-rowid', 'negative');
  insert.run(rowId--, 'bubbleId:ABC-extra:decoy', 'decoy');
  insert.run(rowId--, 'BUBBLEID:abc:upper', 'case variant of the namespace');
  for (let n = 0; n < 12; n++) {
    insert.run(rowId--, `composerData:id-${(n * 7) % 12}`, n % 5 === 0 ? null : `{"n":${n}}`);
  }
  insert.run(rowId--, 'COMPOSERDATA:id-0', '{"case":"variant"}');
  insert.run(rowId--, 'composerDatb:id-0', '{"neighbour":true}');
  // Many bubbles for one composer so batches and admission pages cross boundaries.
  for (let n = 0; n < 150; n++) {
    insert.run(rowId--, `bubbleId:many:${String((n * 7919) % 150).padStart(3, '0')}`, `{"n":${n}}`);
  }
  // Large values: overflow chains and the 4 MiB prefetch bound.
  for (let n = 0; n < 4; n++) {
    insert.run(rowId--, `bubbleId:big:${n}`, 'g'.repeat(1_500_000));
  }
  db.prepare('INSERT INTO ItemTable(key, value) VALUES (?, ?)').run(
    'workbench.composerChatViewPane.x',
    '{"composerId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}'
  );
}

const exactPrefixes = [
  ...[
    'ABC',
    'abc',
    'a%b',
    'a_b',
    'a\\b',
    'a*b',
    'a?b',
    '[x]',
    'é',
    'é',
    '中文😀',
    'a\0b',
    'z',
    'Z',
    '~',
    '￿',
    'a￿',
    'a￿￿',
    'x퟿',
    'y😀',
    'same',
    'many',
    'big',
    'missing',
  ].map((id) => `bubbleId:${id}:`),
  'bubbleId:',
  'bubbleId:A',
  'bubbleId:a',
  'bubbleId:same',
  'bubbleId:￿',
  'bubbleId:a￿',
  'bubbleId:z',
  'bubbleId:Z',
  'bubbleId:x퟿',
  'bubbleId:y\ud83d',
  'bubbleId:lone\ud800',
  'bubbleId:ABC:',
  '',
  'bubbleId:\0',
];

const likePatterns = [
  'composerData:%',
  'bubbleId:%',
  'bubbleId:a%',
  'bubbleId:ABC%',
  'bubbleId:￿%',
  'bubbleId:a￿%',
  'bubbleId:a\\_b%',
  'bubbleId:a\\%b%',
  'bubbleId:a\\\\b%',
  'bubbleId:a_b%',
  'composerData:id-1%',
  'nothing:%',
  '%',
  'bubbleId:many:001',
];

for (const driver of drivers) {
  describe(`R3 SQL rewrites / ${driver.name}`, () => {
    describe('octet_length equals length(CAST(value AS BLOB))', () => {
      for (const encoding of ['UTF-8', 'UTF-16le', 'UTF-16be']) {
        it(`for every storage class and large overflow values (${encoding})`, () => {
          const db = driver.open(':memory:', { readonly: false });
          try {
            db.runSQL(`PRAGMA encoding = '${encoding}'`);
            db.runSQL('CREATE TABLE t (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
            const insert = db.prepare('INSERT INTO t(key, value) VALUES (?, ?)');
            const values: unknown[] = [
              'plain ascii',
              'héllo 中文 😀',
              'a\0b\0',
              '\0',
              '',
              Buffer.alloc(0),
              Buffer.from([0, 1, 2, 255, 0]),
              null,
              0,
              -7,
              12345,
              9007199254740993n,
              1.5,
              1e300,
              -0.0,
              3.0,
              'x'.repeat(2_000_000),
              Buffer.alloc(3_000_000, 7),
              '퟿￿',
            ];
            values.forEach((value, index) => insert.run(`k${index}`, value));
            const rows = db
              .prepare(
                'SELECT typeof(value) AS storageClass, length(CAST(value AS BLOB)) AS released, octet_length(value) AS fast, COALESCE(octet_length(value), 0) AS fastCoalesced, COALESCE(length(CAST(value AS BLOB)), 0) AS releasedCoalesced FROM t ORDER BY rowid'
              )
              .all() as Array<Record<string, unknown>>;
            expect(rows).toHaveLength(values.length);
            const classes = new Set(rows.map((row) => row['storageClass']));
            expect([...classes].sort()).toEqual(['blob', 'integer', 'null', 'real', 'text']);
            for (const row of rows) {
              expect(Number(row['fast'] ?? -1), JSON.stringify(row)).toBe(
                Number(row['released'] ?? -1)
              );
              expect(Number(row['fastCoalesced'])).toBe(Number(row['releasedCoalesced']));
            }
            expect(db.composerReadCapabilities?.octetLength).toBe(true);
          } finally {
            db.close();
          }
        });
      }
    });

    describe('iterators match the released SQL', () => {
      const open = (): Database => {
        const db = driver.open(':memory:', { readonly: false });
        seedCorpus(db);
        return db;
      };

      it('declares capabilities on the real driver connection', () => {
        const db = open();
        try {
          expect(db.composerReadCapabilities).toEqual({ octetLength: true, byteExactLike: true });
        } finally {
          db.close();
        }
      });

      it('returns the same rows, order and budget for exact-prefix bubble reads', () => {
        const db = open();
        try {
          for (const prefix of exactPrefixes) {
            const expected = oracleRows(db, RELEASED_PREFIX, [prefix, prefix]);
            for (const pageRows of [1, 2, 7, 64, 256]) {
              const limits = resolveSourceReadLimits({ sqlitePageRows: pageRows });
              const budget = createComposerSqliteBudget(limits);
              const seen: OracleRow[] = [];
              forEachBoundedComposerBubbleValueByExactPrefix(db, prefix, budget, (row) =>
                seen.push({
                  rowId: String(row.rowId),
                  key: row.key,
                  byteLength: row.byteLength,
                  value: row.value,
                })
              );
              expect(seen, JSON.stringify({ prefix, pageRows })).toEqual(expected);
              expect(budget.rowCount).toBe(expected.length);
              expect(budget.decodedBytes).toBe(
                expected.reduce((total, row) => total + row.byteLength, 0)
              );

              const legacy = createComposerSqliteBudget(limits);
              const legacySeen: string[] = [];
              forEachBoundedComposerBubbleValueByExactPrefix(
                withoutCapabilities(db),
                prefix,
                legacy,
                (row) => legacySeen.push(row.key)
              );
              expect(legacySeen).toEqual(seen.map((row) => row.key));
              expect([legacy.rowCount, legacy.decodedBytes]).toEqual([
                budget.rowCount,
                budget.decodedBytes,
              ]);
            }

            const first = readFirstBoundedComposerBubbleValueByExactPrefix(
              db,
              prefix,
              createComposerSqliteBudget()
            );
            const last = readLastBoundedComposerBubbleValueByExactPrefix(
              db,
              prefix,
              createComposerSqliteBudget()
            );
            expect(first && [String(first.rowId), first.key, first.value]).toEqual(
              expected[0] && [expected[0].rowId, expected[0].key, expected[0].value]
            );
            expect(last && [String(last.rowId), last.key, last.value]).toEqual(
              expected.at(-1) && [
                expected.at(-1)!.rowId,
                expected.at(-1)!.key,
                expected.at(-1)!.value,
              ]
            );
          }
        } finally {
          db.close();
        }
      });

      it('returns the same metadata for exact-prefix bubble metadata reads', () => {
        const db = open();
        try {
          for (const prefix of exactPrefixes) {
            const expected = oracleRows(db, RELEASED_PREFIX, [prefix, prefix]);
            const seen: Array<[string, string, number, boolean]> = [];
            const budget = createComposerSqliteBudget(
              resolveSourceReadLimits({ sqlitePageRows: 5 })
            );
            forEachBoundedComposerBubbleMetadataByExactPrefix(db, prefix, budget, (m) =>
              seen.push([String(m.rowId), m.key, m.byteLength, m.valueIsNull])
            );
            expect(seen, prefix).toEqual(
              expected.map((row) => [row.rowId, row.key, row.byteLength, row.value === null])
            );
          }
        } finally {
          db.close();
        }
      });

      it('returns the same rows, order and budget for LIKE-pattern reads', () => {
        const db = open();
        try {
          for (const pattern of likePatterns) {
            const bubbleExpected = oracleRows(db, "key LIKE ? ESCAPE '\\'", [pattern]);
            const kvExpected = oracleRows(
              db,
              "key LIKE ? ESCAPE '\\'",
              [pattern],
              'cursorDiskKV',
              true
            );
            for (const pageRows of [1, 3, 256]) {
              const limits = resolveSourceReadLimits({ sqlitePageRows: pageRows });
              const bubbleBudget = createComposerSqliteBudget(limits);
              const bubbles: OracleRow[] = [];
              forEachBoundedComposerBubbleValue(db, pattern, bubbleBudget, (row) =>
                bubbles.push({
                  rowId: String(row.rowId),
                  key: row.key,
                  byteLength: row.byteLength,
                  value: row.value,
                })
              );
              expect(bubbles, JSON.stringify({ pattern, pageRows })).toEqual(bubbleExpected);

              const kvBudget = createComposerSqliteBudget(limits);
              const kv: OracleRow[] = [];
              forEachBoundedComposerValue(db, 'cursorDiskKV', pattern, kvBudget, (row) =>
                kv.push({
                  rowId: String(row.rowId),
                  key: row.key,
                  byteLength: row.byteLength,
                  value: row.value,
                })
              );
              expect(kv, JSON.stringify({ pattern, pageRows })).toEqual(kvExpected);
              expect(kvBudget.rowCount).toBe(kvExpected.length);

              const meta: Array<[string, number]> = [];
              forEachBoundedComposerMetadata(
                db,
                'cursorDiskKV',
                pattern,
                createComposerSqliteBudget(limits),
                (m) => meta.push([m.key, m.byteLength])
              );
              expect(meta).toEqual(kvExpected.map((row) => [row.key, row.byteLength]));
            }
          }
          // ItemTable keeps the contains-pattern path.
          const items: string[] = [];
          forEachBoundedComposerValue(
            db,
            'ItemTable',
            '%composerChatViewPane%',
            createComposerSqliteBudget(),
            (row) => items.push(row.key)
          );
          expect(items).toEqual(['workbench.composerChatViewPane.x']);
        } finally {
          db.close();
        }
      });

      it('reports the same metadata for an exact key across storage classes', () => {
        const db = open();
        try {
          for (const [key] of db
            .prepare('SELECT key FROM cursorDiskKV')
            .all()
            .map((row) => [(row as { key: string }).key])) {
            const expected = oracleRows(db, 'key = ? COLLATE BINARY', [key], 'cursorDiskKV', true);
            const budget = createComposerSqliteBudget();
            const metadata = getBoundedComposerMetadataByKey(db, 'cursorDiskKV', key, budget);
            expect(metadata && [String(metadata.rowId), metadata.byteLength]).toEqual(
              expected[0] && [expected[0].rowId, expected[0].byteLength]
            );
          }
        } finally {
          db.close();
        }
      });

      it('charges the same limit failures as the released SQL', () => {
        const db = open();
        try {
          const cases = [
            { sqliteRowCount: 10, sqlitePageRows: 5 },
            { sqliteRowCount: 150, sqlitePageRows: 20 },
            { sqliteValueBytes: 1_000_000, sqlitePageBytes: 2_000_000 },
            {
              sqliteValueBytes: 2_000_000,
              sqlitePageBytes: 4_000_000,
              sqliteDecodedBytes: 4_000_000,
            },
            {
              sqliteValueBytes: 2_000_000,
              sqlitePageBytes: 8_000_000,
              sqliteDecodedBytes: 8_000_000,
            },
          ];
          for (const prefix of ['bubbleId:many:', 'bubbleId:big:', 'bubbleId:']) {
            for (const override of cases) {
              const run = (target: Database) => {
                const budget = createComposerSqliteBudget(resolveSourceReadLimits(override));
                const keys: string[] = [];
                let message = '';
                try {
                  forEachBoundedComposerBubbleValueByExactPrefix(target, prefix, budget, (row) =>
                    keys.push(row.key)
                  );
                } catch (error) {
                  message = (error as Error).message;
                }
                return { keys, message, rows: budget.rowCount, bytes: budget.decodedBytes };
              };
              expect(run(db), JSON.stringify({ prefix, override })).toEqual(
                run(withoutCapabilities(db))
              );
            }
          }
        } finally {
          db.close();
        }
      });

      it('detects a row whose identity changes after admission, in a later batch', () => {
        for (const mutate of [
          (db: Database) => db.prepare("UPDATE cursorDiskKV SET key = 'moved' WHERE key = ?"),
          (db: Database) => db.prepare("UPDATE cursorDiskKV SET value = 'short' WHERE key = ?"),
          (db: Database) => db.prepare('UPDATE cursorDiskKV SET value = 7 WHERE key = ?'),
        ]) {
          const outcomes: string[] = [];
          for (const hide of [false, true]) {
            const db = open();
            try {
              const target = hide ? withoutCapabilities(db) : db;
              const statement = mutate(db);
              let first = true;
              let message = '';
              try {
                forEachBoundedComposerBubbleValueByExactPrefix(
                  target,
                  'bubbleId:many:',
                  createComposerSqliteBudget(),
                  () => {
                    if (!first) return;
                    first = false;
                    // Row 100 is in the third batch of 64, so no prefetch has read it yet.
                    statement.run('bubbleId:many:100');
                  }
                );
              } catch (error) {
                message = (error as Error).message;
              }
              outcomes.push(message);
            } finally {
              db.close();
            }
          }
          expect(outcomes[0]).toMatch(/changed after metadata admission/u);
          expect(outcomes[0]).toBe(outcomes[1]);
        }
      });

      it('honors cancellation between batched rows', () => {
        const db = open();
        try {
          const controller = new AbortController();
          let seen = 0;
          expect(() =>
            forEachBoundedComposerBubbleValueByExactPrefix(
              db,
              'bubbleId:many:',
              createComposerSqliteBudget(),
              () => {
                if (++seen === 3) controller.abort();
              },
              controller.signal
            )
          ).toThrow(/aborted/iu);
          expect(seen).toBe(3);
        } finally {
          db.close();
        }
      });
    });

    describe('query plans', () => {
      it('use no TEMP B-TREE and read values by rowid in batches', () => {
        const db = driver.open(':memory:', { readonly: false });
        try {
          seedCorpus(db);
          const recorded: Array<{ sql: string; params: unknown[] }> = [];
          const spy: Database = {
            composerReadCapabilities: db.composerReadCapabilities,
            prepare(sql) {
              const statement = db.prepare(sql);
              const record = (params: unknown[]) => recorded.push({ sql, params });
              return {
                get: (...params) => (record(params), statement.get(...params)),
                all: (...params) => (record(params), statement.all(...params)),
                run: (...params) => statement.run(...params),
              };
            },
            runSQL: (sql) => db.runSQL(sql),
            close: () => db.close(),
          };
          const budget = createComposerSqliteBudget();
          forEachBoundedComposerBubbleValueByExactPrefix(spy, 'bubbleId:many:', budget, () => {});
          forEachBoundedComposerValue(spy, 'cursorDiskKV', 'composerData:%', budget, () => {});
          readFirstBoundedComposerBubbleValueByExactPrefix(spy, 'bubbleId:many:', budget);
          readLastBoundedComposerBubbleValueByExactPrefix(spy, 'bubbleId:many:', budget);
          expect(recorded.length).toBeGreaterThan(4);
          for (const { sql, params } of recorded) {
            const plan = (
              db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>
            )
              .map((row) => row.detail)
              .join('\n');
            expect(plan, sql).not.toMatch(/TEMP B-TREE/u);
            if (/JOIN cursorDiskKV|FROM w JOIN/u.test(sql)) {
              expect(plan, sql).toMatch(/INTEGER PRIMARY KEY|rowid=\?/u);
            }
          }
          // 150 rows at the default 256-row page: batches of 64, 64 and 22 values.
          const batchCalls = recorded.filter(({ sql }) => sql.startsWith('WITH w'));
          expect(batchCalls.length).toBeGreaterThanOrEqual(3);
        } finally {
          db.close();
        }
      });
    });
  });
}
