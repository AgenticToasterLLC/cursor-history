import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildR2Corpus, type R2Corpus } from '../../helpers/r2-corpus.js';
import {
  backdateTree,
  buildAndWait,
  catalogOf,
  comparable,
  dist,
  hashTree,
  makeSidecarDir,
  read,
  resetRefreshLimits,
  sleep,
  statTree,
  type Config,
} from '../../helpers/catalog-e2e.js';

const pathsMod = (await import(
  pathToFileURL(join(process.cwd(), 'dist', 'core', 'catalog', 'paths.js')).href
)) as { isInsideCursorDataDir: (p: string) => boolean; CATALOG_PATH_ENV: string };

const previousStoreRoot = process.env['CURSOR_STORE_ROOT'];
const previousIndexPath = process.env['CURSOR_HISTORY_INDEX_PATH'];
let corpus: R2Corpus;
let sidecar: ReturnType<typeof makeSidecarDir>;
let cfg: Config;

beforeEach(async () => {
  corpus = await buildR2Corpus('ch-c4-safety-');
  process.env['CURSOR_STORE_ROOT'] = corpus.fx.storeRoot;
  backdateTree(corpus.fx.root);
  sidecar = makeSidecarDir();
  cfg = { dataPath: corpus.fx.workspaceStorage, catalogPath: sidecar.catalogPath };
});

