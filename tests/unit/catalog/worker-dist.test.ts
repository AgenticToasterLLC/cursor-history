import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { listSessionSummaries } from '../../../src/lib/index.js';
import type { CatalogScopeKey } from '../../../src/core/catalog/contract.js';
import { createFakeLock, fakeDigest } from '../../helpers/catalog-fakes.js';
import {
  createSessionIntegrityFixtureRoot,
  seedConflictingWorkspaceCorpus,
  type SessionIntegrityFixtureRoot,
} from '../../helpers/session-integrity-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const W = join(root, 'tests/helpers/catalog-workers');
const targets = {
  esm: join(root, 'dist/core/catalog/refresh.js'),
  cjs: join(root, 'dist/cjs/core/catalog/refresh.js'),
};

type Refresh = typeof import('../../../src/core/catalog/refresh.js');
async function load(kind: 'esm' | 'cjs'): Promise<Refresh> {
  if (kind === 'cjs') return createRequire(import.meta.url)(targets.cjs) as Refresh;
  return (await import(pathToFileURL(targets.esm).href)) as Refresh;
}

const fixtures: SessionIntegrityFixtureRoot[] = [];
const tmps: string[] = [];
const originalStoreRoot = process.env['CURSOR_STORE_ROOT'];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
  for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true });
  if (originalStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = originalStoreRoot;
});

describe.each(['esm', 'cjs'] as const)('built catalog worker (%s entry)', (kind) => {
  it('has the worker file next to the entry', () => {
    expect(existsSync(join(targets[kind], '..', 'catalog-worker.js'))).toBe(true);
  });

  it('spawns a real worker via default path resolution and publishes the direct rows', async () => {
    const fixture = createSessionIntegrityFixtureRoot('catalog-worker-');
    fixtures.push(fixture);
    process.env['CURSOR_STORE_ROOT'] = fixture.storeRoot;
    seedConflictingWorkspaceCorpus(fixture);
    const outDir = mkdtempSync(join(tmpdir(), 'catalog-out-'));
    tmps.push(outDir);
    const out = join(outDir, 'published.json');
    const scopeKey: CatalogScopeKey = {
      dataPath: fixture.workspaceStorage,
      storeRoot: fixture.storeRoot,
      workspace: null,
      includeCrossWorkspaceSources: false,
      sourceReadLimits: {},
      schemaVersion: 1,
      projectionEpoch: 1,
      readerVersion: 't',
    };
    const lock = createFakeLock();
    const mod = await load(kind);
    const r = mod.requestCatalogRefresh(
      { scopeKey, readConfig: { dataPath: fixture.workspaceStorage }, storePath: out },
      {
        deps: { createCatalogLock: lock.createCatalogLock, digestScopeKey: fakeDigest },
        testDepsModule: join(W, 'deps.cjs'),
        minIntervalMs: 0,
      }
    );
    expect(r.alreadyRunning).toBe(false);
    const res = await mod.waitForCatalogBuild(fakeDigest(scopeKey), 60_000);
    expect(res).toMatchObject({ type: 'done', rowCount: 2 });
    expect(lock.state.held.size).toBe(0);
    const published = JSON.parse(readFileSync(out, 'utf8')) as { rows: string[] };
    const direct = await listSessionSummaries({ dataPath: fixture.workspaceStorage });
    expect(published.rows).toEqual(direct.data.map((x) => JSON.stringify(x)));
  }, 90_000);

  it('does not keep the process alive (worker is unref-ed)', () => {
    const res = spawnSync(
      process.execPath,
      [join(W, 'unref-child.mjs'), targets[kind], join(W, 'hang.cjs')],
      { encoding: 'utf8', timeout: 20_000 }
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('"alreadyRunning":false');
  });
});

describe('kill mid-build', () => {
  it('publishes nothing and releases the lock when terminated during the read', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'catalog-kill-'));
    tmps.push(outDir);
    const out = join(outDir, 'published.json');
    const scopeKey: CatalogScopeKey = {
      dataPath: 'x',
      storeRoot: null,
      workspace: null,
      includeCrossWorkspaceSources: false,
      sourceReadLimits: {},
      schemaVersion: 1,
      projectionEpoch: 1,
      readerVersion: 't',
    };
    const lock = createFakeLock();
    const mod = await load('esm');
    mod.requestCatalogRefresh(
      { scopeKey, readConfig: {}, storePath: out },
      {
        deps: { createCatalogLock: lock.createCatalogLock, digestScopeKey: fakeDigest },
        testDepsModule: join(W, 'hang-deps.cjs'),
        minIntervalMs: 0,
      }
    );
    await new Promise((r) => setTimeout(r, 500));
    expect(lock.state.held.size).toBe(1);
    await mod.cancelCatalogRefreshes();
    expect(lock.state.held.size).toBe(0);
    expect(existsSync(out)).toBe(false);
  });
});
