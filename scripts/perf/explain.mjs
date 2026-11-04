#!/usr/bin/env node
// Query-plan and scan-cost profiler for the SQL used by src/core/composer-sqlite.ts and storage.ts.
// Read-only: databases are opened read-only; results contain counts, sizes, timings and plans only
// (never keys, message text, titles, paths or ids).
//
// Usage: node scripts/perf/explain.mjs [--root DIR | --corpus medium] [--driver better-sqlite3|node:sqlite]
//          [--cap-sec 300] [--only schema,plans,scans,prefix,points,workspaces] [--out FILE]
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { loadBetterSqlite3, parseArgs, perfDir } from './common.mjs';

const args = parseArgs(process.argv.slice(2));
const require = createRequire(import.meta.url);
const driver = args.driver ?? 'better-sqlite3';
const capMs = Number(args["cap-sec"] ?? 300) * 1000;
const only = args.only ? new Set(String(args.only).split(',')) : null;
const want = (s) => !only || only.has(s);
const root = args.root ?? join(perfDir(), args.corpus ? `corpus-${args.corpus}` : 'snapshot');
const userDir = join(root, 'User');
const label = args.root ? 'custom' : (args.corpus ? `corpus-${args.corpus}` : 'snapshot');
const PAGE = 256; // sqlitePageRows default

/** Open read-only through either driver behind one tiny interface. */
function openDb(path) {
  if (driver === 'node:sqlite') {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA case_sensitive_like = ON');
    return {
      all: (sql, ...p) => db.prepare(sql).all(...p),
      get: (sql, ...p) => db.prepare(sql).get(...p),
      prepare: (sql) => {
        const st = db.prepare(sql);
        return { all: (...p) => st.all(...p), get: (...p) => st.get(...p) };
      },
      pragma: (name) => Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0],
      close: () => db.close(),
    };
  }
  const Database = loadBetterSqlite3();
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma('case_sensitive_like = ON');
  return {
    all: (sql, ...p) => db.prepare(sql).all(...p),
    get: (sql, ...p) => db.prepare(sql).get(...p),
    prepare: (sql) => {
      const st = db.prepare(sql);
      return { all: (...p) => st.all(...p), get: (...p) => st.get(...p) };
    },
    pragma: (name) => db.pragma(name, { simple: true }),
    close: () => db.close(),
  };
}

const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const now = () => performance.now();
const out = { label, driver, node: process.version, generatedAt: new Date().toISOString() };
const log = (...a) => console.log(...a);

function sqliteVersions() {
  const v = {};
  try {
    const D = loadBetterSqlite3();
    const d = new D(':memory:');
    v['better-sqlite3'] = d.prepare('select sqlite_version() v').get().v;
    d.close();
  } catch {
    v['better-sqlite3'] = 'unavailable';
  }
  try {
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(':memory:');
    v['node:sqlite'] = d.prepare('select sqlite_version() v').get().v;
    d.close();
  } catch {
    v['node:sqlite'] = 'unavailable';
  }
  return v;
}

function planOf(db, sql, params = []) {
  try {
    return db.all(`EXPLAIN QUERY PLAN ${sql}`, ...params).map((r) => r.detail);
  } catch (err) {
    return [`ERROR ${String(err.message).slice(0, 100)}`];
  }
}
const planFlags = (lines) => ({
  scan: lines.some((l) => /^SCAN /u.test(l) && !/USING (COVERING )?INDEX/u.test(l)),
  search: lines.some((l) => /^SEARCH /u.test(l)),
  tempBTree: lines.some((l) => /TEMP B-TREE/u.test(l)),
  coveringIndex: lines.some((l) => /COVERING INDEX/u.test(l)),
});

function globEscape(v) {
  return v.replaceAll('[', '[[]').replaceAll('*', '[*]').replaceAll('?', '[?]');
}
const likeRange = (prefix) => ({ lower: prefix, upper: prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1) });

