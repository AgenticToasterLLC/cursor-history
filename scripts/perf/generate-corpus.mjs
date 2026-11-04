#!/usr/bin/env node
// Deterministic synthetic Cursor-like corpus generator for cursor-history performance work.
//
// Usage: node scripts/perf/generate-corpus.mjs [small|medium|large] [--seed N] [--out DIR]
//          [--workspaces N --composers N --bubbles N] [--schema real|fixture] [--force]
//
// Layout (matches tests/helpers/session-integrity-fixtures.ts):
//   <out>/User/workspaceStorage/<id>/{state.vscdb,workspace.json}
//   <out>/User/globalStorage/state.vscdb   (cursorDiskKV + ItemTable)
// Default <out>: %LOCALAPPDATA%/cursor-history-perf/corpus-<scale> (never committed).
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadBetterSqlite3, parseArgs, perfDir } from './common.mjs';

export const PRESETS = {
  small: { workspaces: 3, composers: 40, bubbles: 800 },
  medium: { workspaces: 20, composers: 5_000, bubbles: 150_000 },
  large: { workspaces: 150, composers: 50_000, bubbles: 1_200_000 },
};

const SCHEMAS = {
  // Believed to match what Cursor ships (verified against the snapshot in docs/perf/baseline-0.19.0.md).
  real: {
    kv: 'CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)',
    item: 'CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)',
  },
  // What the unit-test fixtures use.
  fixture: {
    kv: 'CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    item: 'CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  },
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS =
  'alpha beta gamma delta function return const await import export class interface module render update select query index cache buffer stream parse token value result error handle config session message bubble composer workspace storage table column filter merge commit branch deploy build test lint'.split(
    ' '
  );

export async function generateCorpus(options) {
  const Database = loadBetterSqlite3();
  const { out, seed, workspaces, composers, bubbles, schema } = options;
  const rnd = mulberry32(seed);
  const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const hex = (n) => {
    let s = '';
    while (s.length < n) s += Math.floor(rnd() * 0x100000000).toString(16).padStart(8, '0');
    return s.slice(0, n);
  };
  const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[ri(0, 3)]}${hex(3)}-${hex(12)}`;

  // Filler text pool: slices of this are cheap and deterministic.
  const poolParts = [];
  for (let i = 0; i < 20_000; i++) poolParts.push(WORDS[ri(0, WORDS.length - 1)]);
  const pool = poolParts.join(' ');
  const filler = (bytes) => {
    const start = ri(0, pool.length - 1);
    let s = pool.slice(start, start + bytes);
    while (s.length < bytes) s += ` ${pool.slice(0, bytes - s.length)}`;
    return s;
  };

  const userDir = join(out, 'User');
  if (existsSync(out)) {
    if (!options.force) throw new Error(`output exists: ${out} (use --force to regenerate)`);
    rmSync(out, { recursive: true, force: true });
  }
  const wsRoot = join(userDir, 'workspaceStorage');
  const globalDir = join(userDir, 'globalStorage');
  mkdirSync(wsRoot, { recursive: true });
  mkdirSync(globalDir, { recursive: true });

  const t0 = Date.now();
  const wsIds = [];
  for (let i = 0; i < workspaces; i++) wsIds.push(hex(32));
  const wsPaths = wsIds.map((_, i) => join('C:\\perf-corpus-projects', `project-${i}`));

  // Plan composers: ids, workspace, bubble counts.
  const avg = bubbles / composers;
  const plan = [];
  let totalBubbles = 0;
  const collisionPairs = Math.max(1, Math.floor(composers / 500));
  for (let c = 0; c < composers; c++) {
    let id = uuid();
    const n = Math.max(1, Math.min(Math.round(-Math.log(1 - rnd()) * avg), Math.round(avg * 10)));
    const hasWorkspace = rnd() < 0.9;
    plan.push({
      id,
      ws: hasWorkspace ? ri(0, workspaces - 1) : -1,
      n,
      createdAt: 1_700_000_000_000 + c * 60_000 + ri(0, 59_999),
      missingTimes: rnd() < 0.03,
    });
    totalBubbles += n;
  }
  // Case-collision pairs: second composer's UUID differs only in letter case.
  const collisions = [];
  for (let p = 0; p < collisionPairs && p * 2 + 1 < plan.length; p++) {
    const a = plan[p * 2];
    const b = plan[p * 2 + 1];
    const upper = a.id.toUpperCase();
    if (upper !== a.id) {
      b.id = upper;
      b.ws = a.ws;
      collisions.push([p * 2, p * 2 + 1]);
    }
  }

  // Workspace DBs.
  const wsComposers = wsIds.map(() => []);
  for (const c of plan) if (c.ws >= 0) wsComposers[c.ws].push(c);
  for (let w = 0; w < workspaces; w++) {
    const dir = join(wsRoot, wsIds[w]);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(wsPaths[w]).href }));
    const db = new Database(join(dir, 'state.vscdb'));
    db.exec(SCHEMAS[schema].item);
    const ins = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
    db.transaction(() => {
      ins.run(
        'composer.composerData',
        JSON.stringify({
          allComposers: wsComposers[w].map((c) => ({
            composerId: c.id,
            name: `Perf composer ${c.id.slice(0, 8)}`,
            ...(c.missingTimes ? {} : { createdAt: c.createdAt, lastUpdatedAt: c.createdAt + 5000 }),
          })),
          selectedComposerIds: [],
        })
      );
      ins.run(`workbench.panel.composerChatViewPane.${hex(32)}`, JSON.stringify({ 'workbench.panel.aichat.view': { collapsed: false } }));
      for (let k = 0; k < 40; k++) ins.run(`unrelated.setting.${k}`, JSON.stringify({ v: k, pad: filler(ri(50, 600)) }));
    })();
    db.close();
  }

  // Global DB.
  const gdb = new Database(join(globalDir, 'state.vscdb'));
  gdb.pragma('journal_mode = WAL');
  gdb.exec(SCHEMAS[schema].kv);
  gdb.exec(SCHEMAS[schema].item);
  const insKv = gdb.prepare('INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)');
  let bigBubbles = 0;
  let bubbleRows = 0;
  let otherRows = 0;
  const BATCH = 2000;
  let c = 0;
  while (c < plan.length) {
    const end = Math.min(plan.length, c + BATCH);
    gdb.transaction(() => {
      for (; c < end; c++) {
        const comp = plan[c];
        const headers = [];
        const bubbleRowsForComposer = [];
        for (let b = 0; b < comp.n; b++) {
          const bid = uuid();
          const type = b % 2 === 0 ? 1 : 2;
          headers.push({ bubbleId: bid, type });
          const big = rnd() < 0.01;
          const size = big ? ri(65_000, 110_000) : ri(1_000, 4_000);
          if (big) bigBubbles++;
          bubbleRowsForComposer.push([
            `bubbleId:${comp.id}:${bid}`,
            JSON.stringify({
              _v: 3,
              type,
              bubbleId: bid,
              text: filler(size),
              createdAt: new Date(comp.createdAt + b * 1000).toISOString(),
            }),
          ]);
        }
        insKv.run(
          `composerData:${comp.id}`,
          JSON.stringify({
            _v: 3,
            composerId: comp.id,
            name: `Perf composer ${comp.id.slice(0, 8)}`,
            ...(comp.missingTimes ? {} : { createdAt: comp.createdAt, lastUpdatedAt: comp.createdAt + comp.n * 1000 }),
            ...(comp.ws >= 0 ? { workspaceIdentifier: { id: wsIds[comp.ws], uri: { fsPath: wsPaths[comp.ws] } } } : {}),
            fullConversationHeadersOnly: headers,
            context: { pad: filler(ri(200, 2000)) },
          })
        );
        for (const [k, v] of bubbleRowsForComposer) insKv.run(k, v);
        bubbleRows += bubbleRowsForComposer.length;
        // Unrelated Cursor-ish keys interleaved with real ones.
        const extra = ri(0, 4);
        for (let e = 0; e < extra; e++) {
          const prefix = ['checkpointId', 'messageRequestContext', 'codeBlockDiff', 'inlineDiffs'][ri(0, 3)];
          insKv.run(`${prefix}:${comp.id}:${uuid()}`, JSON.stringify({ pad: filler(ri(100, 1500)) }));
          otherRows++;
        }
      }
    })();
  }
  gdb.transaction(() => {
    for (let k = 0; k < 200; k++) {
      insKv.run(`unrelated.global.${k}`, JSON.stringify({ k, pad: filler(ri(50, 2000)) }));
      otherRows++;
    }
    insKv.run('applicationUser', JSON.stringify({ pad: filler(500) }));
    otherRows++;
    gdb.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run('unrelated.item', JSON.stringify({ v: 1 }));
  })();
  gdb.pragma('wal_checkpoint(TRUNCATE)');
  gdb.pragma('journal_mode = DELETE');
  gdb.close();

  const manifest = {
    scale: options.scale,
    seed,
    schema,
    workspaces,
    composers,
    bubbles: bubbleRows,
    bigBubbles,
    otherRows,
    caseCollisionPairs: collisions.length,
    composersWithoutTimestamps: plan.filter((p) => p.missingTimes).length,
    composersWithoutWorkspace: plan.filter((p) => p.ws < 0).length,
    sampleComposerId: plan[Math.floor(plan.length / 2)].id,
    sampleWorkspacePath: wsPaths[plan[Math.floor(plan.length / 2)].ws >= 0 ? plan[Math.floor(plan.length / 2)].ws : 0],
    generationMs: Date.now() - t0,
  };
  writeFileSync(join(out, 'corpus-manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = parseArgs(process.argv.slice(2));
  const scale = args._[0] ?? 'small';
  const preset = PRESETS[scale];
  if (!preset && !(args.workspaces && args.composers && args.bubbles)) {
    console.error(`unknown scale "${scale}"; use small|medium|large`);
    process.exit(2);
  }
  const base = preset ?? {};
  const manifest = await generateCorpus({
    scale,
    out: args.out ?? join(perfDir(), `corpus-${scale}`),
    seed: Number(args.seed ?? 1),
    workspaces: Number(args.workspaces ?? base.workspaces),
    composers: Number(args.composers ?? base.composers),
    bubbles: Number(args.bubbles ?? base.bubbles),
    schema: args.schema ?? 'real',
    force: Boolean(args.force),
  });
  console.log(JSON.stringify(manifest, null, 2));
}
