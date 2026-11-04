import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const state = vi.hoisted(() => ({
  corpus: [] as unknown[],
  directCalls: 0,
}));

vi.mock('../../src/core/storage.js', async () => {
  const scopeState = await import('../../src/core/workspace-scope-state.js');
  return {
    createSessionReadContext: () => ({ dispose: async () => undefined }),
    listSessionSummaries: async (
      opts: { workspacePath?: string },
      _d: unknown,
      _b: unknown,
      context: object
    ) => {
      state.directCalls += 1;
      if (opts.workspacePath) {
        scopeState.recordWorkspaceScope(context, {
          state: 'matched',
          requested: opts.workspacePath,
          path: '/w',
          matchKind: 'exact',
        } as never);
      }
      return state.corpus;
    },
  };
});

import { listSessionSummaries, getCatalogStatus, refreshCatalog } from '../../src/lib/index.js';
import { setCatalogDepsForTesting } from '../../src/core/catalog/catalog-deps.js';
import { validateConfig } from '../../src/lib/config.js';
import { InvalidConfigError } from '../../src/lib/errors.js';
import { createFakeCatalog, type FakeCatalogState } from '../helpers/catalog-read-fakes.js';
import type { CatalogDeps } from '../../src/core/catalog/catalog-deps.js';
import type { LibraryConfig } from '../../src/lib/types.js';

const N = 4;
const when = new Date('2024-01-15T10:00:00Z');

function coreSummary(i: number) {
  return {
    id: `s${i}`,
    index: i + 1,
    title: `T${i}`,
    createdAt: when,
    lastUpdatedAt: when,
    messageCount: i,
    workspaceId: 'ws1',
    workspacePath: '~/proj',
    preview: 'p',
  };
}

const dataPath = join(tmpdir(), 'catalog-read-test', 'workspaceStorage');
const base: LibraryConfig = { dataPath };

let fake: { state: FakeCatalogState; deps: CatalogDeps };

/** Build a ready snapshot for config by capturing the refresh request and running the fake builder. */
async function seedReady(config: LibraryConfig): Promise<void> {
  await listSessionSummaries({ ...config, catalog: 'auto' });
  const request = (fake.state.refreshRequests as Array<Record<string, unknown>>).at(-1)!;
  await fake.deps.buildCatalogSnapshot({
    type: 'build',
    jobId: 'seed',
    ...(request as object),
  } as never);
  fake.state.refreshRequests.length = 0;
  fake.state.touched.length = 0;
}

beforeEach(() => {
  state.corpus = Array.from({ length: N }, (_, i) => coreSummary(i));
  state.directCalls = 0;
  fake = createFakeCatalog();
  fake.state.readDirect = async (readConfig) => {
    const out = await listSessionSummaries({ ...(readConfig as LibraryConfig), catalog: 'direct' });
    return { rows: out.data, diagnostics: out.diagnostics, scope: out.scope };
  };
  setCatalogDepsForTesting(fake.deps);
});

afterEach(() => setCatalogDepsForTesting(undefined));

describe('catalog equivalence', () => {
  for (const [label, extra] of [
    ['global', {}],
    ['workspace-scoped', { workspace: '/w' }],
  ] as const) {
    it(`ready snapshot equals direct for every offset/limit (${label})`, async () => {
      const config = { ...base, ...extra };
      await seedReady(config);
      for (let offset = 0; offset <= N + 1; offset++) {
        for (let limit = 1; limit <= N + 1; limit++) {
          const direct = await listSessionSummaries({ ...config, offset, limit });
          const viaCatalog = await listSessionSummaries({
            ...config,
            offset,
            limit,
            catalog: 'auto',
          });
          expect(viaCatalog.catalog?.state).toBe('ready');
          expect(viaCatalog.data).toEqual(direct.data);
          expect(viaCatalog.pagination).toEqual(direct.pagination);
          expect(viaCatalog.diagnostics).toEqual(direct.diagnostics);
          expect(viaCatalog.scope).toEqual(direct.scope);
        }
      }
    });
  }

  it('ready without limit matches direct pagination', async () => {
    await seedReady(base);
    const direct = await listSessionSummaries(base);
    const cat = await listSessionSummaries({ ...base, catalog: 'strict' });
    expect(cat.pagination).toEqual(direct.pagination);
    expect(cat.data).toEqual(direct.data);
  });
});

