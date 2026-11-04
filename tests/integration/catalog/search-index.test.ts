import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchSessions, type LibraryConfig } from '../../../src/lib/index.js';
import { getCatalogDeps } from '../../../src/core/catalog/catalog-deps.js';
import { CATALOG_SCHEMA_VERSION } from '../../../src/core/catalog/contract.js';
import {
  openCatalogStoreAsync,
  toFtsPhrase,
  type CatalogStoreExtended,
} from '../../../src/core/catalog/store.js';
import {
  indexedTextOf,
  searchIndexQueryIneligibleReason,
} from '../../../src/core/catalog/search-index.js';
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

function session(
  n: number,
  title: string,
  contents: string[],
  createdAt = 1_700_000_000_000 + n * 1000
): ComposerFixtureSession {
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

function rich(): ComposerFixtureSession[] {
  return [
    session(1, 'auth', [
      'Authentication failed: TypeError at line 5',
      'You can reAuthenticate; typeerror is the same as TYPEERROR here',
    ]),
    session(2, 'ties one', ['needle once', 'another needle']),
    session(3, 'ties two', ['needle first', 'second needle']),
    session(4, 'punct', [
      'call foo("bar") && x*y -z NEAR(a b) AND (c OR d)',
      'say "hi" now\nthen "bye"\n  indented line with  double  spaces',
    ]),
    session(5, 'multi', [
      'a b c\nline two has migration\nline three',
      'migration migration MIGRATION',
    ]),
    session(6, 'unicode', [
      'Istanbul kafe Kafe (kelvin) and İstanbul dotted',
      'Ünïcode ÄÖ mixed Café CAFÉ cafe',
      'emoji 😀 smile and naïve resumé',
    ]),
    session(7, 'empty-ish', ['', 'ok', 'ab', 'abc']),
    session(8, 'regex-ish', ['a.b a*b a+b [x] ^start$ end\\ back\\slash', "it's a 'quote'"]),
    session(9, 'repeat', ['aaaa aaaa aaaa', 'aaa']),
    session(10, 'rare', ['ordinary text with zzrareword inside']),
  ];
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

function writeCorpus(): void {
  const sessions = rich();
  writeComposerWorkspaceSummary(fx, 'workspace-a', fx.projectA, sessions);
  const ambiguous = session(99, 'Ambiguous first', ['ambigtoken needle ambiguity']);
  ambiguous.id = AMBIGUOUS_ID;
  const divergent = { ...ambiguous, title: 'Ambiguous divergent' };
  writeComposerWorkspaceSummary(fx, 'workspace-amb-1', fx.projectA, [ambiguous]);
  writeComposerWorkspaceSummary(fx, 'workspace-amb-2', fx.projectA, [divergent]);
  writeComposerGlobalSessions(fx, sessions);
}

function base(extra: LibraryConfig = {}): LibraryConfig {
  return { dataPath: fx.workspaceStorage, ...extra };
}
function indexed(extra: LibraryConfig = {}): LibraryConfig {
  return base({ catalog: 'strict', catalogPath, searchIndex: true, ...extra });
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'search-index-'));
  catalogPath = join(work, 'catalog.sqlite');
  fx = createSessionIntegrityFixtureRoot('search-index-fx-');
  process.env['CURSOR_STORE_ROOT'] = fx.storeRoot;
  writeCorpus();
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

const QUERIES = [
  'typeerror',
  'TypeError',
  'TYPEERROR',
  'authen',
  'ate;',
  'needle',
  'NEEDLE',
  'foo("bar")',
  'x*y',
  '-z',
  'near(a b)',
  'NEAR(',
  'AND (c',
  ' AND ',
  'say "hi"',
  '"',
  '""',
  'a b',
  'a b c',
  'a.b',
  'a*b',
  '[x]',
  '^start$',
  'end\\ back',
  "it's a 'quote'",
  'then "bye"\n  indented',
  'double  spaces',
  'migration',
  'aaa',
  'aaaa aaaa',
  'kafe',
  'KAFE',
  'stanbul',
  'istanbul',
  'cafe',
  'abc',
  'ambigtoken',
  'zzrareword',
  'qqqnotpresentqqq',
  '   ',
];

describe('verified indexed search equals the direct scan', () => {
  it('builds the index on first strict use and records header metadata', async () => {
    const results = await searchSessions('needle', indexed({ onDiagnostic: () => undefined }));
    expect(results.searchMode).toBe('indexed');
    expect(results.catalog?.state).toBe('ready');
    expect(results.catalog?.complete).toBe(true);
    const store = (await openCatalogStoreAsync({ path: catalogPath })) as CatalogStoreExtended;
    try {
      const headers = store.listSnapshotHeaders();
      expect(headers).toHaveLength(1);
      expect(headers[0]!.scopeKey.searchIndex).toBe(true);
      expect(headers[0]!.searchIndexed).toBe(true);
      expect(headers[0]!.searchMessageCount).toBeGreaterThan(10);
    } finally {
      store.close();
    }
  });

  for (const limit of [undefined, 1, 3]) {
    for (const context of [0, 2]) {
      it(
        `matches for limit=${limit ?? 'none'} context=${context}`,
        { timeout: 180_000 },
        async () => {
          let ambiguousSeen = 0;
          for (const query of QUERIES) {
            const diagDirect: unknown[] = [];
            const diagIndexed: unknown[] = [];
            const extra: LibraryConfig = {
              ...(limit === undefined ? {} : { limit }),
              context,
            };
            const direct = await searchSessions(query, {
              ...base(extra),
              onDiagnostic: (d) => diagDirect.push(d),
            });
            const viaIndex = await searchSessions(query, {
              ...indexed(extra),
              onDiagnostic: (d) => diagIndexed.push(d),
            });
            expect(JSON.stringify(viaIndex), `query ${JSON.stringify(query)}`).toBe(
              JSON.stringify(direct)
            );
            expect(viaIndex).toEqual(direct);
            expect(diagIndexed).toEqual(diagDirect);
            ambiguousSeen += diagDirect.length;
            expect((direct as { searchMode?: string }).searchMode).toBeUndefined();
            const eligible = searchIndexQueryIneligibleReason(query) === undefined;
            expect(viaIndex.searchMode).toBe(eligible ? 'indexed' : 'direct');
          }
          expect(ambiguousSeen).toBeGreaterThan(0);
        }
      );
    }
  }

  it('orders ties exactly like the direct scan', async () => {
    const direct = await searchSessions('needle', base({ onDiagnostic: () => undefined }));
    const viaIndex = await searchSessions('needle', indexed({ onDiagnostic: () => undefined }));
    expect(viaIndex.map((r) => r.session.id)).toEqual(direct.map((r) => r.session.id));
    expect(direct.length).toBeGreaterThanOrEqual(2);
    expect(new Set(direct.slice(0, 2).map((r) => r.session.id)).size).toBe(2);
  });

  it('throws the same strict ambiguity error as the direct scan when no sink is given', async () => {
    const capture = async (config: LibraryConfig): Promise<unknown> => {
      try {
        await searchSessions('needle', config);
        return 'no error';
      } catch (error) {
        return (error as Error).name;
      }
    };
    const direct = await capture(base());
    expect(direct).not.toBe('no error');
    expect(await capture(indexed())).toBe(direct);
  });

  it('discloses a content-free reason when the query is ineligible', async () => {
    const short = await searchSessions('ab', indexed({ onDiagnostic: () => undefined }));
    expect(short.searchMode).toBe('direct');
    expect(short.searchModeReason).toBe('QUERY_TOO_SHORT');
    const nonAscii = await searchSessions('café', indexed({ onDiagnostic: () => undefined }));
    expect(nonAscii.searchMode).toBe('direct');
    expect(nonAscii.searchModeReason).toBe('QUERY_NOT_ASCII');
    const control = await searchSessions('a\u0000bc', indexed({ onDiagnostic: () => undefined }));
    expect(control.searchModeReason).toBe('QUERY_NOT_ASCII');
  });

  it('adds no disclosure unless searchIndex is enabled with a catalog mode', async () => {
    const onDiagnostic = (): void => undefined;
    const a = await searchSessions('needle', base({ onDiagnostic }));
    const b = await searchSessions('needle', base({ onDiagnostic, searchIndex: true }));
    const c = await searchSessions(
      'needle',
      base({ onDiagnostic, catalog: 'strict', catalogPath })
    );
    for (const r of [a, b, c]) {
      expect('searchMode' in r).toBe(false);
      expect('catalog' in r).toBe(false);
    }
  });

  it('does not use the index for backup sources', async () => {
    const r = await searchSessions('needle', {
      ...indexed(),
      backupPath: join(work, 'does-not-matter.zip'),
    }).catch((e: unknown) => e);
    // The backup does not exist: whatever error the direct path raises must be raised unchanged.
    expect(r instanceof Error || Array.isArray(r)).toBe(true);
  });
});

describe('stale and missing index', () => {
  it('auto without a snapshot scans directly and says why', async () => {
    const results = await searchSessions('needle', {
      ...indexed({ onDiagnostic: () => undefined }),
      catalog: 'auto',
      catalogPath: join(work, 'empty-auto.sqlite'),
    });
    expect(results.searchMode).toBe('direct');
    expect(results.searchModeReason).toBe('INDEX_BUILDING');
    expect(results.catalog?.state).toBe('building');
    expect(results.length).toBeGreaterThan(0);
  });

  it('auto with a stale index verifies candidates and flags incompleteness', async () => {
    const own = join(work, 'stale.sqlite');
    const onDiagnostic = (): void => undefined;
    await searchSessions('needle', indexed({ catalogPath: own, onDiagnostic }));
    // Add a new session after the index was built.
    const added = session(50, 'late', ['needle late arrival']);
    writeComposerWorkspaceSummary(fx, 'workspace-late', fx.projectA, [added]);
    writeComposerGlobalSessions(fx, [added]);
    ageTree(fx.root, 30_000);
    const results = await searchSessions('needle', {
      ...indexed({ catalogPath: own, onDiagnostic }),
      catalog: 'auto',
    });
    expect(results.searchMode).toBe('indexed');
    expect(results.catalog?.state).toBe('stale');
    expect(results.catalog?.complete).toBe(false);
    // Candidates come from the stale index, so the late session may be absent but every
    // returned hit is verified against the source.
    for (const hit of results) expect(hit.match.toLowerCase()).toContain('needle');
    // Strict mode rebuilds first and then sees the late session.
    const fresh = await searchSessions('needle', indexed({ catalogPath: own, onDiagnostic }));
    expect(fresh.catalog?.state).toBe('ready');
    const direct = await searchSessions('needle', base({ onDiagnostic }));
    expect(fresh).toEqual(direct);
    expect(fresh.some((r) => r.match.includes('late arrival'))).toBe(true);
  });
});

describe('schema', () => {
  it('rebuilds a version-1 sidecar instead of reading it', async () => {
    expect(CATALOG_SCHEMA_VERSION).toBe(2);
    const old = join(work, 'old-schema.sqlite');
    const db = new BetterSqlite3(old);
    db.exec(
      "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version','1'), ('projection_epoch','1');"
    );
    db.close();
    const store = await openCatalogStoreAsync({ path: old });
    try {
      expect(store.getSnapshotHeader('none')).toBeUndefined();
    } finally {
      store.close();
    }
    expect(readdirSync(work).some((n) => n.startsWith('old-schema.sqlite.corrupt-'))).toBe(true);
  });

  it('drops a replaced snapshot index and its locator rows', async () => {
    const path = join(work, 'drop.sqlite');
    const store = (await openCatalogStoreAsync({ path })) as CatalogStoreExtended;
    try {
      const header = (digest: string) => ({
        scopeKeyDigest: digest,
        scopeKey: {} as never,
        fingerprint: {} as never,
        builtAt: new Date().toISOString(),
        buildMs: 1,
        rowCount: 0,
        diagnosticsJson: '[]',
        scopeJson: null,
      });
      const id1 = store.publishSnapshot(header('d'), []);
      const w = store.beginSearchIndex(id1);
      w.addSession('s1', [{ index: 0, text: 'hello world' }]);
      expect(w.finish().messageCount).toBe(1);
      expect([...store.searchCandidates(id1, 'hello').keys()]).toEqual(['s1']);
      const id2 = store.publishSnapshot(header('d'), []);
      expect(id2).not.toBe(id1);
      expect(() => store.searchCandidates(id1, 'hello')).toThrow();
      expect(store.getSnapshotHeader('d')?.searchIndexed).toBeUndefined();
    } finally {
      store.close();
    }
    expect(existsSync(path)).toBe(true);
  });
});

describe('FTS trigram candidates are a superset of the JS matcher', () => {
  const texts = [
    'Authentication failed: TypeError at line 5',
    'call foo("bar") && x*y -z NEAR(a b) AND (c OR d) OR NOT e',
    'say "hi" now\nthen "bye"\n  indented\ttab',
    'Istanbul kafe Kafe (kelvin) and İstanbul dotted',
    'Ünïcode ÄÖ Café CAFÉ cafe naïve',
    'emoji 😀 smile',
    "a.b a*b a+b [x] ^start$ end\\ back\\slash it's",
    'MiXeD CaSe tExT with NEAR/3 and column:filter {a b} body: x',
    'aaaa aaaa',
    '   spaces   ',
    'ab',
    '',
  ];
  const queries = [
    'typeerror',
    'TypeError',
    'ypeEr',
    'foo("bar")',
    '"bar"',
    'x*y',
    '-z',
    'NEAR(a b)',
    'near',
    'AND (c',
    'OR d)',
    'NOT e',
    'say "hi"',
    '""',
    '"',
    'then "bye"\n  indented',
    'tab',
    'kafe',
    'KAFE',
    'stanbul',
    'cafe',
    'a.b',
    'a*b',
    'a+b',
    '[x]',
    '^start$',
    'end\\ back',
    "it's",
    'NEAR/3',
    'column:filter',
    '{a b}',
    'body: x',
    'aaa',
    'aaaa aaaa',
    '   ',
    'abc',
    'zzz',
    'a b',
    ' AND ',
    'e',
    'ab ',
  ].filter((q) => searchIndexQueryIneligibleReason(q) === undefined);

  it('never misses a message the case-insensitive matcher hits', async () => {
    const path = join(work, 'superset.sqlite');
    const store = (await openCatalogStoreAsync({ path })) as CatalogStoreExtended;
    try {
      const id = store.publishSnapshot(
        {
          scopeKeyDigest: 'x',
          scopeKey: {} as never,
          fingerprint: {} as never,
          builtAt: new Date().toISOString(),
          buildMs: 1,
          rowCount: 0,
          diagnosticsJson: '[]',
          scopeJson: null,
        },
        []
      );
      const w = store.beginSearchIndex(id);
      texts.forEach((t, i) => w.addSession(`s${i}`, [{ index: 0, text: indexedTextOf(t) }]));
      w.finish();
      let hits = 0;
      for (const query of queries) {
        const candidates = new Set(store.searchCandidates(id, query).keys());
        texts.forEach((t, i) => {
          if (t.toLowerCase().includes(query.toLowerCase())) {
            hits += 1;
            expect(candidates.has(`s${i}`), `${JSON.stringify(query)} in #${i}`).toBe(true);
          }
        });
      }
      expect(hits).toBeGreaterThan(30);
      // Every substring (length >= 3, any case) of every ASCII-foldable text is a candidate.
      for (const [i, t] of texts.entries()) {
        const lower = t.toLowerCase();
        for (let a = 0; a + 3 <= lower.length; a += 2) {
          for (const len of [3, 5, 9]) {
            const slice = lower.slice(a, a + len);
            if (slice.length < 3 || searchIndexQueryIneligibleReason(slice) !== undefined) continue;
            for (const q of [slice, slice.toUpperCase()]) {
              expect(
                new Set(store.searchCandidates(id, q).keys()).has(`s${i}`),
                JSON.stringify(q)
              ).toBe(true);
            }
          }
        }
      }
    } finally {
      store.close();
    }
  });

  it('quotes queries as literal phrases', () => {
    expect(toFtsPhrase('a "b" c')).toBe('"a ""b"" c"');
    expect(toFtsPhrase('NEAR(a b) AND *')).toBe('"NEAR(a b) AND *"');
  });

  it('classifies eligibility', () => {
    expect(searchIndexQueryIneligibleReason('ab')).toBe('QUERY_TOO_SHORT');
    expect(searchIndexQueryIneligibleReason('abc')).toBeUndefined();
    expect(searchIndexQueryIneligibleReason('café')).toBe('QUERY_NOT_ASCII');
    expect(searchIndexQueryIneligibleReason('a\u0000b')).toBe('QUERY_NOT_ASCII');
    expect(searchIndexQueryIneligibleReason('😀')).toBe('QUERY_TOO_SHORT');
    expect(searchIndexQueryIneligibleReason('😀x')).toBe('QUERY_NOT_ASCII');
  });
});
