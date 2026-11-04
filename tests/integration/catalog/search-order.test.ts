import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listSessionSummaries,
  getCatalogStatus,
  searchSessions,
  type LibraryConfig,
} from '../../../src/lib/index.js';
import { getCatalogDeps } from '../../../src/core/catalog/catalog-deps.js';
import {
  createSessionIntegrityFixtureRoot,
  writeComposerGlobalSessions,
  writeComposerWorkspaceSummary,
  type ComposerFixtureSession,
  type SessionIntegrityFixtureRoot,
} from '../../helpers/session-integrity-fixtures.js';

const AMBIGUOUS_ID = 'cccccccc-0000-0000-0000-0000000000a1';
const previousStoreRoot = process.env['CURSOR_STORE_ROOT'];

let fx: SessionIntegrityFixtureRoot;
let work: string;
let catalogPath: string;

function session(n: number, title: string, contents: string[]): ComposerFixtureSession {
  const createdAt = 1_700_000_000_000 + n * 1000;
  return {
    id: `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`,
    title,
    workspacePath: fx.projectA,
    createdAt,
    messages: contents.map((content, i) => ({
      id: `m${n}-${i}`,
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content,
      createdAt: createdAt + i,
    })),
  };
}

function corpus(): ComposerFixtureSession[] {
  const out: ComposerFixtureSession[] = [];
  for (let n = 1; n <= 12; n++) {
    // "needle" in sessions where n % 3 !== 0, with a varying count so match-count order differs
    // from recency; "zzrareword" in two sessions; "common" everywhere.
    const contents = ['common text ' + n];
    if (n % 3 !== 0) for (let k = 0; k < 1 + (n % 5); k++) contents.push(`needle ${k}`);
    if (n === 2 || n === 7) contents.push('zzrareword here');
    out.push(session(n, `s${n}`, contents));
  }
  return out;
}

function ageTree(root: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else utimesSync(full, when, when);
    }
    utimesSync(dir, when, when);
  };
  walk(root);
}

function base(extra: LibraryConfig = {}): LibraryConfig {
  return { dataPath: fx.workspaceStorage, ...extra };
}
function indexed(extra: LibraryConfig = {}): LibraryConfig {
  return base({ catalog: 'strict', catalogPath, searchIndex: true, ...extra });
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'search-order-'));
  catalogPath = join(work, 'catalog.sqlite');
  fx = createSessionIntegrityFixtureRoot('search-order-fx-');
  process.env['CURSOR_STORE_ROOT'] = fx.storeRoot;
  const sessions = corpus();
  writeComposerWorkspaceSummary(fx, 'workspace-a', fx.projectA, sessions);
  const ambiguous = session(99, 'Ambiguous first', ['needle ambiguity']);
  ambiguous.id = AMBIGUOUS_ID;
  writeComposerWorkspaceSummary(fx, 'workspace-amb-1', fx.projectA, [ambiguous]);
  writeComposerWorkspaceSummary(fx, 'workspace-amb-2', fx.projectA, [
    { ...ambiguous, title: 'Ambiguous divergent' },
  ]);
  writeComposerGlobalSessions(fx, sessions);
  ageTree(fx.root, 60_000);
});