// ---- statements mirroring the library --------------------------------------------------------
const LEN = 'length(CAST(value AS BLOB))';
const S = {
  s1: `SELECT CAST(rowid AS TEXT) AS rowId, key, ${LEN} AS byteLength FROM cursorDiskKV WHERE key = ? COLLATE BINARY AND value IS NOT NULL`,
  s2: (t) => `SELECT CAST(${t}.rowid AS TEXT) AS rowId, key, ${LEN} AS byteLength FROM ${t} WHERE key LIKE ? ESCAPE '\\' AND value IS NOT NULL AND (? IS NULL OR ${t}.rowid > ?) ORDER BY ${t}.rowid ASC LIMIT ?`,
  s3first: 'SELECT key FROM cursorDiskKV WHERE key >= ? AND key < ? ORDER BY key ASC LIMIT ?',
  s3later: 'SELECT key FROM cursorDiskKV WHERE key > ? AND key < ? ORDER BY key ASC LIMIT ?',
  s3likeFallback: "SELECT key FROM cursorDiskKV WHERE key LIKE ? ESCAPE '\\' AND key > ? ORDER BY key ASC LIMIT ?",
  s4: `SELECT CAST(cursorDiskKV.rowid AS TEXT) AS rowId, key, COALESCE(${LEN}, 0) AS byteLength, value IS NULL AS valueIsNull FROM cursorDiskKV WHERE key LIKE ? ESCAPE '\\' AND (? IS NULL OR cursorDiskKV.rowid > ?) ORDER BY cursorDiskKV.rowid ASC LIMIT ?`,
  s5: `SELECT CAST(cursorDiskKV.rowid AS TEXT) AS rowId, key, COALESCE(${LEN}, 0) AS byteLength, value IS NULL AS valueIsNull FROM cursorDiskKV WHERE cursorDiskKV.key IS NOT NULL AND cursorDiskKV.key GLOB ? AND (? IS NULL OR cursorDiskKV.rowid > ?) ORDER BY cursorDiskKV.rowid ASC LIMIT ?`,
  s5nul: `SELECT CAST(cursorDiskKV.rowid AS TEXT) AS rowId, key, COALESCE(${LEN}, 0) AS byteLength, value IS NULL AS valueIsNull FROM cursorDiskKV WHERE cursorDiskKV.key IS NOT NULL AND substr(CAST(cursorDiskKV.key AS BLOB), 1, length(CAST(? AS BLOB))) = CAST(? AS BLOB) AND (? IS NULL OR cursorDiskKV.rowid > ?) ORDER BY cursorDiskKV.rowid ASC LIMIT ?`,
  s7first: `SELECT CAST(cursorDiskKV.rowid AS TEXT) AS rowId, key, COALESCE(${LEN}, 0) AS byteLength, value IS NULL AS valueIsNull FROM cursorDiskKV WHERE cursorDiskKV.key IS NOT NULL AND cursorDiskKV.key GLOB ? ORDER BY cursorDiskKV.rowid ASC LIMIT 1`,
  s7last: `SELECT CAST(cursorDiskKV.rowid AS TEXT) AS rowId, key, COALESCE(${LEN}, 0) AS byteLength, value IS NULL AS valueIsNull FROM cursorDiskKV WHERE cursorDiskKV.key IS NOT NULL AND cursorDiskKV.key GLOB ? ORDER BY cursorDiskKV.rowid DESC LIMIT 1`,
  s7likeFirst: `SELECT CAST(cursorDiskKV.rowid AS TEXT) AS rowId, key, COALESCE(${LEN}, 0) AS byteLength, value IS NULL AS valueIsNull FROM cursorDiskKV WHERE key LIKE ? ESCAPE '\\' ORDER BY cursorDiskKV.rowid ASC LIMIT 1`,
  s9: `SELECT CASE WHEN json_valid(value) THEN json_extract(value, '$.workspaceIdentifier.uri.fsPath') END AS fsPath, CASE WHEN json_valid(value) THEN json_extract(value, '$.workspaceIdentifier.uri.path') END AS uriPath, CASE WHEN json_valid(value) THEN json_extract(value, '$.workspaceIdentifier.uri.external') END AS externalPath, CASE WHEN json_valid(value) THEN json_extract(value, '$.workspaceUri') END AS workspaceUri FROM cursorDiskKV WHERE rowid = ?`,
  s10: `SELECT key, CASE WHEN json_valid(value) THEN json_extract(value, '$.workspaceIdentifier.id') END AS workspaceId, CASE WHEN json_valid(value) THEN json_extract(value, '$.workspaceIdentifier.uri.fsPath') END AS fsPath, CASE WHEN json_valid(value) THEN json_extract(value, '$.workspaceIdentifier.uri.path') END AS uriPath, CASE WHEN json_valid(value) THEN json_extract(value, '$.workspaceIdentifier.uri.external') END AS externalPath, CASE WHEN json_valid(value) THEN json_extract(value, '$.workspaceUri') END AS workspaceUri FROM cursorDiskKV WHERE rowid = ?`,
  je1: `SELECT CAST(j.key AS INTEGER) AS itemIndex, length(CAST(json_extract(j.value, '$.composerId') AS BLOB)) AS byteLength FROM ItemTable AS i, json_each(i.value, '$.allComposers') AS j WHERE i.rowid = ? AND json_type(j.value, '$.composerId') = 'text' AND CAST(j.key AS INTEGER) > ? ORDER BY itemIndex ASC LIMIT ?`,
  je2: `SELECT json_extract(j.value, '$.composerId') AS composerId FROM ItemTable AS i, json_each(i.value, '$.allComposers') AS j WHERE i.rowid = ? AND CAST(j.key AS INTEGER) = ?`,
  je3: `SELECT CAST(j.key AS INTEGER) AS itemIndex, length(CAST(j.value AS BLOB)) AS byteLength FROM ItemTable AS i, json_each(i.value, '$.allComposers') AS j WHERE i.rowid = ? AND json_extract(j.value, '$.composerId') = ? LIMIT 1`,
};

