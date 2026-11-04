#!/usr/bin/env node
// Read-only snapshot of real Cursor data for performance profiling.
// Source DBs are opened {readonly:true, fileMustExist:true} only; nothing under the source is written.
// Output (never committed): <perfDir>/snapshot/User/{globalStorage,workspaceStorage/*}.
import { createHash } from 'node:crypto';
import { createReadStream, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadBetterSqlite3, parseArgs, perfDir } from './common.mjs';

const args = parseArgs(process.argv.slice(2));
const Database = loadBetterSqlite3();

function defaultSourceUser() {
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Cursor', 'User');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Cursor', 'User');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Cursor', 'User');
}

const srcUser = args.source ?? defaultSourceUser();
const destRoot = args.dest ?? join(perfDir(), 'snapshot');
const destUser = join(destRoot, 'User');
const maxRestarts = Number(args['max-restarts'] ?? 3);

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

function dbStats(path) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return {
      pageSize: db.pragma('page_size', { simple: true }),
      pageCount: db.pragma('page_count', { simple: true }),
      freelistCount: db.pragma('freelist_count', { simple: true }),
    };
  } finally {
    db.close();
  }
}

function cleanDest(dest) {
  rmSync(dest, { force: true });
  rmSync(`${dest}-wal`, { force: true });
  rmSync(`${dest}-shm`, { force: true });
}

async function snapshotOne(src, dest) {
  cleanDest(dest);
  const t0 = Date.now();
  const source = new Database(src, { readonly: true, fileMustExist: true });
  let method = 'online-backup';
  let restarts = 0;
  try {
    try {
      let lastTotal = -1;
      let lastRemaining = Infinity;
      await source.backup(dest, {
        progress({ totalPages, remainingPages }) {
          if (remainingPages > lastRemaining || (lastTotal >= 0 && totalPages !== lastTotal)) {
            restarts++;
            if (restarts > maxRestarts) throw new Error('backup restarting repeatedly');
          }
          lastTotal = totalPages;
          lastRemaining = remainingPages;
          return 1_000_000_000; // copy as many pages per step as possible (one read snapshot)
        },
      });
    } catch (err) {
      method = 'vacuum-into';
      console.log(`  online backup failed (${String(err.message).slice(0, 80)}); falling back to VACUUM INTO`);
      cleanDest(dest);
      source.prepare('VACUUM INTO ?').run(dest);
    }
  } finally {
    source.close();
  }
  const check = new Database(dest, { readonly: true });
  let jmode;
  try {
    jmode = check.pragma('journal_mode', { simple: true });
  } finally {
    check.close();
  }
  return { method, restarts, durationMs: Date.now() - t0, snapshotJournalMode: jmode };
}

async function main() {
  const globalSrc = join(srcUser, 'globalStorage', 'state.vscdb');
  if (!existsSync(globalSrc)) throw new Error('global state.vscdb not found at the source');
  const wsRoot = join(srcUser, 'workspaceStorage');
  const wsDirs = existsSync(wsRoot) ? readdirSync(wsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()) : [];

  // Disk space check: require 2.5x source size (including -wal) free at the destination.
  const sizeOf = (p) => (existsSync(p) ? statSync(p).size : 0);
  let sourceBytes = sizeOf(globalSrc) + sizeOf(`${globalSrc}-wal`);
  for (const d of wsDirs) sourceBytes += sizeOf(join(wsRoot, d.name, 'state.vscdb'));
  mkdirSync(destRoot, { recursive: true });
  const fsInfo = statfsSync(destRoot);
  const free = Number(fsInfo.bavail) * Number(fsInfo.bsize);
  console.log(`source bytes ${sourceBytes}, free ${free}`);
  if (free < 2.5 * sourceBytes) throw new Error(`insufficient free space: need ${Math.ceil(2.5 * sourceBytes)} have ${free}`);

  const startedAt = Date.now();
  const manifest = {
    createdAt: new Date(startedAt).toISOString(),
    note: 'Content-free manifest. Source is live: source sha256 is provenance only.',
    node: process.version,
    global: {},
    workspaces: [],
  };

  const gStatBefore = statSync(globalSrc);
  console.log('hashing source global DB (provenance only) ...');
  const tH = Date.now();
  const srcSha = await sha256File(globalSrc);
  manifest.global.source = {
    sizeBytes: gStatBefore.size,
    walSizeBytes: sizeOf(`${globalSrc}-wal`),
    mtime: gStatBefore.mtime.toISOString(),
    sha256BeforeCopy: srcSha,
    sha256DurationMs: Date.now() - tH,
    ...dbStats(globalSrc),
  };

  mkdirSync(join(destUser, 'globalStorage'), { recursive: true });
  const gDest = join(destUser, 'globalStorage', 'state.vscdb');
  console.log('snapshotting global DB ...');
  const gRes = await snapshotOne(globalSrc, gDest);
  manifest.global.sourceMtimeAfter = statSync(globalSrc).mtime.toISOString();
  manifest.global.snapshot = { sizeBytes: statSync(gDest).size, ...gRes, ...dbStats(gDest) };
  manifest.global.layout =
    gRes.method === 'online-backup'
      ? 'page-for-page (original layout)'
      : 'compacted (VACUUM INTO); timings may understate fragmentation';
  console.log(`  global done: ${gRes.method}, ${gRes.durationMs} ms, restarts=${gRes.restarts}`);
  const tS = Date.now();
  manifest.global.snapshot.sha256 = await sha256File(gDest);
  manifest.global.snapshot.sha256DurationMs = Date.now() - tS;

  let i = 0;
  for (const d of wsDirs) {
    i++;
    const srcDb = join(wsRoot, d.name, 'state.vscdb');
    const entry = { index: i, hasStateDb: existsSync(srcDb), hasWorkspaceJson: false };
    const outDir = join(destUser, 'workspaceStorage', d.name);
    mkdirSync(outDir, { recursive: true });
    const wj = join(wsRoot, d.name, 'workspace.json');
    if (existsSync(wj)) {
      copyFileSync(wj, join(outDir, 'workspace.json'));
      entry.hasWorkspaceJson = true;
    }
    if (entry.hasStateDb) {
      const st = statSync(srcDb);
      entry.source = { sizeBytes: st.size, mtime: st.mtime.toISOString() };
      try {
        const out = join(outDir, 'state.vscdb');
        const res = await snapshotOne(srcDb, out);
        entry.snapshot = { ...res, sizeBytes: statSync(out).size, ...dbStats(out) };
      } catch (err) {
        entry.error = String(err.message).slice(0, 120);
      }
    }
    manifest.workspaces.push(entry);
  }
  manifest.workspaceSummary = {
    count: manifest.workspaces.length,
    withDb: manifest.workspaces.filter((w) => w.snapshot).length,
    totalSourceBytes: manifest.workspaces.reduce((a, w) => a + (w.source?.sizeBytes ?? 0), 0),
    totalSnapshotBytes: manifest.workspaces.reduce((a, w) => a + (w.snapshot?.sizeBytes ?? 0), 0),
    errors: manifest.workspaces.filter((w) => w.error).length,
  };
  manifest.totalDurationMs = Date.now() - startedAt;
  writeFileSync(join(destRoot, 'snapshot-manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ global: manifest.global.snapshot, workspaceSummary: manifest.workspaceSummary, totalDurationMs: manifest.totalDurationMs }, null, 2));
}

main().catch((err) => {
  console.error('snapshot failed:', err.message);
  process.exit(1);
});
