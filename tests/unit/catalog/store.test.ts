import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CATALOG_PROJECTION_EPOCH,
  CATALOG_SCHEMA_VERSION,
  type CatalogSnapshotHeader,
} from '../../../src/core/catalog/contract.js';
import { CatalogUnavailableError } from '../../../src/core/catalog/errors.js';
import { ensureCatalogDriver, openCatalogStore } from '../../../src/core/catalog/store.js';
import { registry } from '../../../src/core/database/registry.js';
import { digestScopeKey } from '../../../src/core/catalog/scope-key.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'catalog-store-'));
  dirs.push(d);
  return d;
}
const scopeKey = {
  dataPath: 'd',
  storeRoot: null,
  workspace: null,
  includeCrossWorkspaceSources: false,
  sourceReadLimits: { a: 1 },
  schemaVersion: CATALOG_SCHEMA_VERSION,
  projectionEpoch: CATALOG_PROJECTION_EPOCH,
  readerVersion: 'x',
};
function header(digest = digestScopeKey(scopeKey)): Omit<CatalogSnapshotHeader, 'snapshotId'> {
  return {
    scopeKeyDigest: digest,
    scopeKey,
    fingerprint: { files: [], listingsDigest: 'l', digest: 'd' },
    builtAt: new Date().toISOString(),
    buildMs: 5,
    rowCount: 0,
    diagnosticsJson: '{}',
    scopeJson: null,
  };
}

beforeAll(async () => {
  await ensureCatalogDriver();
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('catalog store', () => {
  it('round-trips ordered rows with offset/limit', () => {
    const path = join(tmp(), 'c.sqlite');
    const store = openCatalogStore({ path });
    const rows = Array.from({ length: 12 }, (_, i) => JSON.stringify({ i }));
    const id = store.publishSnapshot(header(), rows);
    const h = store.getSnapshotHeader(header().scopeKeyDigest)!;
    expect(h.snapshotId).toBe(id);
    expect(h.rowCount).toBe(12);
    expect(h.scopeKey).toEqual(scopeKey);
    expect(store.readRows(id, 0, 'all')).toEqual(rows);
    expect(store.readRows(id, 3, 4)).toEqual(rows.slice(3, 7));
    expect(store.readRows(id, 10, 100)).toEqual(rows.slice(10));
    store.close();
    const again = openCatalogStore({ path });
    expect(again.readRows(id, 0, 2)).toEqual(rows.slice(0, 2));
    again.close();
  });

  it('replaces the previous snapshot atomically and keeps old on failure', () => {
    const path = join(tmp(), 'c.sqlite');
    const store = openCatalogStore({ path });
    const id1 = store.publishSnapshot(header(), ['"a"', '"b"']);
    function* bad(): Generator<string> {
      yield '"x"';
      throw new Error('boom');
    }
    expect(() => store.publishSnapshot(header(), bad())).toThrow('boom');
    const h = store.getSnapshotHeader(header().scopeKeyDigest)!;
    expect(h.snapshotId).toBe(id1);
    expect(store.readRows(id1, 0, 'all')).toEqual(['"a"', '"b"']);
    const id2 = store.publishSnapshot(header(), ['"c"']);
    expect(id2).not.toBe(id1);
    expect(store.readRows(id1, 0, 'all')).toEqual([]);
    expect(store.readRows(id2, 0, 'all')).toEqual(['"c"']);
    store.close();
  });

  it('records verification and prunes', () => {
    const store = openCatalogStore({ path: join(tmp(), 'c.sqlite') });
    const a = store.publishSnapshot(header('a'), ['1']);
    store.publishSnapshot(header('b'), ['2']);
    store.touchVerified(a, '2030-01-01T00:00:00.000Z');
    expect(store.getScopeState('a')?.verifiedAt).toBe('2030-01-01T00:00:00.000Z');
    store.prune({ maxSnapshots: 1, maxAgeDays: 365 });
    expect(store.listSnapshotHeaders()).toHaveLength(1);
    store.prune({ maxSnapshots: 10, maxAgeDays: -1 });
    expect(store.listSnapshotHeaders()).toHaveLength(0);
    store.close();
  });

  it('recovers from a corrupt file by renaming it aside', () => {
    const dir = tmp();
    const path = join(dir, 'c.sqlite');
    writeFileSync(path, Buffer.alloc(4096, 0x61));
    const store = openCatalogStore({ path });
    const id = store.publishSnapshot(header(), ['"ok"']);
    expect(store.readRows(id, 0, 'all')).toEqual(['"ok"']);
    store.close();
    expect(readdirSync(dir).some((f) => f.includes('.corrupt-'))).toBe(true);
  });

  it('rebuilds on projection epoch mismatch', () => {
    const dir = tmp();
    const path = join(dir, 'c.sqlite');
    const store = openCatalogStore({ path });
    store.publishSnapshot(header(), ['"old"']);
    store.close();
    const db = registry.openSync(path, { readonly: false });
    db.prepare("UPDATE meta SET value = '999' WHERE key = 'projection_epoch'").run();
    db.close();
    const fresh = openCatalogStore({ path });
    expect(fresh.getSnapshotHeader(header().scopeKeyDigest)).toBeUndefined();
    fresh.close();
    expect(readdirSync(dir).some((f) => f.includes('.corrupt-'))).toBe(true);
  });

  it('has a typed content-free unavailable error', () => {
    const error = new CatalogUnavailableError();
    expect(error.code).toBe('CATALOG_UNAVAILABLE');
  });

  it.skipIf(process.platform === 'win32')('creates the file owner-only', () => {
    const path = join(tmp(), 'sub', 'c.sqlite');
    openCatalogStore({ path }).close();
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o077).toBe(0);
  });
});