// ---- sections -------------------------------------------------------------------------------
function sectionSchema(db, dbPath) {
  const sec = {};
  sec.sqliteMaster = db
    .all("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name IN ('cursorDiskKV','ItemTable') ORDER BY type, name")
    .map((r) => ({ type: r.type, name: r.name, table: r.tbl_name, sql: r.sql }));
  sec.pageSize = db.pragma('page_size');
  sec.pageCount = db.pragma('page_count');
  sec.freelistCount = db.pragma('freelist_count');
  sec.journalMode = db.pragma('journal_mode');
  sec.fileBytes = statSync(dbPath).size;
  let t = now();
  sec.cursorDiskKVRows = Number(db.get('SELECT count(*) AS n FROM cursorDiskKV').n);
  sec.countAllMs = round(now() - t);
  const cnt = (prefix) => {
    const r = likeRange(prefix);
    const t0 = now();
    const n = Number(db.get('SELECT count(*) AS n FROM cursorDiskKV WHERE key >= ? AND key < ?', r.lower, r.upper).n);
    return { n, ms: round(now() - t0) };
  };
  const comp = cnt('composerData:');
  const bub = cnt('bubbleId:');
  sec.keyCounts = {
    'composerData:': comp.n,
    'bubbleId:': bub.n,
    other: sec.cursorDiskKVRows - comp.n - bub.n,
  };
  sec.keyCountMs = { 'composerData:': comp.ms, 'bubbleId:': bub.ms };
  sec.nullValueRowsInSample = undefined;
  // Value-size sample: three windows of 5000 consecutive bubble rows (by rowid) spread over the table.
  const maxRow = Number(db.get('SELECT max(rowid) AS m FROM cursorDiskKV').m ?? 0);
  const sizes = [];
  for (const frac of [0.1, 0.5, 0.9]) {
    const start = Math.floor(maxRow * frac);
    for (const r of db.all(`SELECT ${LEN} AS n FROM cursorDiskKV WHERE rowid >= ? AND key LIKE 'bubbleId:%' LIMIT 5000`, start)) {
      if (r.n !== null) sizes.push(Number(r.n));
    }
  }
  sizes.sort((a, b) => a - b);
  if (sizes.length) {
    const pageSize = sec.pageSize;
    sec.bubbleValueSizeSample = {
      n: sizes.length,
      p50: sizes[Math.floor(sizes.length * 0.5)],
      p95: sizes[Math.floor(sizes.length * 0.95)],
      max: sizes[sizes.length - 1],
      mean: Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length),
      shareOverOnePage: round(sizes.filter((n) => n > pageSize - 100).length / sizes.length, 3),
      shareOver64KB: round(sizes.filter((n) => n > 65_536).length / sizes.length, 4),
    };
  }
  const itemRows = db.get('SELECT count(*) AS n FROM ItemTable');
  sec.itemTableRows = Number(itemRows.n);
  return sec;
}

