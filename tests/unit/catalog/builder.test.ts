import { afterEach, describe, expect, it } from 'vitest';
import { listSessionSummaries } from '../../../src/lib/index.js';
import { buildCatalogSnapshot } from '../../../src/core/catalog/builder.js';
import type { CatalogScopeKey, IndexerRequest } from '../../../src/core/catalog/contract.js';
import { createFakeEnv, fakeStoreDeps } from '../../helpers/catalog-fakes.js';
import {
  createSessionIntegrityFixtureRoot,
  seedConflictingWorkspaceCorpus,
  type SessionIntegrityFixtureRoot,
} from '../../helpers/session-integrity-fixtures.js';

const fixtures: SessionIntegrityFixtureRoot[] = [];
const originalStoreRoot = process.env['CURSOR_STORE_ROOT'];

afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
  if (originalStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = originalStoreRoot;
});

function setup(workspace: string | null) {
  const fixture = createSessionIntegrityFixtureRoot('catalog-builder-');
  fixtures.push(fixture);
  process.env['CURSOR_STORE_ROOT'] = fixture.storeRoot;
  seedConflictingWorkspaceCorpus(fixture);
  const scopeKey: CatalogScopeKey = {
    dataPath: fixture.workspaceStorage,
    storeRoot: fixture.storeRoot,
    workspace: workspace === 'A' ? fixture.projectA : null,
    includeCrossWorkspaceSources: false,
    sourceReadLimits: {},
    schemaVersion: 1,
    projectionEpoch: 2,
    readerVersion: 'test',
  };
  const request: IndexerRequest = {
    type: 'build',
    jobId: 'job-1',
    scopeKey,
    readConfig: { dataPath: fixture.workspaceStorage },
    storePath: 'fake',
  };
  return { fixture, scopeKey, request };
}

describe('buildCatalogSnapshot', () => {
  for (const scope of [null, 'A']) {
    it(`publishes rows byte-identical to the direct read (${scope ?? 'global'})`, async () => {
      const { fixture, request } = setup(scope);
      const env = createFakeEnv();
      const deps = {
        ...fakeStoreDeps(env),
        listSessionSummaries: async (c?: Parameters<typeof listSessionSummaries>[0]) => {
          env.calls.push('read');
          return listSessionSummaries(c);
        },
      };
      const res = await buildCatalogSnapshot(request, { deps });
      const direct = await listSessionSummaries({
        dataPath: fixture.workspaceStorage,
        workspace: scope === 'A' ? fixture.projectA : undefined,
      });
      expect(res.type).toBe('done');
      expect(env.calls).toEqual(['fingerprint', 'read', 'publish']);
      expect(env.published).toHaveLength(1);
      const { rows, header } = env.published[0]!;
      expect(rows).toEqual(direct.data.map((r) => JSON.stringify(r)));
      expect(rows.length).toBeGreaterThan(0);
      expect(header.rowCount).toBe(rows.length);
      expect(header.scopeJson).toBe(direct.scope ? JSON.stringify(direct.scope) : null);
      for (const r of rows) expect(JSON.stringify(JSON.parse(r))).toBe(r);
      expect(env.closed).toBe(1);
    });
  }

  it('returns a content-free failure when the read throws', async () => {
    const { request } = setup(null);
    const env = createFakeEnv();
    const res = await buildCatalogSnapshot(request, {
      deps: {
        ...fakeStoreDeps(env),
        listSessionSummaries: async () => {
          throw new Error('C:/secret/title');
        },
      },
    });
    expect(res).toMatchObject({ type: 'failed', code: 'BUILD_FAILED' });
    expect(JSON.stringify(res)).not.toContain('secret');
    expect(env.published).toHaveLength(0);
    expect(env.closed).toBe(1);
  });

  it('maps publish errors to their code without leaking text', async () => {
    const { request } = setup(null);
    const env = createFakeEnv();
    const res = await buildCatalogSnapshot(request, {
      deps: { ...fakeStoreDeps(env, { failPublish: true }), listSessionSummaries },
    });
    expect(res).toMatchObject({ type: 'failed', code: 'CATALOG_LOCKED' });
    expect(JSON.stringify(res)).not.toContain('/x/y');
  });

  it('does not publish when aborted mid-build', async () => {
    const { request } = setup(null);
    const env = createFakeEnv();
    const ac = new AbortController();
    const res = await buildCatalogSnapshot(request, {
      signal: ac.signal,
      deps: {
        ...fakeStoreDeps(env),
        listSessionSummaries: async () => {
          ac.abort();
          return { data: [], pagination: { total: 0, limit: 0, offset: 0, hasMore: false } };
        },
      },
    });
    expect(res.type).toBe('failed');
    expect(env.published).toHaveLength(0);
    expect(env.calls).not.toContain('publish');
  });
});
