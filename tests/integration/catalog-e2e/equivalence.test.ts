import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { buildR2Corpus, type R2Corpus } from '../../helpers/r2-corpus.js';
import {
  createSessionIntegrityFixtureRoot,
  seedConflictingWorkspaceCorpus,
  writeStoreDb,
  type SessionIntegrityFixtureRoot,
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
  type Config,
} from '../../helpers/catalog-e2e.js';

/**
 * Equivalence matrix: for each corpus and scope, catalog:'auto' after a completed
 * background build is state 'ready' and deep-equal to the direct reader on
 * data, pagination, scope and the onDiagnostic multiset.
 */
const previousStoreRoot = process.env['CURSOR_STORE_ROOT'];
const sidecar = makeSidecarDir();
let r2: R2Corpus;
let conflicting: SessionIntegrityFixtureRoot;

beforeAll(async () => {
  r2 = await buildR2Corpus('ch-c4-r2-');
  addEmptyWorkspace(r2.fx.workspaceStorage, 'workspace-empty', join(r2.fx.root, 'workspaces', 'e'));
  backdateTree(r2.fx.root);
  conflicting = createSessionIntegrityFixtureRoot('ch-c4-conflict-');
  seedConflictingWorkspaceCorpus(conflicting);
  writeStoreDb(conflicting, 'eeeeeeee-0000-0000-0000-000000000016', [
    { role: 'user', content: 'store only' },
  ]);
  addEmptyWorkspace(
    conflicting.workspaceStorage,
    'workspace-empty',
    join(conflicting.root, 'workspaces', 'e')
  );
  backdateTree(conflicting.root);
});

afterAll(() => {
  if (previousStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = previousStoreRoot;
  r2?.fx.cleanup();
  conflicting?.cleanup();
  sidecar.cleanup();
});

function scopes(fx: SessionIntegrityFixtureRoot, extraWs?: string): Record<string, Config> {
  const dataPath = fx.workspaceStorage;
  const out: Record<string, Config> = {
    global: { dataPath },
    'ws-a': { dataPath, workspace: fx.projectA },
    'ws-b': { dataPath, workspace: fx.projectB },
    'ws-a-cross': { dataPath, workspace: fx.projectA, includeCrossWorkspaceSources: true },
    'ws-empty': { dataPath, workspace: join(fx.root, 'workspaces', 'e') },
    'ws-not-found': { dataPath, workspace: join(fx.root, 'workspaces', 'does-not-exist') },
    'limits-page-rows': { dataPath, sourceReadLimits: { sqlitePageRows: 2 } },
    'limits-ws-a': { dataPath, workspace: fx.projectA, sourceReadLimits: { sqlitePageRows: 1 } },
  };
  if (extraWs) {
    out['ws-c'] = { dataPath, workspace: extraWs };
    out['ws-c-cross'] = { dataPath, workspace: extraWs, includeCrossWorkspaceSources: true };
  }
  return out;
}

const PAGES = [
  { offset: 0, limit: 2 },
  { offset: 2, limit: 3 },
  { offset: 1, limit: 1 },
  { offset: 50, limit: 5 },
  {},
];

function matrix(label: string, getFx: () => SessionIntegrityFixtureRoot, getExtra?: () => string) {
  describe(label, () => {
    const names = Object.keys(scopes(createSessionIntegrityFixtureRootStub(), 'x'));
    for (const name of names) {
      it(`auto equals direct for scope ${name}`, async () => {
        const fx = getFx();
        process.env['CURSOR_STORE_ROOT'] = fx.storeRoot;
        const base = scopes(fx, getExtra?.())[name];
        if (!base) return;
        const cfg = { ...base, catalogPath: sidecar.catalogPath };

        // Before any build: auto serves a direct result (building) and is equal.
        const cold = await read({ ...cfg, catalog: 'auto' });
        expect(['building', 'ready']).toContain(catalogOf(cold).state);
        expect(comparable(cold)).toEqual(comparable(await read({ ...cfg, catalog: 'direct' })));

        expect(await buildAndWait({ ...cfg, catalog: 'auto' })).toBe(true);
        for (const page of [...PAGES, { offset: 0, limit: 10_000 }]) {
          const pageCfg = { ...cfg, ...page };
          const auto = await read({ ...pageCfg, catalog: 'auto' });
          const direct = await read({ ...pageCfg, catalog: 'direct' });
          expect(catalogOf(auto)).toMatchObject({ state: 'ready', complete: true });
          expect(comparable(auto)).toEqual(comparable(direct));
        }
        // A direct read never carries catalog disclosure.
        expect((await read({ ...cfg, catalog: 'direct' })).result).not.toHaveProperty('catalog');
      }, 90_000);
    }
  });
}

/** Names only; paths are irrelevant. */
function createSessionIntegrityFixtureRootStub(): SessionIntegrityFixtureRoot {
  return {
    root: 'x',
    workspaceStorage: 'x',
    globalStorage: 'x',
    storeRoot: 'x',
    projectA: 'x',
    projectB: 'x',
    cleanup() {},
  };
}

describe('catalog e2e equivalence matrix', () => {
  it('uses the built library', () => {
    expect(typeof dist.listSessionSummaries).toBe('function');
  });
  it('corpora are rich enough to make equivalence meaningful', async () => {
    process.env['CURSOR_STORE_ROOT'] = r2.fx.storeRoot;
    const global = await read({ dataPath: r2.fx.workspaceStorage, catalog: 'direct' });
    expect(global.result.pagination.total).toBeGreaterThanOrEqual(8);
    const sources = new Set(global.result.data.map((row) => JSON.stringify(Object.keys(row))));
    expect(sources.size).toBeGreaterThan(0);
    const empty = await read({
      dataPath: r2.fx.workspaceStorage,
      workspace: join(r2.fx.root, 'workspaces', 'e'),
      catalog: 'direct',
    });
    const missing = await read({
      dataPath: r2.fx.workspaceStorage,
      workspace: join(r2.fx.root, 'workspaces', 'does-not-exist'),
      catalog: 'direct',
    });
    // Both resolve a scope outcome; the missing one must differ from a found one.
    expect(JSON.stringify((missing.result as { scope?: unknown }).scope)).not.toEqual(
      JSON.stringify((empty.result as { scope?: unknown }).scope)
    );
  });
  matrix(
    'R2 corpus (workspace + global + Store + ambiguous rows)',
    () => r2.fx,
    () => r2.projectC
  );
  matrix('conflicting-replica corpus with Store session', () => conflicting);
});