function sectionPlans(db, sample) {
  const comp = 'composerData:%';
  const bub = 'bubbleId:%';
  const cr = likeRange('composerData:');
  const br = likeRange('bubbleId:');
  const cid = sample.composerId ?? '00000000-0000-0000-0000-000000000000';
  const perPrefix = `bubbleId:${cid}:`;
  const plans = {};
  const add = (id, desc, sql, params) => {
    const detail = planOf(db, sql, params);
    plans[id] = { desc, detail, ...planFlags(detail) };
  };
  add('#1 getBoundedComposerMetadataByKey', 'exact key + length(CAST(value AS BLOB))', S.s1, [`composerData:${cid}`]);
  add('#2a forEachBoundedComposerMetadata composerData:%', 'LIKE + rowid keyset (first page)', S.s2('cursorDiskKV'), [comp, null, null, PAGE]);
  add('#2b forEachBoundedComposerMetadata composerData:% later page', 'LIKE + rowid keyset (later page)', S.s2('cursorDiskKV'), [comp, 5, 5, PAGE]);
  add('#2c forEachBoundedComposerMetadata ItemTable %composerChatViewPane%', 'LIKE with leading wildcard on workspace ItemTable', S.s2('ItemTable'), ['%composerChatViewPane%', null, null, PAGE]);
  add('#3a forEachBoundedComposerKeyMetadata key-range first page (composerData)', 'key >= ? AND key < ? ORDER BY key', S.s3first, [cr.lower, cr.upper, PAGE]);
  add('#3b key-range later page (bubbleId)', 'key > ? AND key < ? ORDER BY key', S.s3later, [`${br.lower}x`, br.upper, PAGE]);
  add('#3c key LIKE fallback', "key LIKE ? ESCAPE '\\' AND key > ?", S.s3likeFallback, ['bubbleId:%x', 'bubbleId:a', PAGE]);
  add('#4 forEachBoundedComposerBubbleMetadata bubbleId:%', 'LIKE + rowid keyset, global bubble space', S.s4, [bub, null, null, PAGE]);
  add('#5a ByExactPrefix GLOB (per composer)', 'GLOB literal prefix + rowid keyset', S.s5, [`bubbleId:${globEscape(cid)}:*`, null, null, PAGE]);
  add('#5b ByExactPrefix NUL substr fallback', 'substr(CAST(key AS BLOB)) prefix compare', S.s5nul, [perPrefix, perPrefix, null, null, PAGE]);
  add('#7a first bubble by GLOB LIMIT 1 (ASC)', 'GLOB + ORDER BY rowid ASC LIMIT 1', S.s7first, [`bubbleId:${globEscape(cid)}:*`]);
  add('#7b last bubble by GLOB LIMIT 1 (DESC)', 'GLOB + ORDER BY rowid DESC LIMIT 1', S.s7last, [`bubbleId:${globEscape(cid)}:*`]);
  add('#7c first bubble by LIKE LIMIT 1', 'LIKE + ORDER BY rowid ASC LIMIT 1', S.s7likeFirst, [`bubbleId:${cid}:%`]);
  add('#9 workspace path by rowid (json_extract)', 'point lookup by rowid', S.s9, [1]);
  add('#10 membership by rowid (json_extract)', 'point lookup by rowid', S.s10, [1]);
  return plans;
}

/** Iterate a full key space by pages of PAGE using one strategy; stop at the time cap. */
function iterate(db, strat, collect) {
  const t0 = now();
  let rows = 0;
  let pages = 0;
  let capped = false;
  const st = db.prepare(strat.sql);
  let after = null;
  while (true) {
    const page = strat.run(st, after);
    if (page.length === 0) break;
    pages++;
    rows += page.length;
    if (collect) for (const r of page) collect(r);
    after = strat.next(page);
    if (page.length < PAGE) break;
    if (now() - t0 > capMs) {
      capped = true;
      break;
    }
  }
  const ms = now() - t0;
  return { rows, pages, ms: round(ms), capped, rowsPerSec: Math.round(rows / (ms / 1000)) };
}

