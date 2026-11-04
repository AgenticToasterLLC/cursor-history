import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openCatalogStoreAsync,
  type CatalogStoreExtended,
} from '../../../src/core/catalog/store.js';
import {
  cancelCatalogRefreshes,
  getCatalogRefreshLastError,
  requestCatalogRefresh,
  resetCatalogRefreshState,
  waitForCatalogBuild,
} from '../../../src/core/catalog/refresh.js';
import type { CatalogScopeKey } from '../../../src/core/catalog/contract.js';
import { createFakeLock, fakeDigest } from '../../helpers/catalog-fakes.js';

const W = resolve(dirname(fileURLToPath(import.meta.url)), '../../helpers/catalog-workers');
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
const digest = fakeDigest(scopeKey);
const req = { scopeKey, readConfig: {}, storePath: 'fake' };

function opts(lock: ReturnType<typeof createFakeLock>, worker: string, extra = {}) {
  return {
    deps: { createCatalogLock: lock.createCatalogLock, digestScopeKey: fakeDigest },
    workerPath: join(W, worker),
    minIntervalMs: 0,
    ...extra,
  };
}

afterEach(async () => {
  await cancelCatalogRefreshes();
  resetCatalogRefreshState();
});

describe('requestCatalogRefresh', () => {
  it('is single-flight and releases the lock after done', async () => {
    const lock = createFakeLock();
    const a = requestCatalogRefresh(req, opts(lock, 'hang.cjs'));
    const b = requestCatalogRefresh(req, opts(lock, 'hang.cjs'));
    expect(a.alreadyRunning).toBe(false);
    expect(b).toMatchObject({ alreadyRunning: true, jobId: a.jobId });
    expect(lock.state.acquired).toBe(1);
    await cancelCatalogRefreshes();
    expect(lock.state.released).toBe(1);

    const c = requestCatalogRefresh(req, opts(lock, 'ok.cjs'));
    const res = await waitForCatalogBuild(digest, 10_000);
    expect(res).toMatchObject({ type: 'done', jobId: c.jobId });
    expect(lock.state.held.size).toBe(0);
  });

  it('returns alreadyRunning without spawning when the lock is held elsewhere', () => {
    const lock = createFakeLock();
    lock.state.held.add(digest);
    const r = requestCatalogRefresh(req, opts(lock, 'hang.cjs'));
    expect(r.alreadyRunning).toBe(true);
    expect(lock.state.acquired).toBe(0);
  });

  it('turns a throwing worker into failed and releases the lock', async () => {
    const lock = createFakeLock();
    requestCatalogRefresh(req, opts(lock, 'throw.cjs'));
    const res = await waitForCatalogBuild(digest, 10_000);
    expect(res).toMatchObject({ type: 'failed', code: 'WORKER_CRASHED' });
    expect(JSON.stringify(res)).not.toContain('secret');
    expect(lock.state.held.size).toBe(0);
    expect(getCatalogRefreshLastError(digest)?.code).toBe('WORKER_CRASHED');
  });

  it('persists a worker crash as the scope lastError in the sidecar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'refresh-lasterror-'));
    const storePath = join(dir, 'catalog.sqlite');
    try {
      (await openCatalogStoreAsync({ path: storePath })).close();
      const lock = createFakeLock();
      requestCatalogRefresh({ ...req, storePath }, opts(lock, 'throw.cjs'));
      await waitForCatalogBuild(digest, 10_000);
      let recorded: { code: string } | undefined;
      for (let i = 0; i < 40 && !recorded; i++) {
        const store = (await openCatalogStoreAsync({ path: storePath })) as CatalogStoreExtended;
        try {
          recorded = store.getScopeState(digest)?.lastError;
        } finally {
          store.close();
        }
        if (!recorded) await new Promise((r) => setTimeout(r, 50));
      }
      expect(recorded?.code).toBe('WORKER_CRASHED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('turns a non-zero exit into failed', async () => {
    const lock = createFakeLock();
    requestCatalogRefresh(req, opts(lock, 'exit1.cjs'));
    const res = await waitForCatalogBuild(digest, 10_000);
    expect(res).toMatchObject({ type: 'failed', code: 'WORKER_EXIT' });
    expect(lock.state.held.size).toBe(0);
  });

  it('terminate cancels a running build and releases the lock', async () => {
    const lock = createFakeLock();
    requestCatalogRefresh(req, opts(lock, 'hang.cjs'));
    const wait = waitForCatalogBuild(digest, 10_000);
    await cancelCatalogRefreshes();
    expect(await wait).toMatchObject({ type: 'failed', code: 'BUILD_CANCELLED' });
    expect(lock.state.held.size).toBe(0);
  });

  it('rate limits a rebuild right after a finish unless forced', async () => {
    const lock = createFakeLock();
    requestCatalogRefresh(req, opts(lock, 'ok.cjs', { minIntervalMs: 60_000 }));
    await waitForCatalogBuild(digest, 10_000);
    const r = requestCatalogRefresh(req, opts(lock, 'ok.cjs', { minIntervalMs: 60_000 }));
    expect(r.rateLimited).toBe(true);
    expect(lock.state.acquired).toBe(1);
    const f = requestCatalogRefresh(
      req,
      opts(lock, 'ok.cjs', { minIntervalMs: 60_000, force: true })
    );
    expect(f.rateLimited).toBeUndefined();
    expect(lock.state.acquired).toBe(2);
  });

  it('waitForCatalogBuild returns undefined when none is running or on timeout', async () => {
    const lock = createFakeLock();
    expect(await waitForCatalogBuild(digest, 10)).toBeUndefined();
    requestCatalogRefresh(req, opts(lock, 'hang.cjs'));
    expect(await waitForCatalogBuild(digest, 50)).toBeUndefined();
  });
});
