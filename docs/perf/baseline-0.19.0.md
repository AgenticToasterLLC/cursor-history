# cursor-history 0.19.0 performance baseline

Content-free: counts, sizes, timings and query plans only. Raw JSON lives in
`%LOCALAPPDATA%/cursor-history-perf/results/` (not committed). Reproduce with `docs/perf/README.md`.

## Environment

| Item | Value |
| --- | --- |
| CPU | Intel Core i7-8650U @ 1.90 GHz (4 cores / 8 threads) |
| RAM | 17.1 GB |
| Disk | Samsung KUS040202M NVMe SSD (`Get-PhysicalDisk`: SSD / NVMe), 512 GB, C: ~53 GB free before snapshot |
| OS / Node | Windows 10 Pro 10.0.19045, Node v24.22.2 |
| SQLite | better-sqlite3 -> 3.53.2, node:sqlite -> 3.53.4 (`select sqlite_version()`) |
| Default driver | The library auto-selects `node:sqlite`; explain probes ran on better-sqlite3 (full) and node:sqlite (plans/prefix/points/workspaces) |
| Library | `dist/lib/index.js`, v0.19.0, `CURSOR_STORE_ROOT` pointed at an empty dir so the real `~/.cursor` is never read |

Measurement noise: timings were taken on a laptop while other processes ran, and the OS file cache
state varied between runs (the 7 GB file does not fit in RAM). Treat differences under about 2x as noise.
Runs overlapping the snapshot copy were discarded or flagged (a first medium run overlapped it and was
repeated).

## Real-data snapshot

Method: SQLite online backup API from a read-only connection (`readonly: true`, `fileMustExist: true`),
one step with an unbounded page count so it copies under a single read snapshot. No restarts occurred, so the
`VACUUM INTO` fallback was not needed. Layout is page-for-page identical to the original.

| Item | Value |
| --- | --- |
| Global DB | 7,262,617,600 bytes, 1,773,100 pages x 4096 B, freelist 332, WAL mode (source WAL was 848,752 B) |
| Backup duration | 389.6 s (global); 616.5 s total including hashing source (60 s) and snapshot (163 s) |
| Workspace DBs | 106 `state.vscdb` (13.3 MB total, all backed up), 106 `workspace.json` copied |
| Source sha256 (main file, before copy) | `0f298ffdbd3e9676d3175d364e26f016e6b3accf5dfc9a91ff1246ac0dcd52c4` (provenance only: live source, WAL excluded) |
| Snapshot sha256 | `1ac9143958614fbb4baf3c7c67a8f60ed1debb4255bf2164b5af7162a98807a7` (includes WAL content, hence different) |
| Free-space check | passed (needed 2.5x = 18.2 GB; 56.9 GB free) |

Real schema (`sqlite_master`):

```sql
CREATE TABLE ItemTable     (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)
CREATE TABLE cursorDiskKV  (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)
-- plus sqlite_autoindex_ItemTable_1 / sqlite_autoindex_cursorDiskKV_1 on key
```

So `key` is not the primary key: rows have a rowid and a separate unique autoindex on `key`.
The synthetic generator uses this schema by default.

Key spaces in the snapshot (`cursorDiskKV` = 424,270 rows, `ItemTable` = 756 rows):

| Prefix | Rows |
| --- | --- |
| `composerData:` | 682 |
| `bubbleId:` | 165,516 |
| other | 258,072 |

Bubble value sizes (15,000-row sample): p50 2.8 KB, p95 22.6 KB, mean 13.1 KB, max 13.4 MB;
29.5% exceed one page (overflow chain), 1.07% exceed 64 KB. `composerData:` values (200 sampled): p50 29.6 KB,
p95 341 KB, max 860 KB. Average row is about 17 KB, so the table is dominated by large payloads, not by key count.

Synthetic medium corpus (for comparison): 20 workspaces, 5,000 composers, 151,442 bubbles, 10,288 other
rows, 733 MB, bubbles p50 2.6 KB / mean 3.3 KB, 4.6% over one page. It is much smaller and less
overflow-heavy than the real data (real: 682 composers, 7.26 GB), so it understates overflow costs.

## EXPLAIN QUERY PLAN (identical on both drivers)

`case_sensitive_like = ON` is set, which is what lets LIKE use the index.