function strategies(space) {
  const prefix = space === 'composerData' ? 'composerData:' : 'bubbleId:';
  const like = `${prefix}%`;
  const glob = `${prefix}*`;
  const r = likeRange(prefix);
  const rowidNext = (page) => page[page.length - 1].rowId;
  const keyNext = (page) => page[page.length - 1].key;
  const rowidSql = (proj, pred, extra = '') =>
    `SELECT CAST(rowid AS TEXT) AS rowId, key${proj ? `, ${LEN} AS byteLength` : ''} FROM cursorDiskKV WHERE ${pred}${extra} AND (? IS NULL OR cursorDiskKV.rowid > ?) ORDER BY cursorDiskKV.rowid ASC LIMIT ?`;
  const keysetSql = (proj) =>
    `SELECT key${proj ? `, ${LEN} AS byteLength` : ''} FROM cursorDiskKV WHERE key > ? AND key < ? ORDER BY key ASC LIMIT ?`;
  const rowid = (sql, pat) => ({
    sql,
    run: (st, after) => st.all(pat, after, after, PAGE).map((x) => ({ ...x, rowId: Number(x.rowId) })),
    next: rowidNext,
  });
  const keyset = (sql) => ({
    sql,
    run: (st, after) => st.all(after ?? prefix, r.upper, PAGE), // lower bound exclusive: prefix itself is never a key
    next: keyNext,
  });
  const notNull = space === 'composerData' ? ' AND value IS NOT NULL' : '';
  return [
    { id: 'keyset-key-only', desc: 'key-range keyset, SELECT key (#3 shape)', ...keyset(keysetSql(false)) },
    { id: 'keyset-with-length', desc: 'key-range keyset, + length(CAST(value AS BLOB))', ...keyset(keysetSql(true)) },
    { id: 'rowid-like-key-only', desc: "rowid-ordered LIKE ESCAPE, SELECT key (no length)", ...rowid(rowidSql(false, "key LIKE ? ESCAPE '\\'", notNull), like) },
    { id: 'rowid-like-with-length', desc: `rowid-ordered LIKE ESCAPE + length (#${space === 'composerData' ? 2 : 4} shape)`, ...rowid(rowidSql(true, "key LIKE ? ESCAPE '\\'", notNull), like) },
    { id: 'rowid-glob-with-length', desc: 'rowid-ordered GLOB + length (#5 shape, global prefix)', ...rowid(rowidSql(true, 'key GLOB ?', notNull), glob) },
  ];
}

function sectionScans(db, sample) {
  const res = {};
  for (const space of ['composerData', 'bubbleId']) {
    res[space] = {};
    for (const strat of strategies(space)) {
      const collect = space === 'composerData' && strat.id === 'keyset-key-only' ? (row) => sample.allComposerKeys.push(row.key) : null;
      log(`  scan ${space} / ${strat.id} ...`);
      const plan = planOf(db, strat.sql, strat.sql.includes('rowid >') ? ['x', null, null, PAGE] : [likeRange(space === 'composerData' ? 'composerData:' : 'bubbleId:').lower, 'z', PAGE]);
      const r = iterate(db, strat, collect);
      if (r.capped) r.extrapolatedTotalMs = undefined;
      res[space][strat.id] = { desc: strat.desc, plan, ...r };
      log(`    ${r.rows} rows, ${r.ms} ms${r.capped ? ' (CAPPED)' : ''}`);
      if (collect && !sample.composerId && sample.allComposerKeys.length) {
        sample.composerId = sample.allComposerKeys[Math.floor(sample.allComposerKeys.length / 2)].slice('composerData:'.length);
      }
    }
  }
  return res;
}

function evenSample(arr, n) {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)]);
}

function timeEach(items, fn) {
  const times = [];
  let tot = 0;
  for (const it of items) {
    const t0 = now();
    fn(it);
    const d = now() - t0;
    times.push(d);
    tot += d;
  }
  times.sort((a, b) => a - b);
  return {
    n: times.length,
    meanMs: round(tot / Math.max(1, times.length), 2),
    p50Ms: round(times[Math.floor(times.length / 2)] ?? 0, 2),
    p95Ms: round(times[Math.floor(times.length * 0.95)] ?? 0, 2),
    maxMs: round(times[times.length - 1] ?? 0, 2),
  };
}

