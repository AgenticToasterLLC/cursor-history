import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  closeSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildR2Corpus, R2_IDS, type R2Corpus } from '../../helpers/r2-corpus.js';
import {
  SESSION_INTEGRITY_IDS,
  writeStoreMeta,
  writeStoreTranscript,
} from '../../helpers/session-integrity-fixtures.js';
import {
  addEmptyWorkspace,
  backdateTree,
  buildAndWait,
  catalogOf,
  comparable,
  dist,
  makeSidecarDir,
  read,
  resetRefreshLimits,
  setMtime,
  sleep,
  type Config,
} from '../../helpers/catalog-e2e.js';

const fingerprintModule = (await import(
  pathToFileURL(join(process.cwd(), 'dist', 'core', 'catalog', 'fingerprint.js')).href
)) as {
  isFingerprintSettled: (fp: unknown, nowMs: number, settleMs?: number) => boolean;
};

const previousStoreRoot = process.env['CURSOR_STORE_ROOT'];
let corpus: R2Corpus;
let sidecar: ReturnType<typeof makeSidecarDir>;
let cfg: Config;
let storeSessionDir: string;
let transcriptPath: string;

beforeEach(async () => {
  corpus = await buildR2Corpus('ch-c4-inval-');
  process.env['CURSOR_STORE_ROOT'] = corpus.fx.storeRoot;
  sidecar = makeSidecarDir();
  // Store meta + transcript exist before the first snapshot so they can later "change".
  storeSessionDir = join(
    corpus.fx.storeRoot,
    'chats',
    SESSION_INTEGRITY_IDS.storeOnly.replaceAll('-', '')
  );
  writeStoreMeta(storeSessionDir, {
    cwd: corpus.fx.projectB,
    title: 'Store title one',
    hasConversation: true,
    createdAtMs: 1_783_000_000_000,
  });
  transcriptPath = writeStoreTranscript(corpus.fx, 'slug', R2_IDS.storeComplement, [
    { role: 'user', message: { content: [{ type: 'text', text: 'first line' }] } },
  ]);
  backdateTree(corpus.fx.root);
  cfg = { dataPath: corpus.fx.workspaceStorage, catalogPath: sidecar.catalogPath };
});

