import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listWorkspaces } from '../../src/core/storage.js';
import { formatWorkspacesJson } from '../../src/cli/formatters/json.js';
import {
  createSessionIntegrityFixtureRoot,
  writeComposerWorkspaceSummary,
  writeStoreDbAtPath,
  writeStoreMeta,
  type ComposerFixtureSession,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';

/** Build a backslash-separated Windows path (a trailing empty part yields a trailing separator). */
function win(...parts: string[]): string {
  return parts.join(String.fromCharCode(92));
}

const previousStoreRoot = process.env['CURSOR_STORE_ROOT'];
const fixtures: SessionIntegrityFixtureRoot[] = [];

function fixture(): SessionIntegrityFixtureRoot {
  const value = createSessionIntegrityFixtureRoot('cursor-history-ws-normalization-');
  fixtures.push(value);
  process.env['CURSOR_STORE_ROOT'] = value.storeRoot;
  return value;
}

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()!.cleanup();
  if (previousStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = previousStoreRoot;
});

function composerSession(id: string): ComposerFixtureSession {
  return {
    id,
    title: `Composer ${id}`,
    workspacePath: 'ignored',
    createdAt: 1_700_000_000_000,
    messages: [{ role: 'user', content: 'hello' }],
  };
}

/** Write a Composer workspace and then replace its workspace.json with an exact raw document. */
function composerWorkspace(
  root: SessionIntegrityFixtureRoot,
  workspaceId: string,
  workspaceJson: Record<string, string>,
  sessionIds: readonly string[]
): void {
  writeComposerWorkspaceSummary(root, workspaceId, root.projectA, sessionIds.map(composerSession));
  writeFileSync(
    join(root.workspaceStorage, workspaceId, 'workspace.json'),
    JSON.stringify(workspaceJson)
  );
}

function storeSession(
  root: SessionIntegrityFixtureRoot,
  lane: string,
  id: string,
  cwd: string
): void {
  const dbPath = join(root.storeRoot, 'chats', lane, id, 'store.db');
  writeStoreDbAtPath(dbPath, id, [{ role: 'user', content: `store ${id}` }], `Store ${id}`);
  writeStoreMeta(dirname(dbPath), {
    cwd,
    title: `Store ${id}`,
    hasConversation: true,
    createdAtMs: 1_700_000_000_000,
  });
  mkdirSync(dirname(dbPath), { recursive: true });
}

function summarize(
  workspaces: Awaited<ReturnType<typeof listWorkspaces>>
): Array<{ id: string; path: string; sessionCount: number }> {
  return workspaces.map(({ id, path, sessionCount }) => ({
    id: id.length === 32 || /^[0-9a-f-]{8,}$/u.test(id) ? '<composer-dir>' : id,
    path,
    sessionCount,
  }));
}

describe('list --workspaces aggregation keys (characterization)', () => {
  it('aggregates drive casing, backslash, WSL, and Store-only spellings', async () => {
    const root = fixture();
    composerWorkspace(root, 'ws-alpha', { folder: 'file:///c%3A/Work/Alpha' }, [
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
    ]);
    composerWorkspace(
      root,
      'ws-beta',
      { workspace: 'file:///d%3A/Teams/Beta/beta.code-workspace' },
      ['10000000-0000-4000-8000-000000000003']
    );
    composerWorkspace(root, 'ws-gamma', { folder: 'file:///mnt/c/Work/Gamma' }, [
      '10000000-0000-4000-8000-000000000004',
    ]);

    storeSession(
      root,
      'lane-a',
      '20000000-0000-4000-8000-000000000001',
      win('C:', 'work', 'ALPHA', '')
    );
    storeSession(root, 'lane-b', '20000000-0000-4000-8000-000000000002', 'c:/Work/Gamma');
    storeSession(
      root,
      'lane-c',
      '20000000-0000-4000-8000-000000000003',
      win('E:', 'Only', 'Store')
    );
    storeSession(root, 'lane-d', '20000000-0000-4000-8000-000000000004', '/mnt/e/only/STORE/');
    storeSession(root, 'lane-e', '20000000-0000-4000-8000-000000000005', win('F:', 'Solo', 'One'));

    const workspaces = await listWorkspaces(root.workspaceStorage);
    expect(summarize(workspaces)).toMatchInlineSnapshot(`
      [
        {
          "id": "ws-alpha",
          "path": "/c:/Work/Alpha",
          "sessionCount": 3,
        },
        {
          "id": "ws-gamma",
          "path": "/mnt/c/Work/Gamma",
          "sessionCount": 2,
        },
        {
          "id": "store:e:/only/store",
          "path": "e:/only/store",
          "sessionCount": 2,
        },
        {
          "id": "ws-beta",
          "path": "/d:/Teams/Beta/beta.code-workspace",
          "sessionCount": 1,
        },
        {
          "id": "store:f:/solo/one",
          "path": "f:/solo/one",
          "sessionCount": 1,
        },
      ]
    `);
    expect(JSON.parse(formatWorkspacesJson(workspaces))).toMatchInlineSnapshot(`
      {
        "count": 5,
        "workspaces": [
          {
            "id": "ws-alpha",
            "path": "c:/work/alpha",
            "sessionCount": 3,
          },
          {
            "id": "ws-gamma",
            "path": "c:/work/gamma",
            "sessionCount": 2,
          },
          {
            "id": "store:e:/only/store",
            "path": "e:/only/store",
            "sessionCount": 2,
          },
          {
            "id": "ws-beta",
            "path": "d:/teams/beta/beta.code-workspace",
            "sessionCount": 1,
          },
          {
            "id": "store:f:/solo/one",
            "path": "f:/solo/one",
            "sessionCount": 1,
          },
        ],
      }
    `);
  });

  it('records current behavior for a file: URI Store cwd', async () => {
    const root = fixture();
    composerWorkspace(root, 'ws-alpha', { folder: 'file:///c%3A/Work/Alpha' }, [
      '10000000-0000-4000-8000-000000000001',
    ]);
    storeSession(root, 'lane-a', '20000000-0000-4000-8000-000000000001', 'file:///c:/Work/Alpha');
    storeSession(
      root,
      'lane-b',
      '20000000-0000-4000-8000-000000000002',
      win('C:', 'Work', '.', 'Alpha')
    );
    const workspaces = await listWorkspaces(root.workspaceStorage);
    expect(summarize(workspaces)).toMatchInlineSnapshot(`
      [
        {
          "id": "ws-alpha",
          "path": "/c:/Work/Alpha",
          "sessionCount": 3,
        },
      ]
    `);
  });

  it.skipIf(process.platform === 'win32')(
    'matches a home-contracted Composer path with its absolute Store spelling',
    async () => {
      const root = fixture();
      const home = join(homedir(), 'cursor-history-ws-normalization-home-project');
      composerWorkspace(root, 'ws-home', { folder: pathToFileURL(home).href }, [
        '10000000-0000-4000-8000-000000000009',
      ]);
      storeSession(root, 'lane-home', '20000000-0000-4000-8000-000000000009', home);
      const workspaces = await listWorkspaces(root.workspaceStorage);
      expect(workspaces.filter(({ path }) => path.includes('ws-normalization-home'))).toHaveLength(
        1
      );
    }
  );
});