| # | Statement | Plan |
| --- | --- | --- |
| 1 | exact key + `length(CAST(value AS BLOB))` | `SEARCH ... USING INDEX sqlite_autoindex_cursorDiskKV_1 (key=?)` |
| 2a/b | `composerData:%` LIKE, `rowid >` keyset, `ORDER BY rowid` | `SEARCH ... USING INDEX autoindex (key>? AND key<?)` + **`USE TEMP B-TREE FOR ORDER BY`** |
| 2c | `%composerChatViewPane%` on workspace ItemTable | **`SCAN ItemTable`** (leading wildcard; tables are tiny) |
| 3a/b/c | key-range keyset (and LIKE fallback with `key >`) | `SEARCH ... USING COVERING INDEX autoindex (key>? AND key<?)`, no temp b-tree |
| 4 | `bubbleId:%` LIKE, rowid keyset | index range **+ TEMP B-TREE FOR ORDER BY** |
| 5a | per-composer `GLOB 'bubbleId:<id>:*'`, rowid keyset | index range **+ TEMP B-TREE FOR ORDER BY** |
| 5b | NUL `substr(CAST(key AS BLOB))` fallback | **`SCAN cursorDiskKV`** (full table) |
| 7a/b/c | first/last bubble `LIMIT 1` by GLOB (ASC/DESC) / LIKE | index range **+ TEMP B-TREE FOR ORDER BY** (sorts every bubble of that composer) |
| 9/10 | point lookups by rowid + `json_extract` | `SEARCH ... USING INTEGER PRIMARY KEY (rowid=?)` |
| je1 | `json_each` id page (workspace) | `SEARCH i USING INTEGER PRIMARY KEY`, `SCAN j VIRTUAL TABLE`, TEMP B-TREE for ORDER BY |
| je2/je3 | per-item projection / lookup | `SEARCH i ... rowid`, `SCAN j VIRTUAL TABLE` (re-parses the JSON per call) |