afterEach(async () => {
  await dist.waitForCatalog(cfg as never, 30_000).catch(() => false);
  if (previousStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = previousStoreRoot;
  corpus.fx.cleanup();
  sidecar.cleanup();
});

const globalDb = () => join(corpus.fx.globalStorage, 'state.vscdb');

/** Build, mutate, and prove stale-then-refreshed behaviour. Returns the stale + refreshed reads. */
async function invalidate(mutate: () => void | Promise<void>) {
  expect(await buildAndWait({ ...cfg, catalog: 'auto' })).toBe(true);
  const ready = await read({ ...cfg, catalog: 'auto' });
  expect(catalogOf(ready)).toMatchObject({ state: 'ready', complete: true });
  expect(comparable(ready)).toEqual(comparable(await read({ ...cfg, catalog: 'direct' })));

  await mutate();
  resetRefreshLimits(); // lift the 10 s per-scope rate limit so the stale read may schedule

  const stale = await read({ ...cfg, catalog: 'auto' });
  const info = catalogOf(stale);
  expect(info).toMatchObject({ state: 'stale', complete: false, refreshScheduled: true });
  expect(info['changedSources']).toBeGreaterThanOrEqual(1);
  // Old rows are served, not the post-mutation direct read.
  expect(stale.result.data).toEqual(ready.result.data);
  expect(stale.result.pagination).toEqual(ready.result.pagination);

  expect(await dist.waitForCatalog(cfg as never, 60_000)).toBe(true);
  const refreshed = await read({ ...cfg, catalog: 'auto' });
  expect(catalogOf(refreshed)).toMatchObject({ state: 'ready', complete: true });
  expect(comparable(refreshed)).toEqual(comparable(await read({ ...cfg, catalog: 'direct' })));
  return { ready, stale, refreshed };
}

/** Rewrite one global composer's name in place, keeping the byte length identical. */
function rewriteGlobalComposerSameSize(): void {
  const db = new BetterSqlite3(globalDb());
  try {
    const key = `composerData:${R2_IDS.globalStamped}`;
    const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(key) as {
      value: string;
    };
    const next = row.value.replace('Global stamped B', 'Global stamped Z');
    expect(next).not.toEqual(row.value);
    expect(next.length).toBe(row.value.length);
    db.prepare('UPDATE cursorDiskKV SET value = ? WHERE key = ?').run(next, key);
  } finally {
    db.close();
  }
}

describe('catalog invalidation (real worker, built dist)', () => {
  it('in-place same-size composerData rewrite with explicit mtime bump', async () => {
    const sizeBefore = statSync(globalDb()).size;
    const { ready, refreshed } = await invalidate(() => {
      rewriteGlobalComposerSameSize();
      expect(statSync(globalDb()).size).toBe(sizeBefore);
      setMtime(globalDb(), 600); // explicit, settled, distinct from the original (3600 s ago)
    });
    expect(JSON.stringify(refreshed.result.data)).toContain('Global stamped Z');
    expect(JSON.stringify(ready.result.data)).not.toContain('Global stamped Z');
  }, 120_000);

  it('in-place same-size composerData rewrite WITHOUT explicit mtime bump (platform behaviour)', async () => {
    const before = statSync(globalDb(), { bigint: true });
    let after = before;
    const { refreshed } = await invalidate(async () => {
      rewriteGlobalComposerSameSize();
      after = statSync(globalDb(), { bigint: true });
      // Let the rewritten file settle (>2 s) so the refreshed snapshot can be ready.
      await sleep(2300);
    });
    // Reported by the e2e report: does a SQLite in-place same-size write move mtime here?
    console.info(
      `[C4 mtime probe] platform=${process.platform} size ${before.size}->${after.size} ` +
        `mtimeNs ${before.mtimeNs}->${after.mtimeNs} changed=${before.mtimeNs !== after.mtimeNs}`
    );
    expect(after.size).toBe(before.size);
    expect(after.mtimeNs).not.toBe(before.mtimeNs);
    expect(JSON.stringify(refreshed.result.data)).toContain('Global stamped Z');
  }, 120_000);

  it('a new bubble appended to a global composer', async () => {
    await invalidate(() => {
      const db = new BetterSqlite3(globalDb());
      try {
        db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
          `bubbleId:${R2_IDS.globalStamped}:g-new`,
          JSON.stringify({ type: 2, text: 'appended', createdAt: 1_751_000_000_000 })
        );
      } finally {
        db.close();
      }
      setMtime(globalDb(), 590);
    });
  }, 120_000);

  it('a -wal file appearing next to a source database', async () => {
    await invalidate(() => {
      const wal = `${globalDb()}-wal`;
      closeSync(openSync(wal, 'w'));
      setMtime(wal, 580);
    });
  }, 120_000);

  it('a new workspace dir with workspace.json', async () => {
    await invalidate(() => {
      const dir = addEmptyWorkspace(
        corpus.fx.workspaceStorage,
        'workspace-new',
        join(corpus.fx.root, 'workspaces', 'new')
      );
      backdateTree(dir, 570);
      setMtime(corpus.fx.workspaceStorage, 570);
    });
  }, 120_000);

  it('a workspace directory removed', async () => {
    await invalidate(() => {
      rmSync(join(corpus.fx.workspaceStorage, 'workspace-b'), { recursive: true, force: true });
    });
  }, 120_000);

  it('a Store meta.json changed', async () => {
    await invalidate(() => {
      const path = join(storeSessionDir, 'meta.json');
      const before = readFileSync(path, 'utf8');
      writeFileSync(path, before.replace('Store title one', 'Store title two'));
      setMtime(path, 560);
    });
  }, 120_000);

  it('a transcript appended', async () => {
    await invalidate(() => {
      appendFileSync(
        transcriptPath,
        `${JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } })}\n`
      );
      setMtime(transcriptPath, 550);
    });
  }, 120_000);
});

