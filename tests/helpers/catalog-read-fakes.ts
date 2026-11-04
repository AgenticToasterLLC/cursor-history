/** In-memory fakes of the C1/C2 catalog modules for read-path tests. */
import type { CatalogDeps } from '../../src/core/catalog/catalog-deps.js';
import type {
  CatalogSnapshotHeader,
  CatalogStore,
  IndexerRequest,
  IndexerResponse,
  SourceFingerprint,
} from '../../src/core/catalog/contract.js';

export interface FakeCatalogState {
  headers: Map<string, CatalogSnapshotHeader>;
  rows: Map<number, string[]>;
  nextId: number;
  /** Digest the "sources" currently have. */
  sourceDigest: string;
  settled: boolean;
  /** When set, the fingerprint reports settled after this many unsettled checks. */
  settleAfterChecks?: number;
  /** When true, refresh requests are reported as rate limited (nothing runs). */
  rateLimited?: boolean;
  failOpen: boolean;
  buildResult: 'done' | 'failed';
  refreshRequests: IndexerRequest[] | Array<Record<string, unknown>>;
  builds: number;
  touched: number[];
  readRowsCalls: Array<[number, number, number | 'all']>;
  /** Direct reader used by the fake builder to produce rows. */
  readDirect?: (readConfig: Record<string, unknown>) => Promise<{
    rows: unknown[];
    diagnostics?: unknown[];
    scope?: unknown;
  }>;
}

export function makeFingerprint(digest: string): SourceFingerprint {
  return { files: [], listingsDigest: 'listings', digest };
}

export function createFakeCatalog(): { state: FakeCatalogState; deps: CatalogDeps } {
  const state: FakeCatalogState = {
    headers: new Map(),
    rows: new Map(),
    nextId: 1,
    sourceDigest: 'fp-1',
    settled: true,
    failOpen: false,
    buildResult: 'done',
    refreshRequests: [],
    builds: 0,
    touched: [],
    readRowsCalls: [],
  };

  const publish = (
    request: Pick<IndexerRequest, 'scopeKey'>,
    digest: string,
    rows: unknown[],
    extras: { diagnostics?: unknown[]; scope?: unknown }
  ): number => {
    const snapshotId = state.nextId++;
    state.headers.set(digest, {
      snapshotId,
      scopeKeyDigest: digest,
      scopeKey: request.scopeKey,
      fingerprint: makeFingerprint(state.sourceDigest),
      builtAt: '2024-01-01T00:00:00.000Z',
      buildMs: 5,
      rowCount: rows.length,
      diagnosticsJson: JSON.stringify(extras.diagnostics ?? []),
      scopeJson: extras.scope ? JSON.stringify(extras.scope) : null,
    });
    state.rows.set(
      snapshotId,
      rows.map((row) => JSON.stringify(row))
    );
    return snapshotId;
  };

  const store: CatalogStore = {
    path: 'fake-catalog.sqlite',
    getSnapshotHeader: (digest) => state.headers.get(digest),
    readRows: (id, offset, limit) => {
      state.readRowsCalls.push([id, offset, limit]);
      const all = state.rows.get(id) ?? [];
      return limit === 'all' ? all.slice(offset) : all.slice(offset, offset + limit);
    },
    publishSnapshot: () => {
      throw new Error('not used by fakes');
    },
    touchVerified: (id) => {
      state.touched.push(id);
    },
    prune: () => undefined,
    close: () => undefined,
  };

  const deps: CatalogDeps = {
    defaultCatalogPath: () => 'fake-catalog.sqlite',
    openCatalogStore: () => {
      if (state.failOpen) {
        throw Object.assign(new Error('boom /secret/path'), { code: 'CATALOG_UNAVAILABLE' });
      }
      return store;
    },
    computeSourceFingerprint: async () => makeFingerprint(state.sourceDigest),
    countFingerprintChanges: (a, b) => (a.digest === b.digest ? 0 : 3),
    isFingerprintSettled: () => {
      if (!state.settled && state.settleAfterChecks !== undefined) {
        if (state.settleAfterChecks <= 0) state.settled = true;
        else state.settleAfterChecks -= 1;
      }
      return state.settled;
    },
    digestScopeKey: (key) => JSON.stringify(key),
    buildCatalogSnapshot: async (request): Promise<IndexerResponse> => {
      state.builds += 1;
      if (state.buildResult === 'failed' || !state.readDirect) {
        return { type: 'failed', jobId: request.jobId, code: 'BUILD_FAILED', message: '' };
      }
      const out = await state.readDirect(request.readConfig);
      const digest = JSON.stringify(request.scopeKey);
      const id = publish(request, digest, out.rows, out);
      return {
        type: 'done',
        jobId: request.jobId,
        snapshotId: id,
        rowCount: out.rows.length,
        buildMs: 1,
      };
    },
    requestCatalogRefresh: (request) => {
      (state.refreshRequests as Array<Record<string, unknown>>).push(request);
      return state.rateLimited
        ? { jobId: 'job-1', alreadyRunning: false, rateLimited: true }
        : { jobId: 'job-1', alreadyRunning: false };
    },
    waitForCatalogBuild: async () => undefined,
  };

  return { state, deps };
}

/** Publish a snapshot for the scope identified by `scopeKey` straight into the fake store. */
export function seedSnapshot(
  state: FakeCatalogState,
  scopeKey: IndexerRequest['scopeKey'],
  rows: unknown[],
  extras: { diagnostics?: unknown[]; scope?: unknown } = {}
): void {
  const digest = JSON.stringify(scopeKey);
  const snapshotId = state.nextId++;
  state.headers.set(digest, {
    snapshotId,
    scopeKeyDigest: digest,
    scopeKey,
    fingerprint: makeFingerprint(state.sourceDigest),
    builtAt: '2024-01-01T00:00:00.000Z',
    buildMs: 5,
    rowCount: rows.length,
    diagnosticsJson: JSON.stringify(extras.diagnostics ?? []),
    scopeJson: extras.scope ? JSON.stringify(extras.scope) : null,
  });
  state.rows.set(
    snapshotId,
    rows.map((row) => JSON.stringify(row))
  );
}