Takeaway: every rowid-ordered statement (#2, #4, #5, #7) uses the key index for the range but then sorts
the whole remaining range in a TEMP B-TREE for each page, and the result columns (including
`length(CAST(value AS BLOB))`, which reads the overflow chain) are computed for every row before the sort.
Only the key-range keyset statements (#3) are covering-index streams.

## Scan timings, snapshot (pages of 256, better-sqlite3, one run each, no cap hit)

| Key space / strategy | Rows | Wall | Rows/s |
| --- | --- | --- | --- |
| `composerData:` keyset, key only | 682 | 1.4 ms | 486k |
| `composerData:` keyset, + length | 682 | 1,249 ms | 546 |
| `composerData:` rowid LIKE, key only | 677* | 7.4 ms | 92k |
| `composerData:` rowid LIKE, + length | 677* | 177 ms | 3.8k |
| `composerData:` rowid GLOB, + length | 677* | 183 ms | 3.7k |
| `bubbleId:` keyset, key only | 165,516 | **226 ms** | 731k |
| `bubbleId:` keyset, + length | 165,516 | **37.2 s** | 4.4k |
| `bubbleId:` rowid LIKE, key only | 165,516 | 53.4 s | 3.1k |
| `bubbleId:` rowid LIKE, + length (#4 shape) | 165,516 | **141.9 s** | 1.2k |
| `bubbleId:` rowid GLOB, + length | 165,516 | 89.2 s | 1.9k |

\* 677 of 682: the rowid strategies add `value IS NOT NULL`, matching the library's #2 (5 composerData rows have
a NULL value).

Medium corpus (same strategies): `bubbleId:` keyset key-only 0.8 s, keyset + length 3.3 s, rowid LIKE key-only
83.6 s, rowid LIKE + length 51.9 s, rowid GLOB + length 44.4 s for 151k rows. The rowid strategies are about 2 orders of
magnitude slower than the keyset even without any overflow data, which is the TEMP B-TREE
cost (each page re-collects and sorts the remaining range; the remaining range shrinks, so total work is
quadratic in the number of matching rows). The difference between the key-only and the +length rowid runs on the
medium corpus is noise; both are dominated by the sort.

Per-statement micro-costs on the snapshot (warm-ish sample):

| Probe | Result |
| --- | --- |
| #5 per-composer GLOB iterate with length (60 of 682 composers, 15,140 bubbles) | mean 15.1 ms, p50 1.0, p95 49.6, max 375 ms; x682 ~ 10.3 s |
| #7a first / #7b last bubble, LIMIT 1 | mean 0.26 / 0.16 ms; x682 ~ 0.3 s total |
| #5b NUL-substr fallback, one page | mean 6.2 s, max 16.5 s (full-table scan per page; only for ids containing NUL) |
| #1 exact key + length (200 composers) | mean 4.2 ms, p95 21.7 ms, max 107 ms (overflow on big composerData) |
| #9 / #10 json_extract point lookups | mean 0.24 / 0.26 ms; x682 ~ 0.17 s |
| 106 workspace DB opens | open+close 0.31 ms/DB warm (97 ms total first pass); +schema 1.5 ms/DB; +#2 ChatViewPane scan 2.0 ms/DB (212 ms total); node:sqlite opens at 0.12 ms/DB |
| largest workspace `allComposers` (51 items, 27 KB) | je1 page 0.7 ms; per-item je2 x51 = 9.4 ms (re-parses JSON each call) |

## End-to-end baseline (built library, snapshot, Store root = empty dir, default driver node:sqlite)

| Scenario | Cold (iteration 1, fresh process) | Warm (iteration 2) | Peak RSS | Result |
| --- | --- | --- | --- | --- |
| `listSessionSummaries` (global, limit 20) | 8.7 s (first ever run: 14.5 s) | 7.1 s | 491 MB | 507 sessions |
| `listSessions` (global, limit 20) | 15.1 s | 11.8 s | 641 MB | 507 sessions |
| `listSessionSummaries` unknown workspace | 57 ms | 82 ms | 61 MB | 0 |
| `getSession` by UUID | 12.6 s | 12.8 s | 508 MB | 1 |
| `searchSessions` ("function", limit 20) | 72.7 s then `SessionAmbiguityError` | n/a | 1,040 MB | error: divergent replicas |

The 30-minute hard timeout was never approached. **The "15+ minutes" listing time was not reproduced** on the
snapshot with an empty Store root: unscoped `listSessionSummaries` took 8.7 s (14.5 s on the very first run,
with a cold file cache). See Caveats for plausible reasons.

## Dominant costs, ranked (evidence: SQL trace from `bench --trace-sql`, global list on snapshot)

SQL time inside one `listSessionSummaries` (about 7 s of SQL in an 8.7 s call):

1. **Whole-catalog rebuild on every call.** `limit: 20` is applied after all 507 sessions are built; `getSession`
   by UUID costs 12.7 s, i.e. a full catalog build plus one session. The only fast path is a workspace that
   matches nothing (57-82 ms). Every API call pays the full scan, so everything below multiplies.
2. **Repeated passes over the `bubbleId:` key space.** 5,168 key-range pages returned 1,322,080 key rows,
   which is about 8 passes over 165k bubbles (about 1.35 s, 18% of SQL time in key-only mode) plus 24 rowid-ordered
   `composerData` metadata pages (5,416 rows, 1.28 s, max 88 ms/page: `length(CAST(value AS BLOB))` over composerData
   values with p95 341 KB).
3. **Per-bubble payload reads during a summary list.** 44,264 single-row `SELECT key, CAST(value AS BLOB) ... WHERE rowid=? AND key=?`
   (1.9 s, 43 us each) and 1,652 rowid-ordered per-composer bubble-metadata pages returning the same 44,264 rows
   (1.55 s). Search and `getSession` do this for the whole key space: search read 176,373 bubble rows (7.1 s of point reads
   plus 32.2 s in 1,670 metadata pages, max 788 ms/page, 44% of the 72.7 s).
4. **Overflow reads from `length(CAST(value AS BLOB))`.** Projecting the length forces the overflow chain to be
   read: global bubble keyset 0.23 s key-only vs 37.2 s with the length (160x) because 29.5% of bubbles exceed a page.
   Any rowid or keyset statement that projects the length pays this, per row, even when the length is not needed.
5. **Rowid-ordered statements plan a TEMP B-TREE sort per page (#2, #4, #5, #7).** Fine for short per-composer
   prefixes (mean 15 ms, 10 s total if iterated once per composer), but a global `bubbleId:%` walk by this shape
   is 142 s versus 0.23 s key-only keyset (600x). #7 first/last each sort and project every bubble of the composer
   to return one row.
6. **NUL-fallback `substr(CAST(key AS BLOB))` is a full-table `SCAN`**: 6.2 s mean / 16.5 s max per page on 7.3 GB.
   Rare (needs a NUL in the id) but catastrophic if hit.
7. **Negligible**: 106 workspace DB opens (about 0.1-0.3 s total even doing two passes), `json_extract` point
   lookups (about 0.17 s over 682 composers), `json_each` per-item re-parse (9 ms in the largest workspace;
   quadratic in `allComposers` size, so worth watching), `%composerChatViewPane%` SCAN of tiny ItemTables.

## Caveats

- The reported 15+ minute listing was not reproduced. Candidates: a cold OS cache over a 7 GB file on a busy
  machine, live Cursor contention (WAL checkpoints, locks), the real `~/.cursor` Store tree (empty here by design),
  an older reader version, or a different entry point. The numbers here show the algorithmic cost
  structure; absolute times on the live machine may be larger.
- The snapshot is a point-in-time copy (backup API, no restarts, original layout), so fragmentation is realistic.
  The synthetic medium corpus is not: small bubbles, few overflow pages, 5,000 composers instead of 682.
- Single runs per strategy; no repeat-and-median for the 40-140 s scans.
- `searchSessions` on the snapshot ended with `SessionAmbiguityError` (divergent replicas in the real data);
  its time is to the error, not to a result.
- Peak RSS is the process high-water mark (`resourceUsage().maxRSS`) of the child, including Node itself.
