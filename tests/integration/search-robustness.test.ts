import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getSession, searchSessions, type LibraryConfig } from '../../src/lib/index.js';
import { getCatalogDeps } from '../../src/core/catalog/catalog-deps.js';
import type { SessionDiagnostic } from '../../src/core/types.js';
import {
  createSessionIntegrityFixtureRoot,
  writeComposerGlobalSessions,
  writeComposerWorkspaceSummary,
  writeStoreDb,
  writeStoreMeta,
  writeStoreTranscript,
  type ComposerFixtureSession,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';

const previousStoreRoot = process.env['CURSOR_STORE_ROOT'];
const BAD_ID = 'bbbbbbbb-0000-0000-0000-00000000bad1';
const TRANSCRIPT_ONLY_ID = 'bbbbbbbb-0000-0000-0000-0000000000a2';

let fx: SessionIntegrityFixtureRoot;
let work: string;
let catalogPath: string;

function composerSession(n: number, contents: string[]): ComposerFixtureSession {
  const createdAt = 1_700_000_000_000 + n * 1000;
  return {
    id: `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`,
    title: `session ${n}`,
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

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'search-robustness-'));
  catalogPath = join(work, 'catalog.sqlite');
  fx = createSessionIntegrityFixtureRoot('search-robustness-fx-');
  process.env['CURSOR_STORE_ROOT'] = fx.storeRoot;

  // Composer sessions with empty messages; sessions 1 and 2 also have a Store counterpart so
  // unscoped reads merge both stacks while scoped reads load only one.
  const sessions = [
    composerSession(1, ['', 'needle in assistant one', '', 'zz needle again', '']),
    composerSession(2, ['', '', 'merge needle composer', '']),
    composerSession(3, ['plain', '', 'needle three', '', '', 'tail needle']),
  ];
  writeComposerWorkspaceSummary(fx, 'workspace-a', fx.projectA, sessions);
  writeComposerGlobalSessions(fx, sessions);
  for (const s of sessions.slice(0, 2)) {
    const storeDb = writeStoreDb(
      fx,
      s.id,
      [
        { role: 'user', content: 'store-only lead message' },
        { role: 'assistant', content: 'store needle reply' },
        { role: 'user', content: '' },
        { role: 'assistant', content: 'store second needle' },
      ],
      s.title
    );
    writeStoreMeta(dirname(storeDb), {
      cwd: fx.projectA,
      title: s.title,
      hasConversation: true,
      createdAtMs: s.createdAt,
    });
  }
  writeStoreTranscript(fx, 'proj-a', TRANSCRIPT_ONLY_ID, [
    { role: 'user', message: { content: [{ type: 'text', text: 'needle from transcript' }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
    { role: 'user', message: { content: [{ type: 'text', text: 'another needle' }] } },
  ]);
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

const SCOPES: Array<[string, () => LibraryConfig]> = [
  ['unscoped', () => ({ dataPath: fx.workspaceStorage })],
  ['workspace scope', () => ({ dataPath: fx.workspaceStorage, workspace: fx.projectA })],
  [
    'workspace scope + cross-workspace sources',
    () => ({
      dataPath: fx.workspaceStorage,
      workspace: fx.projectA,
      includeCrossWorkspaceSources: true,
    }),
  ],
];

describe('search messageIndex/offset aligns with getSession().messages', () => {
  for (const mode of ['direct', 'indexed'] as const) {
    for (const [scopeName, scopeConfig] of SCOPES) {
      it(`every hit points at its match (${mode}, ${scopeName})`, async () => {
        for (const query of ['needle', 'NEEDLE', 'store', 'again']) {
          const config: LibraryConfig = {
            ...scopeConfig(),
            limit: 50,
            ...(mode === 'indexed' ? { catalog: 'strict', catalogPath, searchIndex: true } : {}),
          };
          const hits = await searchSessions(query, config);
          expect(hits.length).toBeGreaterThan(0);
          for (const hit of hits) {
            const full = await getSession(hit.session.id, config);
            const message = full?.messages[hit.messageIndex];
            expect(message, `${hit.session.id}[${hit.messageIndex}]`).toBeDefined();
            expect(
              message!.content.slice(hit.offset, hit.offset + query.length).toLowerCase()
            ).toBe(query.toLowerCase());
          }
        }
      }, 60_000);
    }
  }
});

describe('one undecodable transcript does not abort search', () => {
  beforeAll(() => {
    // An interior BOM is mixed-encoding framing for JSONL: the session is fatal on its own.
    const path = writeStoreTranscript(fx, 'proj-bad', BAD_ID, []);
    writeFileSync(
      path,
      Buffer.concat([
        Buffer.from('{"role":"user","message":{"content":[{"type":"text","text":"needle'),
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('bad"}]}}\n'),
      ])
    );
  });

  it('skips and reports the session when onDiagnostic is configured', async () => {
    const diagnostics: SessionDiagnostic[] = [];
    const hits = await searchSessions('needle', {
      dataPath: fx.workspaceStorage,
      limit: 50,
      onDiagnostic: (d) => diagnostics.push(d),
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.session.id)).not.toContain(BAD_ID);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'SOURCE_ENCODING_INVALID',
        sessionId: BAD_ID,
        sourceKind: 'jsonl',
      }),
    ]);
    // Content-free: nothing from the transcript is echoed.
    expect(JSON.stringify(diagnostics)).not.toContain('bad"');
  });

  it('skips the bad session during an indexed search and index build', async () => {
    const hits = await searchSessions('needle', {
      dataPath: fx.workspaceStorage,
      limit: 50,
      catalog: 'strict',
      catalogPath: join(work, 'catalog-bad.sqlite'),
      searchIndex: true,
      onDiagnostic: () => undefined,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.session.id)).not.toContain(BAD_ID);
  }, 60_000);

  it('keeps failing without an onDiagnostic sink (strict compatibility)', async () => {
    await expect(
      searchSessions('needle', { dataPath: fx.workspaceStorage, limit: 50 })
    ).rejects.toMatchObject({ code: 'SOURCE_ENCODING_INVALID' });
  });

  it('keeps a single-session read of the bad session fatal', async () => {
    await expect(getSession(BAD_ID, { dataPath: fx.workspaceStorage })).rejects.toMatchObject({
      code: 'SOURCE_ENCODING_INVALID',
    });
  });
});