function sectionPrefix(db, sample) {
  const keys = evenSample(sample.allComposerKeys, Number(args['sample-composers'] ?? 60));
  const ids = keys.map((k) => k.slice('composerData:'.length));
  const res = { sampledComposers: ids.length, totalComposers: sample.allComposerKeys.length };
  let bubbleCount = 0;
  const s5 = db.prepare(S.s5);
  res['#5 per-composer GLOB iterate (all bubbles, with length)'] = timeEach(ids, (id) => {
    let after = null;
    while (true) {
      const page = s5.all(`bubbleId:${globEscape(id)}:*`, after, after, PAGE);
      bubbleCount += page.length;
      if (page.length < PAGE) break;
      after = Number(page[page.length - 1].rowId);
    }
  });
  res.sampledBubbleCount = bubbleCount;
  const first = db.prepare(S.s7first);
  const last = db.prepare(S.s7last);
  res['#7a first bubble GLOB LIMIT 1'] = timeEach(ids, (id) => first.get(`bubbleId:${globEscape(id)}:*`));
  res['#7b last bubble GLOB LIMIT 1 (DESC)'] = timeEach(ids, (id) => last.get(`bubbleId:${globEscape(id)}:*`));
  const nul = db.prepare(S.s5nul);
  res['#5b NUL substr fallback (one page)'] = timeEach(ids.slice(0, 5), (id) => nul.all(`bubbleId:${id}:`, `bubbleId:${id}:`, null, null, PAGE));
  const per = res['#5 per-composer GLOB iterate (all bubbles, with length)'].meanMs;
  res.extrapolation = {
    note: 'mean per-composer cost x total composers (warm-ish sample; real cost depends on cache)',
    perComposerPrefixIterateTotalMs: round(per * sample.allComposerKeys.length, 0),
    perComposerFirstLastTotalMs: round((res['#7a first bubble GLOB LIMIT 1'].meanMs + res['#7b last bubble GLOB LIMIT 1 (DESC)'].meanMs) * sample.allComposerKeys.length, 0),
  };
  return res;
}

function sectionPoints(db, sample) {
  const keys = evenSample(sample.allComposerKeys, Number(args['sample-points'] ?? 200));
  const res = { sampled: keys.length };
  const s1 = db.prepare(S.s1);
  res['#1 exact key + length'] = timeEach(keys, (k) => s1.get(k));
  const rowids = keys.map((k) => Number(s1.get(k)?.rowId));
  const lens = keys.map((k) => Number(s1.get(k)?.byteLength ?? 0)).sort((a, b) => a - b);
  res.composerDataValueBytes = { p50: lens[Math.floor(lens.length / 2)], p95: lens[Math.floor(lens.length * 0.95)], max: lens[lens.length - 1] };
  const s9 = db.prepare(S.s9);
  const s10 = db.prepare(S.s10);
  res['#9 rowid json_extract x4 (workspace path)'] = timeEach(rowids, (r) => s9.get(r));
  res['#10 rowid json_extract x5 (membership)'] = timeEach(rowids, (r) => s10.get(r));
  res.extrapolation = {
    '#10 x all composers (ms)': round(res['#10 rowid json_extract x5 (membership)'].meanMs * sample.allComposerKeys.length, 0),
    '#9 x all composers (ms)': round(res['#9 rowid json_extract x4 (workspace path)'].meanMs * sample.allComposerKeys.length, 0),
  };
  return res;
}

