import { afterEach, describe, expect, it, vi } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const storeRootState = vi.hoisted(() => ({ current: undefined as string | undefined }));

vi.mock('../../src/lib/platform.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/platform.js')>(
    '../../src/lib/platform.js'
  );
  return {
    ...actual,
    getStoreStackRoot: () =>
      storeRootState.current ?? join(process.cwd(), 'tests', 'fixtures', 'no-store'),
  };
});

import { createSessionReadContext, findWorkspaces, listSessions } from '../../src/core/storage.js';
import { pathsEqual } from '../../src/lib/platform.js';
import {
  createSessionIntegrityFixtureRoot,
  writeStoreDb,
  writeStoreMeta,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';

const WS_DIR_ID = '5e8003f9d6bff0ab3ddbb6d0c75778b3';

interface GlobalComposer {
  id: string;
  workspaceIdentifier?: Record<string, unknown>;
  workspaceUri?: string;
}

function writeWorkspaceDir(
  fixture: SessionIntegrityFixtureRoot,
  dirId: string,
  codeWorkspacePath: string,
  composerIds: string[] = []
): void {
  const dir = join(fixture.workspaceStorage, dirId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'workspace.json'),
    JSON.stringify({ workspace: pathToFileURL(codeWorkspacePath).href })
  );
  const db = new BetterSqlite3(join(dir, 'state.vscdb'));
  db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(
    'composer.composerData',
    JSON.stringify({
      allComposers: composerIds.map((composerId) => ({
        composerId,
        name: 'ws entry',
        createdAt: 1_783_000_000_000,
        lastUpdatedAt: 1_783_000_000_000,
      })),
    })
  );
  db.close();
}

function writeGlobal(fixture: SessionIntegrityFixtureRoot, composers: GlobalComposer[]): void {
  mkdirSync(fixture.globalStorage, { recursive: true });
  const db = new BetterSqlite3(join(fixture.globalStorage, 'state.vscdb'));
  db.exec('CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const insert = db.prepare('INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)');
  for (const composer of composers) {
    insert.run(
      `bubbleId:${composer.id}:b1`,
      JSON.stringify({ bubbleId: 'b1', type: 1, text: 'hello', createdAt: 1_783_000_000_000 })
    );
    insert.run(
      `composerData:${composer.id}`,
      JSON.stringify({
        name: `title ${composer.id.slice(0, 4)}`,
        createdAt: 1_783_000_000_000,
        lastUpdatedAt: 1_783_000_000_100,
        ...(composer.workspaceIdentifier
          ? { workspaceIdentifier: composer.workspaceIdentifier }
          : {}),
        ...(composer.workspaceUri ? { workspaceUri: composer.workspaceUri } : {}),
        fullConversationHeadersOnly: [{ bubbleId: 'b1', type: 1 }],
      })
    );
  }
  db.close();
}

function addStore(fixture: SessionIntegrityFixtureRoot, id: string): void {
  storeRootState.current = fixture.storeRoot;
  const dbPath = writeStoreDb(fixture, id, [{ role: 'assistant', content: 'store text' }], 'Store');
  writeStoreMeta(dirname(dbPath), {
    title: 'Store',
    hasConversation: true,
    createdAtMs: 1_783_000_000_000,
  });
}

afterEach(() => {
  storeRootState.current = undefined;
});

const GLOBAL = '(global)';

async function listAll(fixture: SessionIntegrityFixtureRoot, workspacePath?: string) {
  const context = createSessionReadContext({
    dataPath: fixture.workspaceStorage,
    ...(workspacePath ? { workspacePath } : {}),
  });
  return listSessions(
    { limit: 0, all: true, ...(workspacePath ? { workspacePath } : {}) },
    fixture.workspaceStorage,
    undefined,
    context
  );
}

function pathOf(
  rows: Array<{ id: string; workspacePath: string }>,
  id: string
): string | undefined {
  return rows.find((row) => row.id === id)?.workspacePath;
}

