# R3: SQL rewrites in `composer-sqlite.ts`

Content-free: counts, timings and query plans only. Snapshot, tooling and noise caveats are as in
`baseline-0.19.0.md`. Timings below are single runs on a busy laptop whose OS file cache does not hold the 7 GB
file; treat differences under about 2x as noise.

## What changed

| Area | Before | After |
| --- | --- | --- |
| Admission byte length | `length(CAST(value AS BLOB))` (loads the whole value, including overflow chains) | `octet_length(value)` (record header only), feature-detected once per connection; the old expression is the fallback |
| Rowid-ordered metadata pages (#2, #4, #5) | key-range index search plus `USE TEMP B-TREE FOR ORDER BY` on every page, quadratic in range size | one covering key keyset stream (`key >= ? / key > ? AND key < ? ORDER BY key`), rows sorted by rowid in JS, then admitted in the same pages |
| First / last bubble (#7a/#7b) | `ORDER BY rowid LIMIT 1` over the whole prefix (temp b-tree, every bubble projected) | `min(rowid)` / `max(rowid)` over the covering index range, then one rowid point read |
| Value reads | one `WHERE rowid = ? AND key = ? COLLATE BINARY` read per row (about 23k per unscoped list) | batches of up to 64 rows / 4 MiB declared bytes in one `VALUES` join on `(rowid, key)`, same per-row checks and charges |
| Connection pragmas | none beyond `case_sensitive_like = ON` | none added (see "Pragmas") |

## `octet_length` equivalence

`tests/unit/composer-sqlite-rewrites.test.ts` compares `octet_length(value)` with `length(CAST(value AS BLOB))`
(and the `COALESCE(..., 0)` forms) on both drivers (better-sqlite3 3.53.2, node:sqlite 3.53.4) and for UTF-8,
UTF-16le and UTF-16be databases. Rows: ASCII and multibyte TEXT, TEXT with embedded NULs, `''`, empty BLOB, BLOB
with NUL/0xFF bytes, NULL, INTEGER (0, negative, 12345, above 2^53 as bigint), REAL (1.5, 1e300, -0.0, 3.0), a 2 MB
TEXT and a 3 MB BLOB (overflow chains). Result: **identical for every row and class**, including numerics (SQLite
renders a number in its text form for both) and NULL (NULL for both; `COALESCE` gives 0 for both). No `CASE
typeof(value)` expression is needed.

Detection: each driver runs `SELECT octet_length(x'0001')` once when the connection opens and exposes
`composerReadCapabilities = { octetLength, byteExactLike }` on the `Database` object (`byteExactLike` records that
`PRAGMA case_sensitive_like = ON` succeeded). `ObservedDatabase` forwards the property. A connection without the
property (test doubles, wrappers, SQLite older than 3.43, a failed pragma) runs the released SQL byte for byte, so the
existing mock-based unit tests keep exercising the old statements.

Measured on the snapshot (better-sqlite3, pages of 256, global `bubbleId:` key range, all 165,120 rows): length only
via `octet_length(value)` 2.0 s (`COALESCE(octet_length(value), 0)` 2.1 s), versus 37.2 s for
`length(CAST(value AS BLOB))` in the baseline (the old expression was only sampled to 5,000 rows here: 0.28 s warm).
In the end-to-end paths the saving is the overflow reads, about 2x on per-composer metadata pages (A/B below).

## Decision per rowid-ordered statement

Callers: all in `storage.ts` (read only), plus `migrate.ts` and `backup.ts` through the same exported functions.
"Order needed" means a caller consumes rows in insertion order (message order, first/last bubble for preview,
`records` order feeding later merges), so the output order must stay rowid order.

| # | Statement / exported function | Callers | Order needed? | Decision |
| --- | --- | --- | --- | --- |
| 1 | `getBoundedComposerMetadataByKey` (`key = ? COLLATE BINARY`) | storage, migrate | n/a | length projection only |
| 2a | `forEachBoundedComposerMetadata` / `forEachBoundedComposerValue`, `composerData:%` | storage (`loadGlobalComposerRecords`, membership, ids), migrate, backup | Yes: callers collect records in iteration order | key-range gather + JS sort by rowid, pages and budget identical |
| 2c | same, ItemTable `%composerChatViewPane%` | storage | Yes (kept) | unchanged shape (leading wildcard; tables are tiny); only the length projection changes |
| 3 | `forEachBoundedComposerKeyMetadata` | storage, migrate | No (key sets) | unchanged (already a covering key keyset) |
| 4 | `forEachBoundedComposerBubbleMetadata` / `...BubbleValue`, `bubbleId:%` | none in `src/` (public helper) | Yes | key-range gather + JS sort, same as 2a |
| 5 | `forEachBoundedComposerBubbleMetadataByExactPrefix` / `...ValueByExactPrefix` | storage (counts, messages, timestamps), many | Yes: messages are produced in rowid order | per-prefix key-range gather + JS sort by rowid; GLOB kept as a residual predicate |
| 5b | exact prefix containing NUL, empty prefix, lone surrogate, prefix whose upper bound does not exist | storage | Yes | released `substr(CAST(key AS BLOB), ...)` / GLOB paged statement, unchanged (NUL fallback preserved) |
| 7a | `readFirstBoundedComposerBubbleValueByExactPrefix` | storage (preview) | Yes (first by rowid) | `min(rowid)` over the covering range, then rowid read |
| 7b | `readLastBoundedComposerBubbleValueByExactPrefix` | storage | Yes (last by rowid) | `max(rowid)` likewise |
| 7c | `readFirstBoundedComposerBubbleValue` (LIKE), `readFirstBoundedComposerValue` | none in `src/` | Yes | unchanged shape, length projection only |
| 9 | value point reads (`readAdmitted*`) | all iterators | n/a | batched join for iterator pages; single-row paths (`readBoundedComposerValueByKey`, first/last) keep the point read |

Why gather-and-sort rather than `ORDER BY rowid` per page: a gather costs one stream of the key range (the same
index pages the old statement touched) and one JS sort of `(rowid, key, length, null-state)` tuples; the old
statement re-sorted the remaining range for every page. The gather is bounded: it holds at most
`min(1,000,000, remaining sqliteRowCount budget + 1)` rows, and if the range is larger it discards the gathered rows
before charging anything and runs the released paged statement, so over-limit failures (row count, page bytes, value
bytes) are raised from the same page with the same message (tested).

Key ranges use the existing #3 helper logic (`prefixUpperBound`, extracted from `likePrefixRange` with identical
behavior, including stepping back past U+FFFF code units). Because a byte-prefix `[lower, upper)` range is only a
superset when the strings bind as valid UTF-8, ranges containing a lone surrogate, an empty prefix or a NUL fall back
to the released statement. All range comparisons carry `COLLATE BINARY`, so a table whose `key` has another collation
still returns the released rows (slower). The released `LIKE`/`GLOB` predicate stays in the `WHERE` as a residual
filter, so the result is the intersection of the range and the released predicate; the range only narrows work.

Residual risk accepted: a stored BLOB-typed key (not TEXT) that the released GLOB would have matched sorts outside
the TEXT key range and is no longer returned. Cursor keys are TEXT; the real schema declares `key TEXT`.

## Batched value reads

`WITH w(i, r, k) AS (VALUES (?,?,?), ...) SELECT w.i, t.key, CAST(t.value AS BLOB) AS value[, t.value IS NULL] FROM w
JOIN <table> AS t ON t.rowid = w.r AND t.key = w.k COLLATE BINARY` (plan: `CO-ROUTINE w`, `SCAN w`,
`SEARCH t USING INTEGER PRIMARY KEY (rowid=?)`). The identity check `key = ? COLLATE BINARY` is still evaluated by
SQLite for every row, so a row whose key bytes changed is absent and is reported with the same
"changed after metadata admission" error as before.

- A batch is at most 64 rows and 4 MiB of declared bytes (always at least one row), taken in page order lazily when
  the consumer reaches the first row of the batch.
- Per-row admission is unchanged: metadata pages are admitted (`admitMetadataPage`) before any value is read; each row
  is then checked (key, null-state, byte length equals the admitted length) and charged with `admitDecodedValue` when
  its turn comes, in order, so a limit failure stops at the same row. Prefetched but unconsumed rows are never charged.
- Concurrency note: a row mutated by another writer while the consumer is still inside the same batch is read from the
  newer-but-earlier prefetch; any mismatch with the admitted length or key is still detected when the row is consumed
  (the live-source race existed before and was only narrower).

## IoObserver / `observed.ts`

- `selectsRawPayload` strips `octet_length(value|data)` alongside the existing `length(CAST(...))` so a length-only
  projection is still catalog metadata (`global-bubble-index` / `global-composer-membership`) and not a payload read.
- Batched reads are classified `global-bubble` / `global-composer` as before (they project `CAST(t.value AS BLOB)`).
  Because a batch carries several `bubbleId:` keys as parameters, the logical session id is taken from the first one,
  which is the page's composer; event counts drop (one `query` + one `get` per batch instead of per row). Prepared
  batch statements are cached per size inside one iteration, so `prepare` events are bounded by the number of distinct
  batch sizes (at most 64) per iteration.
- Metadata statements now also emit `prepare`/`query` for the gather (two prepares per iteration, one `query` per
  1,024-row key page) instead of one `query` per admission page.

## Pragmas (read-only source connections)

Measured with an ad hoc content-free probe (scratch script, not committed) on the snapshot, better-sqlite3, 137 composers
(about 29.8k bubbles) read twice in one process, 2-3 rounds each, fresh process per run. Setter pragmas must be
executed with `exec`; they were applied that way.

| Pragma | Values pass (first read) | Second pass over the same rows | Global `bubbleId:` key stream | Verdict |
| --- | --- | --- | --- | --- |
| baseline | 4.9-5.8 s | 2.2-2.3 s (3.3 s once, noisy) | 0.45-0.59 s | |
| `mmap_size = 256 MiB` | 5.1-5.8 s | 2.1-2.3 s | 0.44-0.47 s | no measurable effect |
| `temp_store = MEMORY` | 4.8-5.3 s | 1.9-2.4 s | 0.37-0.50 s | no effect (no temp b-trees remain) |
| `query_only = 1` | 4.6-5.6 s | 2.1-2.9 s | 0.48-0.52 s | no effect (connections are already `readonly`) |
| `cache_size = -16384 / -65536` (16 / 64 MiB) | no change | 2.2-2.5 s | no change | no effect |
| `cache_size = -131072 / -262144` (128 / 256 MiB) | 5.4-5.7 s | 1.6-1.9 s | no change | only speeds up re-reads of the same pages |

Nothing was adopted. The only effect (`cache_size` of at least 128 MiB) helps a second pass over a working set that
no longer fits the default 2 MB cache; R2 removes those duplicate passes, and a 128-256 MiB cache would raise peak
memory for every CLI/MCP run. No pragma was applied to any writable connection and nothing writes to the source.

## Plans (snapshot schema, EXPLAIN QUERY PLAN)

| Statement | Old | New |
| --- | --- | --- |
| #5 exact-prefix page | `SEARCH ... USING INDEX sqlite_autoindex_cursorDiskKV_1 (key>? AND key<?)` + `USE TEMP B-TREE FOR ORDER BY` per page | `SEARCH ... USING INDEX sqlite_autoindex_cursorDiskKV_1 (key>? AND key<?)`, no sort |
| #2 / #4 `LIKE` page | index range + `USE TEMP B-TREE FOR ORDER BY` per page | `SEARCH ... USING INDEX sqlite_autoindex_cursorDiskKV_1 (key>? AND key<?)`, no sort |
| #7a/#7b first/last | index range + `USE TEMP B-TREE FOR ORDER BY` (LIMIT 1) | `SEARCH ... USING COVERING INDEX ... (key>? AND key<?)` for `min`/`max(rowid)`, then `SEARCH ... USING INTEGER PRIMARY KEY (rowid=?)` |
| #9 point read | `SEARCH ... USING INTEGER PRIMARY KEY (rowid=?)` per row | `CO-ROUTINE w`, `SCAN w`, `SEARCH t USING INTEGER PRIMARY KEY (rowid=?)` per batch |
| #1 exact key | `SEARCH ... USING INDEX ... (key=?)` | unchanged plan, header-only length |

`tests/unit/composer-sqlite-rewrites.test.ts` asserts that no recorded new statement plans a TEMP B-TREE.

## Micro A/B (same process, same 114 composers, 3 rounds; "old" = released SQL via a capability-stripped wrapper)

| Operation (per 114 composers, about 30k bubbles) | Old | New |
| --- | --- | --- |
| first bubble | 139-161 ms | 85-146 ms |
| last bubble | 96-296 ms | 71-145 ms |
| bubble metadata (count) | 4.6-6.6 s | 2.4-2.9 s |
| bubble values | 9.5-13.3 s | 4.8-6.6 s |

The remaining per-row cost is table-leaf page reads for each bubble (the table is 7 GB; the row header still has to
be visited to read the length and null state).

## End-to-end, snapshot, `--profile` (default driver, empty Store root)

SQL totals are the sum of per-fingerprint time in the profile. Single runs; the OS cache state differed between runs
(phase B alone varied between 6.6 and 10.5 s across otherwise identical runs).

| Scenario | Before wall | After wall | Before SQL | After SQL | Top statements after |
| --- | --- | --- | --- | --- | --- |
| unscoped `list -n 5` | 23.9 s (sum of phases: B 10.5, C 1.1, D 12.1) | 16.2 s (B 6.7, C 0.5, D 8.9) | 14.1 s | 7.8 s | key stream `bubbleId:` pages 2.1 s; bubble exact-prefix gather 1.5 s; first-bubble `min(rowid)` 0.6 s; batched value reads 0.55 s |
| scoped `-w <ws> list -n 5` | 12.8 s | 6.4 s | 9.7 s | 3.9 s | workspace-id `json_extract` projection 1.1 s; bubble gather 0.9 + 0.5 s; key stream 0.8 s |
| `show 1` | 19.5 s | 20.5 s | 10.9 s | 9.6 s | gather 2.2 s; key stream 2.0 s; batched reads 1.0 s; `min(rowid)` 0.9 s (cold cache on the after run) |
| `search function` | 82.3 s | 73.7 s | 43.1 s | 24.6 s | batched value reads 7.2 s; bubble exact-prefix gather 6.3 s + 4.4 s (two passes, R2 merges them); `bubbleId:` key stream 1.1 s | |

Statement counts: the 44,264 single-row bubble reads of an unscoped list become 322 batched statements (about 11k
rows) plus 460 point reads that remain for single-row paths; per-composer metadata pages that planned a TEMP B-TREE
(24 `composerData` pages, 1,652 bubble pages) are gone.

Output parity: stdout of `list -n 5`, scoped list, `show 1` and `search function` is byte-identical between the
released build (built from `HEAD` in a scratch copy) and this build. `search function` completed with exit code 0 on
this snapshot in both builds (10 sessions, no `SessionAmbiguityError` at this commit).

Non-SQL time dominates what is left: of the 73.7 s search, about 49 s is outside SQL (JSON parsing of 186k bubbles,
snippet extraction), and the unscoped list spends about 8 s outside SQL. The wall-clock rows for `list` mix cache
warmth (B varied 6.6-10.5 s in identical runs), so use the SQL columns for the effect of this workstream.

## Risks and follow-ups

- The gather materializes `(rowid, key, length, null-state)` for a prefix range (at most 1M rows, then the released
  statement). Memory is about 100 bytes per row.
- First/last now use two statements; on cold caches this is about the same wall time as the old single statement
  (the old one also touched every bubble row). R2 should reuse the gathered per-composer rows (count, first, last)
  instead of reading the prefix three times.
- `count` (metadata admission) still visits each bubble's table row only to read its length; a covering-index count
  would need the budget to admit byte lengths another way and is outside this workstream.
- Value batches rely on `WITH ... VALUES` joins; SQLite 3.8.3+ supports them, so no capability flag is needed.
- Pragmas were not adopted; revisit if R2's single-pass design leaves a re-read working set.