function sectionWorkspaces() {
  const wsRoot = join(userDir, 'workspaceStorage');
  const dbs = existsSync(wsRoot)
    ? readdirSync(wsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(wsRoot, d.name, 'state.vscdb')))
        .map((d) => join(wsRoot, d.name, 'state.vscdb'))
    : [];
  const res = { workspaceDbCount: dbs.length, totalBytes: dbs.reduce((a, p) => a + statSync(p).size, 0) };
  const phase = (name, fn) => {
    const t0 = now();
    for (const p of dbs) {
      try {
        fn(p);
      } catch {
        /* count only */
      }
    }
    res[name] = { totalMs: round(now() - t0), perDbMs: round((now() - t0) / Math.max(1, dbs.length), 2) };
  };
  phase('openClose (first pass, cold-ish)', (p) => openDb(p).close());
  phase('openClose (second pass)', (p) => openDb(p).close());
  phase('open + schema read (sqlite_master)', (p) => {
    const d = openDb(p);
    d.all("SELECT name FROM sqlite_master WHERE type='table'");
    d.close();
  });
  phase('open + #2 %composerChatViewPane% scan', (p) => {
    const d = openDb(p);
    d.all(S.s2('ItemTable'), '%composerChatViewPane%', null, null, PAGE);
    d.close();
  });
  phase('open + point lookup composer.composerData rowid', (p) => {
    const d = openDb(p);
    d.get("SELECT CAST(rowid AS TEXT) AS rowId, key, length(CAST(value AS BLOB)) AS byteLength FROM ItemTable WHERE key = ? COLLATE BINARY AND value IS NOT NULL", 'composer.composerData');
    d.close();
  });
  // json_each shapes on the workspace with the most composers.
  let best = null;
  for (const p of dbs) {
    try {
      const d = openDb(p);
      const r = d.get("SELECT rowid AS rowId, json_array_length(value, '$.allComposers') AS n, length(CAST(value AS BLOB)) AS bytes FROM ItemTable WHERE key = 'composer.composerData' AND json_valid(value)");
      d.close();
      if (r && Number(r.n) > (best?.n ?? -1)) best = { path: p, rowId: Number(r.rowId), n: Number(r.n), bytes: Number(r.bytes) };
    } catch {
      /* ignore */
    }
  }
  if (best) {
    const d = openDb(best.path);
    const plans = {
      je1: planOf(d, S.je1, [best.rowId, -1, PAGE]),
      je2: planOf(d, S.je2, [best.rowId, 0]),
      je3: planOf(d, S.je3, [best.rowId, 'x']),
    };
    const t0 = now();
    const page = d.all(S.je1, best.rowId, -1, 1_000_000);
    const pageMs = now() - t0;
    const t1 = now();
    const je2 = d.prepare(S.je2);
    for (const row of page) je2.get(best.rowId, Number(row.itemIndex));
    const perItemMs = now() - t1;
    res.largestWorkspaceComposerData = {
      composersInItemTable: best.n,
      valueBytes: best.bytes,
      plans,
      '#je1 id-length page query, all items (ms)': round(pageMs),
      '#je2 per-item projection x N (ms) [re-parses JSON each call]': round(perItemMs),
      perItemMeanMs: round(perItemMs / Math.max(1, page.length), 3),
    };
    d.close();
  }
  return res;
}

// ---- main ------------------------------------------------------------------------------------
const gdb = join(userDir, 'globalStorage', 'state.vscdb');
if (!existsSync(gdb)) {
  console.error(`no global DB at ${root}`);
  process.exit(1);
}
out.sqliteVersions = sqliteVersions();
const sample = { composerId: undefined, allComposerKeys: [] };
const db = openDb(gdb);
try {
  if (want('schema')) {
    log('schema/counts ...');
    out.schema = sectionSchema(db, gdb);
    log(JSON.stringify({ rows: out.schema.cursorDiskKVRows, keyCounts: out.schema.keyCounts, pageSize: out.schema.pageSize, pageCount: out.schema.pageCount, freelist: out.schema.freelistCount }));
  }
  // Need sample composer keys for plans/prefix/points; gather with a cheap key-only keyset if scans are skipped.
  if (!want('scans') && (want('plans') || want('prefix') || want('points'))) {
    const st = db.prepare(S.s3later);
    const r = likeRange('composerData:');
    let after = r.lower;
    while (true) {
      const page = st.all(after, r.upper, PAGE);
      for (const p of page) sample.allComposerKeys.push(p.key);
      if (page.length < PAGE) break;
      after = page[page.length - 1].key;
    }
    sample.composerId = sample.allComposerKeys[Math.floor(sample.allComposerKeys.length / 2)]?.slice('composerData:'.length);
  }
  if (want('scans')) {
    log('scans (batches of 256) ...');
    out.scans = sectionScans(db, sample);
  }
  if (want('plans')) {
    log('plans ...');
    out.plans = sectionPlans(db, sample);
  }
  if (want('prefix')) {
    log('per-composer prefix ...');
    out.prefix = sectionPrefix(db, sample);
  }
  if (want('points')) {
    log('point lookups ...');
    out.points = sectionPoints(db, sample);
  }
} finally {
  db.close();
}
if (want('workspaces')) {
  log('workspace DBs ...');
  out.workspaces = sectionWorkspaces();
}

const outFile = args.out ?? join(perfDir(), 'results', `explain-${label}-${driver.replace(':', '-')}.json`);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(out, null, 2));
log(`written ${outFile}`);
for (const [id, p] of Object.entries(out.plans ?? {})) {
  log(`${id}: ${p.scan ? 'SCAN' : p.search ? 'SEARCH' : '?'}${p.coveringIndex ? ' covering' : ''}${p.tempBTree ? ' TEMP-B-TREE' : ''} | ${p.detail.join(' ; ')}`);
}