describe('catalog state machine', () => {
  it('ready: complete, verified, touched, no direct read', async () => {
    await seedReady(base);
    const before = state.directCalls;
    const r = await listSessionSummaries({ ...base, catalog: 'auto' });
    expect(r.catalog).toMatchObject({ state: 'ready', complete: true });
    expect(r.catalog?.snapshotBuiltAt).toBeDefined();
    expect(r.catalog?.verifiedAt).toBeDefined();
    expect(fake.state.touched).toHaveLength(1);
    expect(state.directCalls).toBe(before);
  });

  it('stale + auto: serves old rows, complete false, refresh requested', async () => {
    await seedReady(base);
    fake.state.sourceDigest = 'fp-2';
    state.corpus = [coreSummary(0)];
    const r = await listSessionSummaries({ ...base, catalog: 'auto' });
    expect(r.catalog).toMatchObject({
      state: 'stale',
      complete: false,
      changedSources: 3,
      refreshScheduled: true,
    });
    expect(r.data).toHaveLength(N);
    expect(fake.state.refreshRequests).toHaveLength(1);
  });

  it('unsettled fingerprint is stale even when digests match', async () => {
    await seedReady(base);
    fake.state.settled = false;
    const r = await listSessionSummaries({ ...base, catalog: 'auto' });
    expect(r.catalog?.state).toBe('stale');
    expect(r.catalog?.complete).toBe(false);
    expect(r.catalog?.changedSources).toBeGreaterThanOrEqual(1);
  });

  it('stale + strict: rebuilds synchronously and serves ready', async () => {
    await seedReady(base);
    fake.state.sourceDigest = 'fp-2';
    state.corpus = [coreSummary(0), coreSummary(1)];
    const builds = fake.state.builds;
    const r = await listSessionSummaries({ ...base, catalog: 'strict' });
    expect(fake.state.builds).toBe(builds + 1);
    expect(r.catalog).toMatchObject({ state: 'ready', complete: true });
    expect(r.data).toHaveLength(2);
  });

  it('stale + strict with failing build: direct read, degraded', async () => {
    await seedReady(base);
    fake.state.sourceDigest = 'fp-2';
    fake.state.buildResult = 'failed';
    state.corpus = [coreSummary(0)];
    const r = await listSessionSummaries({ ...base, catalog: 'strict' });
    expect(r.catalog).toMatchObject({ state: 'degraded', complete: true, reason: 'BUILD_FAILED' });
    expect(r.data).toHaveLength(1);
  });

  it('missing + auto: complete direct result, building, refresh requested', async () => {
    const r = await listSessionSummaries({ ...base, catalog: 'auto' });
    expect(r.catalog).toEqual({ state: 'building', complete: true, refreshScheduled: true });
    expect(r.data).toHaveLength(N);
    expect(fake.state.refreshRequests).toHaveLength(1);
  });

  it('missing + strict: builds synchronously then serves ready', async () => {
    const r = await listSessionSummaries({ ...base, catalog: 'strict' });
    expect(fake.state.builds).toBe(1);
    expect(r.catalog).toMatchObject({ state: 'ready', complete: true });
    expect(r.data).toHaveLength(N);
  });

  it('degraded: store failure falls back to direct with content-free reason', async () => {
    fake.state.failOpen = true;
    for (const catalog of ['auto', 'strict'] as const) {
      const r = await listSessionSummaries({ ...base, catalog });
      expect(r.catalog).toEqual({
        state: 'degraded',
        complete: true,
        reason: 'CATALOG_UNAVAILABLE',
      });
      expect(JSON.stringify(r.catalog)).not.toContain('secret');
      expect(r.data).toHaveLength(N);
    }
  });

  it('degraded: unloadable catalog modules fall back to direct', async () => {
    setCatalogDepsForTesting(undefined); // C1/C2 modules absent on this branch or broken
    const r = await listSessionSummaries({ ...base, catalog: 'auto' });
    expect(r.data).toHaveLength(N);
    expect(r.catalog?.complete).toBe(true);
  });

  it('complete:false is never paired with ready, stale is never complete', async () => {
    const seen: Array<{ state: string; complete: boolean }> = [];
    seen.push((await listSessionSummaries({ ...base, catalog: 'auto' })).catalog!);
    seen.push((await listSessionSummaries({ ...base, catalog: 'strict' })).catalog!);
    fake.state.sourceDigest = 'fp-9';
    seen.push((await listSessionSummaries({ ...base, catalog: 'auto' })).catalog!);
    fake.state.failOpen = true;
    seen.push((await listSessionSummaries({ ...base, catalog: 'auto' })).catalog!);
    for (const info of seen) {
      if (info.state === 'ready') expect(info.complete).toBe(true);
      if (info.state === 'stale') expect(info.complete).toBe(false);
      if (!info.complete) expect(info.state).toBe('stale');
    }
  });
});

