import { createHash } from 'node:crypto';
import type {
  CatalogLock,
  CatalogScopeKey,
  CatalogSnapshotHeader,
  SourceFingerprint,
} from '../../src/core/catalog/contract.js';

export function fakeDigest(key: CatalogScopeKey): string {
  return createHash('sha256').update(JSON.stringify(key)).digest('hex');
}

export interface FakeEnv {
  calls: string[];
  published: Array<{ header: Omit<CatalogSnapshotHeader, 'snapshotId'>; rows: string[] }>;
  closed: number;
}

export function createFakeEnv(): FakeEnv {
  return { calls: [], published: [], closed: 0 };
}

export function fakeStoreDeps(env: FakeEnv, opts: { failPublish?: boolean } = {}) {
  return {
    digestScopeKey: fakeDigest,
    computeSourceFingerprint: async (): Promise<SourceFingerprint> => {
      env.calls.push('fingerprint');
      return { files: [], listingsDigest: 'l', digest: 'd' };
    },
    openCatalogStore: () => ({
      path: 'fake',
      getSnapshotHeader: () => undefined,
      readRows: () => [],
      publishSnapshot(header: Omit<CatalogSnapshotHeader, 'snapshotId'>, rows: Iterable<string>) {
        env.calls.push('publish');
        if (opts.failPublish) throw Object.assign(new Error('/x/y'), { code: 'CATALOG_LOCKED' });
        env.published.push({ header, rows: Array.from(rows) });
        return env.published.length;
      },
      touchVerified() {},
      prune() {},
      close() {
        env.closed++;
      },
    }),
  };
}

export interface FakeLockState {
  held: Set<string>;
  acquired: number;
  released: number;
}

export function createFakeLock(state: FakeLockState = { held: new Set(), acquired: 0, released: 0 }) {
  const create = (): CatalogLock => ({
    tryAcquire(digest) {
      if (state.held.has(digest)) return undefined;
      state.held.add(digest);
      state.acquired++;
      let done = false;
      return {
        release() {
          if (done) return;
          done = true;
          state.held.delete(digest);
          state.released++;
        },
      };
    },
  });
  return { state, createCatalogLock: create };
}