afterEach(async () => {
  await dist.waitForCatalog(cfg as never, 30_000).catch(() => false);
  if (previousStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = previousStoreRoot;
  if (previousIndexPath === undefined) delete process.env['CURSOR_HISTORY_INDEX_PATH'];
  else process.env['CURSOR_HISTORY_INDEX_PATH'] = previousIndexPath;
  corpus.fx.cleanup();
  sidecar.cleanup();
});

describe('corrupt sidecar', () => {
  async function assertSurvives(label: string, damage: () => void) {
    expect(await buildAndWait({ ...cfg, catalog: 'auto' })).toBe(true);
    expect(catalogOf(await read({ ...cfg, catalog: 'auto' })).state).toBe('ready');
    damage();
    const direct = comparable(await read({ ...cfg, catalog: 'direct' }));
    for (const mode of ['auto', 'strict'] as const) {
      const after = await read({ ...cfg, catalog: mode }); // must never throw
      console.info(`[C4 corrupt] ${label}/${mode} -> ${JSON.stringify(catalogOf(after))}`);
      expect(
        ['degraded', 'building', 'ready'],
        `${label}/${mode} -> ${catalogOf(after).state}`
      ).toContain(catalogOf(after).state);
      expect(catalogOf(after).complete).toBe(true);
      expect(comparable(after)).toEqual(direct);
    }
    // The cache is disposable: a rebuild converges to a ready snapshot.
    expect(await buildAndWait({ ...cfg, catalog: 'auto' })).toBe(true);
    const healed = await read({ ...cfg, catalog: 'auto' });
    expect(catalogOf(healed)).toMatchObject({ state: 'ready', complete: true });
    expect(comparable(healed)).toEqual(direct);
  }

  it('garbage bytes over the sidecar file', async () => {
    await assertSurvives('garbage', () => {
      for (const suffix of ['-wal', '-shm'])
        rmSync(`${sidecar.catalogPath}${suffix}`, { force: true });
      writeFileSync(sidecar.catalogPath, Buffer.from('this is not sqlite '.repeat(500)));
    });
  }, 120_000);

  it('truncated-to-empty sidecar file', async () => {
    await assertSurvives('empty', () => {
      for (const suffix of ['-wal', '-shm'])
        rmSync(`${sidecar.catalogPath}${suffix}`, { force: true });
      writeFileSync(sidecar.catalogPath, '');
    });
  }, 120_000);

  it('valid SQLite file with a foreign schema', async () => {
    await assertSurvives('foreign', () => {
      for (const suffix of ['-wal', '-shm'])
        rmSync(`${sidecar.catalogPath}${suffix}`, { force: true });
      rmSync(sidecar.catalogPath, { force: true });
      const db = new BetterSqlite3(sidecar.catalogPath);
      db.exec('CREATE TABLE unrelated (a TEXT); INSERT INTO unrelated VALUES (1)');
      db.close();
    });
  }, 120_000);

  it('garbage with no prior snapshot (cold) also degrades without throwing', async () => {
    writeFileSync(sidecar.catalogPath, Buffer.from('garbage'.repeat(2000)));
    const direct = comparable(await read({ ...cfg, catalog: 'direct' }));
    const auto = await read({ ...cfg, catalog: 'auto' });
    expect(['degraded', 'building']).toContain(catalogOf(auto).state);
    expect(comparable(auto)).toEqual(direct);
  }, 120_000);
});

describe('read-only sources', () => {
  it('a full auto build plus reads never modify any source file', async () => {
    const root = corpus.fx.root;
    // The sidecar is outside the fixture and outside any Cursor data dir.
    const rel = relative(resolve(root), resolve(sidecar.catalogPath));
    expect(
      rel.startsWith('..') || resolve(sidecar.catalogPath).indexOf(resolve(root) + sep) !== 0
    ).toBe(true);
    for (const dir of [corpus.fx.workspaceStorage, corpus.fx.globalStorage, corpus.fx.storeRoot]) {
      expect(resolve(sidecar.catalogPath).startsWith(resolve(dir) + sep)).toBe(false);
    }
    expect(pathsMod.isInsideCursorDataDir(sidecar.catalogPath)).toBe(false);

    const hashesBefore = hashTree(root);
    const statsBefore = statTree(root);

    const scoped: Config[] = [
      cfg,
      { ...cfg, workspace: corpus.fx.projectA },
      { ...cfg, workspace: corpus.fx.projectB, includeCrossWorkspaceSources: true },
    ];
    for (const config of scoped) {
      expect(await buildAndWait({ ...config, catalog: 'auto' })).toBe(true);
      expect(catalogOf(await read({ ...config, catalog: 'auto' })).state).toBe('ready');
      expect(catalogOf(await read({ ...config, catalog: 'strict' })).state).toBe('ready');
      await read({ ...config, catalog: 'direct' });
      await dist.getCatalogStatus(config as never);
    }

    expect(existsSync(sidecar.catalogPath)).toBe(true);
    expect(hashTree(root)).toEqual(hashesBefore); // same files (no -wal/-shm/-journal), same bytes
    expect(statTree(root)).toEqual(statsBefore); // not even touched
  }, 120_000);
});

describe('no default-path leak', () => {
  it('auto without catalogPath uses CURSOR_HISTORY_INDEX_PATH', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ch-c4-envpath-'));
    const target = join(dir, 'env-index.sqlite');
    process.env['CURSOR_HISTORY_INDEX_PATH'] = target;
    try {
      const envCfg: Config = { dataPath: corpus.fx.workspaceStorage }; // no catalogPath
      expect(existsSync(target)).toBe(false);
      const cold = await read({ ...envCfg, catalog: 'auto' });
      expect(comparable(cold)).toEqual(comparable(await read({ ...envCfg, catalog: 'direct' })));
      expect(await buildAndWait({ ...envCfg, catalog: 'auto' })).toBe(true);
      await sleep(0);
      expect(existsSync(target)).toBe(true);
      const ready = await read({ ...envCfg, catalog: 'auto' });
      expect(catalogOf(ready)).toMatchObject({ state: 'ready', complete: true });
      const status = await dist.getCatalogStatus(envCfg as never);
      expect(resolve(status.path ?? '')).toBe(resolve(target));
      expect(status.scopes.some((s) => s.rowCount !== undefined)).toBe(true);
      // Nothing was written next to the fixture sources either.
      expect(
        Object.keys(hashTree(corpus.fx.root)).some((p) => /catalog|index\.sqlite/.test(p))
      ).toBe(false);
    } finally {
      await dist
        .waitForCatalog({ dataPath: corpus.fx.workspaceStorage } as never, 30_000)
        .catch(() => false);
      resetRefreshLimits();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