describe('refresh disclosure and strict settle wait', () => {
  it('reports a rate-limited refresh as not scheduled', async () => {
    await seedReady(base);
    fake.state.sourceDigest = 'fp-2';
    fake.state.rateLimited = true;
    const r = await listSessionSummaries({ ...base, catalog: 'auto' });
    expect(r.catalog).toMatchObject({
      state: 'stale',
      refreshScheduled: false,
      refreshRateLimited: true,
    });
    const missing = await listSessionSummaries({
      dataPath: join(tmpdir(), 'catalog-read-rate', 'workspaceStorage'),
      catalog: 'auto',
    });
    expect(missing.catalog).toMatchObject({
      state: 'building',
      refreshScheduled: false,
      refreshRateLimited: true,
    });
    fake.state.rateLimited = false;
    const ok = await listSessionSummaries({ ...base, catalog: 'auto' });
    expect(ok.catalog?.refreshScheduled).toBe(true);
    expect(ok.catalog && 'refreshRateLimited' in ok.catalog).toBe(false);
  });

  it('refreshCatalog returns rateLimited', async () => {
    fake.state.rateLimited = true;
    const own: LibraryConfig = {
      dataPath: join(tmpdir(), 'catalog-read-rate2', 'workspaceStorage'),
    };
    expect(await refreshCatalog(own)).toEqual({
      jobId: 'job-1',
      alreadyRunning: false,
      rateLimited: true,
    });
  });

  it('strict waits out an unsettled fingerprint and serves ready', async () => {
    fake.state.settled = false;
    fake.state.settleAfterChecks = 2;
    const r = await listSessionSummaries({ ...base, catalog: 'strict' });
    expect(r.catalog).toMatchObject({ state: 'ready', complete: true });
  });

  it('strict reports CHANGED_DURING_BUILD only when the sources really changed', async () => {
    const direct = fake.state.readDirect!;
    fake.state.readDirect = async (readConfig) => {
      const out = await direct(readConfig);
      fake.state.sourceDigest = 'fp-moved';
      return out;
    };
    // The fake builder stamps the header with the digest current at publish time ('fp-moved'
    // is set after the read, before publish); change it again afterwards to simulate a change.
    const build = fake.deps.buildCatalogSnapshot;
    fake.deps.buildCatalogSnapshot = async (request) => {
      const response = await build(request);
      fake.state.sourceDigest = 'fp-moved-again';
      return response;
    };
    const r = await listSessionSummaries({ ...base, catalog: 'strict' });
    expect(r.catalog).toMatchObject({
      state: 'degraded',
      reason: 'CHANGED_DURING_BUILD',
    });
  });
});

describe('direct mode and fallback rules', () => {
  it('default and explicit direct have no catalog field and are byte-identical', async () => {
    const a = await listSessionSummaries(base);
    const b = await listSessionSummaries({ ...base, catalog: 'direct' });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect('catalog' in a).toBe(false);
    expect(fake.state.refreshRequests).toHaveLength(0);
  });

  it.each([
    ['backupPath', { backupPath: join(tmpdir(), 'x.zip') }],
    ['diagnostics', { diagnostics: { onEvent: () => undefined } }],
    ['ioObserver', { ioObserver: () => undefined }],
  ])('%s forces direct with state unavailable', async (reason, extra) => {
    const r = await listSessionSummaries({
      ...base,
      ...(extra as object),
      catalog: 'auto',
    } as LibraryConfig);
    expect(r.catalog).toEqual({ state: 'unavailable', complete: true, reason });
    expect(fake.state.refreshRequests).toHaveLength(0);
    expect(fake.state.builds).toBe(0);
  });
});

describe('config validation and status', () => {
  it('validates catalog and catalogPath', () => {
    expect(() => validateConfig({ catalog: 'auto', catalogPath: 'x' })).not.toThrow();
    expect(() => validateConfig({ catalog: 'bogus' as never })).toThrow(InvalidConfigError);
    expect(() => validateConfig({ catalogPath: '' })).toThrow(InvalidConfigError);
  });

  it('getCatalogStatus reports the scope content-free; refreshCatalog schedules', async () => {
    // Own scope: in-process refresh tracking is module-level.
    const own: LibraryConfig = {
      dataPath: join(tmpdir(), 'catalog-read-status', 'workspaceStorage'),
    };
    const before = await getCatalogStatus(own);
    expect(before.enabled).toBe(true);
    expect(before.scopes[0]).toMatchObject({ state: 'unavailable', building: false });
    const job = await refreshCatalog(own);
    expect(job).toEqual({ jobId: 'job-1', alreadyRunning: false });
    expect((await getCatalogStatus(own)).scopes[0]).toMatchObject({
      state: 'building',
      building: true,
    });
    await seedReady(own);
    expect((await getCatalogStatus(own)).scopes[0]).toMatchObject({
      state: 'ready',
      rowCount: N,
      building: false,
    });
  });

  it('refreshCatalog rejects ineligible configs', async () => {
    await expect(refreshCatalog({ ...base, backupPath: 'x' })).rejects.toBeInstanceOf(
      InvalidConfigError
    );
  });
});