describe('multi-root (.code-workspace) global composer attribution', () => {
  const ID_ONLY = 'aaaaaaaa-0000-0000-0000-0000000000a1';
  const ID_STORE = 'aaaaaaaa-0000-0000-0000-0000000000a2';
  const CFG_ONLY = 'aaaaaaaa-0000-0000-0000-0000000000a3';
  const URI_REC = 'aaaaaaaa-0000-0000-0000-0000000000a4';
  const NO_IDENT = 'aaaaaaaa-0000-0000-0000-0000000000a5';

  it('attributes id+configPath records (no uri) in unscoped, scoped and workspace counts', async () => {
    const fixture = createSessionIntegrityFixtureRoot('ch-multiroot-');
    try {
      const code = join(fixture.root, 'ws', 'multi.code-workspace');
      writeWorkspaceDir(fixture, WS_DIR_ID, code);
      writeGlobal(fixture, [
        { id: ID_ONLY, workspaceIdentifier: { id: WS_DIR_ID, configPath: { fsPath: code } } },
        { id: ID_STORE, workspaceIdentifier: { id: WS_DIR_ID, configPath: { fsPath: code } } },
        { id: NO_IDENT },
      ]);
      addStore(fixture, ID_STORE);

      const unscoped = await listAll(fixture);
      expect(pathsEqual(pathOf(unscoped, ID_ONLY)!, code)).toBe(true);
      // Store-merged record: this is the path that previously fell back to (global).
      expect(pathsEqual(pathOf(unscoped, ID_STORE)!, code)).toBe(true);
      expect(pathOf(unscoped, NO_IDENT)).toBe(GLOBAL);
      expect(unscoped.find((row) => row.id === ID_STORE)?.resolvedSource).toBe('merged');

      const scoped = await listAll(fixture, code);
      expect(scoped.map(({ id }) => id)).toContain(ID_ONLY);
      expect(scoped.map(({ id }) => id)).not.toContain(NO_IDENT);

      const byBasename = await listAll(fixture, 'multi.code-workspace');
      expect(byBasename.map(({ id }) => id)).toContain(ID_ONLY);

      const workspaces = await findWorkspaces(fixture.workspaceStorage);
      const ws = workspaces.find((w) => w.id === WS_DIR_ID);
      expect(ws?.sessionCount).toBe(2);
    } finally {
      fixture.cleanup();
    }
  });

  it('attributes a configPath-only record (no id, no uri)', async () => {
    const fixture = createSessionIntegrityFixtureRoot('ch-multiroot-cfg-');
    try {
      const code = join(fixture.root, 'ws', 'multi.code-workspace');
      writeWorkspaceDir(fixture, WS_DIR_ID, code);
      writeGlobal(fixture, [
        { id: CFG_ONLY, workspaceIdentifier: { configPath: { fsPath: code } } },
      ]);
      addStore(fixture, CFG_ONLY);

      const unscoped = await listAll(fixture);
      expect(pathsEqual(pathOf(unscoped, CFG_ONLY)!, code)).toBe(true);
      const scoped = await listAll(fixture, code);
      expect(scoped.map(({ id }) => id)).toContain(CFG_ONLY);
      const ws = (await findWorkspaces(fixture.workspaceStorage)).find((w) => w.id === WS_DIR_ID);
      expect(ws?.sessionCount).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });

  it('leaves uri-stamped records unchanged', async () => {
    const fixture = createSessionIntegrityFixtureRoot('ch-multiroot-uri-');
    try {
      const code = join(fixture.root, 'ws', 'multi.code-workspace');
      const project = join(fixture.root, 'proj');
      writeWorkspaceDir(fixture, WS_DIR_ID, code);
      writeGlobal(fixture, [{ id: URI_REC, workspaceIdentifier: { uri: { fsPath: project } } }]);
      addStore(fixture, URI_REC);
      const unscoped = await listAll(fixture);
      expect(pathsEqual(pathOf(unscoped, URI_REC)!, project)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('keeps a composer claimed by two workspaces on the pre-existing single-attribution path', async () => {
    const fixture = createSessionIntegrityFixtureRoot('ch-multiroot-claim-');
    try {
      const codeA = join(fixture.root, 'ws', 'a.code-workspace');
      const codeB = join(fixture.root, 'ws', 'b.code-workspace');
      const dirB = '22222222222222222222222222222222';
      // A lists the composer in its own workspace DB; the global record is stamped for B.
      writeWorkspaceDir(fixture, WS_DIR_ID, codeA, [ID_ONLY]);
      writeWorkspaceDir(fixture, dirB, codeB);
      writeGlobal(fixture, [
        { id: ID_ONLY, workspaceIdentifier: { id: dirB, configPath: { fsPath: codeB } } },
      ]);
      const unscoped = await listAll(fixture);
      const rows = unscoped.filter(({ id }) => id === ID_ONLY);
      expect(rows).toHaveLength(1);
      // Reference behaviour (unchanged by this fix): the workspace-DB claim wins the single row.
      expect(pathsEqual(rows[0]!.workspacePath, codeA)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});