afterAll(async () => {
  try {
    await (await getCatalogDeps()).cancelCatalogRefreshes?.();
  } catch {
    // ignore
  }
  if (previousStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = previousStoreRoot;
  fx?.cleanup();
  rmSync(work, { recursive: true, force: true });
});

const QUERIES = ['needle', 'NEEDLE', 'zzrareword', 'common', 'qqqabsentqqq', 'ne'];
const LIMITS: Array<number | undefined> = [undefined, 1, 2, 3, 5, 50];
const noDiag = (): void => undefined;

describe('searchOrder recent', () => {
  it('rejects an invalid searchOrder', async () => {
    await expect(
      searchSessions('needle', base({ searchOrder: 'newest' as 'recent' }))
    ).rejects.toThrow(/searchOrder/);
  });

  it('adds no disclosure unless searchOrder is set', async () => {
    const r = await searchSessions('needle', base({ onDiagnostic: noDiag }));
    expect('searchOrder' in r).toBe(false);
    expect('searchExhaustive' in r).toBe(false);
    const m = await searchSessions(
      'needle',
      base({ onDiagnostic: noDiag, searchOrder: 'match-count' })
    );
    expect(m.searchOrder).toBe('match-count');
    expect(m.searchExhaustive).toBe(true);
    expect(JSON.stringify(m)).toBe(JSON.stringify(r));
  });

  it('reports search index stats per scope in getCatalogStatus', async () => {
    await searchSessions('needle', indexed({ onDiagnostic: noDiag }));
    const status = await getCatalogStatus(indexed());
    const own = status.scopes.find((scope) => scope.searchIndexed === true);
    expect(own?.searchMessageCount).toBeGreaterThan(10);
    expect(own?.searchIndexBytes === undefined || own.searchIndexBytes > 0).toBe(true);
  });

  it('listing order is newest created first', async () => {
    const page = await listSessionSummaries(base({ onDiagnostic: noDiag }));
    const times = page.data.map((s) => new Date(s.createdAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  for (const mode of ['direct', 'indexed'] as const) {
    it(
      `equals the first limit sessions of the full scan, in listing order (${mode})`,
      { timeout: 180_000 },
      async () => {
        const cfg = mode === 'indexed' ? indexed : base;
        const listing = (await listSessionSummaries(base({ onDiagnostic: noDiag }))).data.map(
          (s) => s.id
        );
        let sawEarlyStop = false;
        for (const query of QUERIES) {
          const diagFull: unknown[] = [];
          const full = await searchSessions(query, base({ onDiagnostic: (d) => diagFull.push(d) }));
          const byId = new Map(full.map((hit) => [hit.session.id, hit]));
          const matchedInOrder = listing.filter((id) => byId.has(id));
          for (const limit of LIMITS) {
            const diagRecent: unknown[] = [];
            const recent = await searchSessions(
              query,
              cfg({
                ...(limit === undefined ? {} : { limit }),
                searchOrder: 'recent',
                onDiagnostic: (d) => diagRecent.push(d),
              })
            );
            const label = `${mode} query=${query} limit=${limit ?? 'none'}`;
            const expectedIds = matchedInOrder.slice(0, limit ?? Number.MAX_SAFE_INTEGER);
            expect(
              recent.map((r) => r.session.id),
              label
            ).toEqual(expectedIds);
            for (const hit of recent) {
              expect(JSON.stringify(hit), label).toBe(JSON.stringify(byId.get(hit.session.id)));
            }
            expect(diagRecent, label).toEqual(diagFull);
            expect(recent.searchOrder, label).toBe('recent');
            const matched = matchedInOrder.length;
            if (limit === undefined || matched < limit) {
              expect(recent.searchExhaustive, label).toBe(true);
            } else if (mode === 'direct') {
              // Stopped at the limit-th match: exhaustive only if no non-ambiguous session follows.
              const last = listing.indexOf(expectedIds[expectedIds.length - 1]!);
              const remaining = listing.slice(last + 1).filter((id) => id !== AMBIGUOUS_ID);
              expect(recent.searchExhaustive, label).toBe(remaining.length === 0);
            } else if (matched > limit) {
              expect(recent.searchExhaustive, label).toBe(false);
            } else {
              expect(typeof recent.searchExhaustive, label).toBe('boolean');
            }
            if (recent.searchExhaustive === false) sawEarlyStop = true;
            if (mode === 'indexed') {
              const eligible = query.length >= 3;
              expect(recent.searchMode, label).toBe(eligible ? 'indexed' : 'direct');
            }
          }
        }
        expect(sawEarlyStop).toBe(true);
      }
    );
  }

  it('hydrates fewer sessions than the full scan once the limit is reached', async () => {
    const countLoops = async (extra: LibraryConfig): Promise<number> => {
      let loops = 0;
      await searchSessions(
        'needle',
        base({
          onDiagnostic: noDiag,
          ...extra,
          diagnostics: {
            onEvent: (event) => {
              if (event.type === 'phase' && event.name === 'search:session-loop') loops++;
            },
          },
        })
      );
      return loops;
    };
    const full = await countLoops({ limit: 2 });
    const recent = await countLoops({ limit: 2, searchOrder: 'recent' });
    expect(full).toBeGreaterThanOrEqual(10);
    // 12 (no match) then 11 and 10 (matches): the limit is reached on the third session.
    expect(recent).toBe(3);
  });

  it('is ordered by listing order, not match count', async () => {
    const byCount = await searchSessions('needle', base({ onDiagnostic: noDiag, limit: 12 }));
    const recent = await searchSessions(
      'needle',
      base({ onDiagnostic: noDiag, limit: 12, searchOrder: 'recent' })
    );
    expect(recent.map((r) => r.session.id)).not.toEqual(byCount.map((r) => r.session.id));
    expect(new Set(recent.map((r) => r.session.id))).toEqual(
      new Set(byCount.map((r) => r.session.id))
    );
  });

  it('throws the strict ambiguity error before hydrating, as the default order does', async () => {
    const capture = async (config: LibraryConfig): Promise<unknown> => {
      try {
        await searchSessions('needle', config);
        return 'no error';
      } catch (error) {
        return (error as Error).name;
      }
    };
    const expected = await capture(base());
    expect(expected).not.toBe('no error');
    expect(await capture(base({ searchOrder: 'recent', limit: 1 }))).toBe(expected);
    expect(await capture(indexed({ searchOrder: 'recent', limit: 1 }))).toBe(expected);
  });
});