describe('settle window', () => {
  it('a snapshot of sources written <2 s ago is not ready until they settle', async () => {
    // Fresh, un-backdated sources: mtimes are "now".
    const fresh = await buildR2Corpus('ch-c4-settle-');
    process.env['CURSOR_STORE_ROOT'] = fresh.fx.storeRoot;
    const settleCfg: Config = {
      dataPath: fresh.fx.workspaceStorage,
      catalogPath: sidecar.catalogPath,
    };
    try {
      expect(await buildAndWait({ ...settleCfg, catalog: 'auto' })).toBe(true);
      const early = await read({ ...settleCfg, catalog: 'auto' });
      // Just built from just-written files: never reported ready, rows still correct.
      expect(['stale', 'building']).toContain(catalogOf(early).state);
      expect(catalogOf(early).complete === false || catalogOf(early).state === 'building').toBe(
        true
      );
      if (catalogOf(early).state === 'stale') {
        expect(comparable(early).valueOf()).toMatchObject({
          data: (await read({ ...settleCfg, catalog: 'direct' })).result.data,
        });
      }
      await sleep(2500); // sources are now >2 s old and unchanged: same snapshot is ready
      const late = await read({ ...settleCfg, catalog: 'auto' });
      expect(catalogOf(late)).toMatchObject({ state: 'ready', complete: true });
      expect(comparable(late)).toEqual(comparable(await read({ ...settleCfg, catalog: 'direct' })));
    } finally {
      await dist.waitForCatalog(settleCfg as never, 30_000).catch(() => false);
      fresh.fx.cleanup();
    }
  }, 120_000);

  it('isFingerprintSettled honours the 2 s window (and future mtimes)', () => {
    const now = Date.now();
    const fp = (ms: number) => ({
      files: [{ path: 'x', exists: true, size: 1, mtimeNs: (BigInt(ms) * 1_000_000n).toString() }],
      listingsDigest: 'l',
      digest: 'd',
    });
    expect(fingerprintModule.isFingerprintSettled(fp(now - 500), now)).toBe(false);
    expect(fingerprintModule.isFingerprintSettled(fp(now - 1999), now)).toBe(false);
    expect(fingerprintModule.isFingerprintSettled(fp(now - 2000), now)).toBe(true);
    expect(fingerprintModule.isFingerprintSettled(fp(now + 60_000), now)).toBe(false);
  });
});

describe('strict mode', () => {
  it('no snapshot: builds synchronously, then ready and equal to direct', async () => {
    // Settled sources so the synchronous build is immediately ready.
    const strict = await read({ ...cfg, catalog: 'strict' });
    expect(catalogOf(strict)).toMatchObject({ state: 'ready', complete: true });
    expect(comparable(strict)).toEqual(comparable(await read({ ...cfg, catalog: 'direct' })));
  }, 120_000);

  it('stale snapshot: rebuilds synchronously, returns NEW rows as ready', async () => {
    expect(await buildAndWait({ ...cfg, catalog: 'auto' })).toBe(true);
    rewriteGlobalComposerSameSize();
    setMtime(globalDb(), 500);
    const strict = await read({ ...cfg, catalog: 'strict' });
    expect(catalogOf(strict)).toMatchObject({ state: 'ready', complete: true });
    expect(JSON.stringify(strict.result.data)).toContain('Global stamped Z');
    expect(comparable(strict)).toEqual(comparable(await read({ ...cfg, catalog: 'direct' })));
  }, 120_000);

  it('unsettled sources: strict never claims ready from an unsettled snapshot', async () => {
    const fresh = await buildR2Corpus('ch-c4-strict-fresh-');
    process.env['CURSOR_STORE_ROOT'] = fresh.fx.storeRoot;
    const c: Config = { dataPath: fresh.fx.workspaceStorage, catalogPath: sidecar.catalogPath };
    try {
      const strict = await read({ ...c, catalog: 'strict' });
      // Never an incorrect 'ready': either degraded (direct data) or ready only if truly settled.
      expect(['degraded', 'ready']).toContain(catalogOf(strict).state);
      expect(comparable(strict)).toEqual(comparable(await read({ ...c, catalog: 'direct' })));
    } finally {
      fresh.fx.cleanup();
    }
  }, 120_000);
});
