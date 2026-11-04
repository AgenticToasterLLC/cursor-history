import { afterEach, describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { migrateSession } from '../../src/core/migrate.js';
import { registry } from '../../src/core/database/registry.js';
import { betterSqlite3Driver } from '../../src/core/database/drivers/better-sqlite3.js';
import { nodeSqliteDriver } from '../../src/core/database/drivers/node-sqlite.js';
import {
  createSessionIntegrityFixtureRoot,
  writeComposerGlobalSessions,
  writeComposerWorkspaceSummary,
  type ComposerFixtureSession,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';

const fixtures: SessionIntegrityFixtureRoot[] = [];
const previousStoreRoot = process.env['CURSOR_STORE_ROOT'];

afterEach(() => {
  registry.reset();
  registry.register(nodeSqliteDriver);
  registry.register(betterSqlite3Driver);
  if (previousStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = previousStoreRoot;
  for (const value of fixtures.splice(0)) value.cleanup();
});

function fixture(): SessionIntegrityFixtureRoot {
  const value = createSessionIntegrityFixtureRoot('cursor-history-migrate-spelling-');
  fixtures.push(value);
  process.env['CURSOR_STORE_ROOT'] = value.storeRoot;
  return value;
}

/** Global rows spell a Windows path as `/C:/x`, the way a decoded file URI does. */
function uriDecodedSpelling(path: string): string {
  const forward = path.replace(/\\/g, '/');
  return /^[A-Za-z]:\//.test(forward) ? `/${forward}` : forward;
}

function session(id: string, workspacePath: string): ComposerFixtureSession {
  return {
    id,
    title: `Session ${id.slice(0, 4)}`,
    workspacePath,
    createdAt: 1_700_000_000_000,
    messages: [{ id: `${id}-bubble`, role: 'user', content: 'hello' }],
  };
}

function destination(value: SessionIntegrityFixtureRoot): { path: string; databasePath: string } {
  const path = join(value.root, 'workspaces', 'destination');
  mkdirSync(path, { recursive: true });
  return {
    path,
    databasePath: writeComposerWorkspaceSummary(value, 'workspace-destination', path, []),
  };
}

function globalKeys(value: SessionIntegrityFixtureRoot): string[] {
  const db = new BetterSqlite3(join(value.globalStorage, 'state.vscdb'), { readonly: true });
  try {
    return (
      db.prepare('SELECT key FROM cursorDiskKV ORDER BY key').all() as Array<{ key: string }>
    ).map((row) => row.key);
  } finally {
    db.close();
  }
}

describe('migration with differently spelled workspace paths', () => {
  it('copies a session whose global row uses /C:/ while workspace.json uses file:///C:/', async () => {
    const value = fixture();
    const id = '31313131-2222-4333-8444-555555555555';
    // workspace.json is written by the helper as a file: URI from the native path.
    writeComposerWorkspaceSummary(value, 'workspace-a', value.projectA, [
      session(id, value.projectA),
    ]);
    writeComposerGlobalSessions(value, [session(id, uriDecodedSpelling(value.projectA))]);
    const dest = destination(value);

    const result = await migrateSession(id, {
      destination: dest.path,
      mode: 'copy',
      dryRun: false,
      force: false,
      dataPath: value.workspaceStorage,
      sourceWorkspacePath: value.projectA,
    });

    expect(result).toMatchObject({ success: true, mode: 'copy' });
    expect(result.newSessionId).toBeTruthy();
  });

  it('still refuses a session whose footprint is shared by two different workspaces', async () => {
    const value = fixture();
    const id = '32323232-2222-4333-8444-555555555555';
    const shared = session(id, uriDecodedSpelling(value.projectA));
    const a = writeComposerWorkspaceSummary(value, 'workspace-a', value.projectA, []);
    const b = writeComposerWorkspaceSummary(value, 'workspace-b', value.projectB, []);
    writeComposerGlobalSessions(value, [shared]);
    for (const databasePath of [a, b]) {
      const db = new BetterSqlite3(databasePath);
      try {
        db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
          `fixture.composerChatViewPane.${id}`,
          JSON.stringify({ composerId: id })
        );
      } finally {
        db.close();
      }
    }
    const dest = destination(value);
    const before = globalKeys(value);

    await expect(
      migrateSession(id, {
        destination: dest.path,
        mode: 'copy',
        dryRun: false,
        force: false,
        dataPath: value.workspaceStorage,
        sourceWorkspacePath: value.projectA,
      })
    ).rejects.toMatchObject({
      details: expect.objectContaining({ eligibility: 'shared-membership' }),
    });
    expect(globalKeys(value)).toEqual(before);
  });
});
