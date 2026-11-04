import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createProfileCollector,
  InvalidConfigError,
  listSessionSummaries,
  listWorkspaces,
  searchSessions,
  type WorkspaceScopeResolution,
} from '../../src/lib/index.js';
import {
  createSessionReadContext,
  getWorkspaceScopeResolution,
  listSessionSummaries as coreListSessionSummaries,
  listWorkspaceInventory,
} from '../../src/core/storage.js';
import { WorkspaceAmbiguityError } from '../../src/core/errors.js';
import {
  createSessionIntegrityFixtureRoot,
  writeComposerGlobalSessions,
  writeComposerWorkspaceSummary,
  writeStoreDbAtPath,
  writeStoreMeta,
  type ComposerFixtureSession,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';
import { createIoEventRecorder } from '../helpers/io-probe.js';

const previousStoreRoot = process.env['CURSOR_STORE_ROOT'];
const fixtures: SessionIntegrityFixtureRoot[] = [];

function fixture(): SessionIntegrityFixtureRoot {
  const value = createSessionIntegrityFixtureRoot('cursor-history-fastpath-');
  fixtures.push(value);
  process.env['CURSOR_STORE_ROOT'] = value.storeRoot;
  return value;
}

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()!.cleanup();
  if (previousStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = previousStoreRoot;
});

/** Build a backslash-separated Windows path. */
function win(...parts: string[]): string {
  return parts.join(String.fromCharCode(92));
}

function session(id: string, text: string, workspacePath: string): ComposerFixtureSession {
  return {
    id,
    title: `Session ${id}`,
    workspacePath,
    createdAt: 1_700_000_000_000,
    messages: [{ id: `m-${id}`, role: 'user', content: text, createdAt: 1_700_000_000_000 }],
  };
}

/** A Composer workspace whose workspace.json is replaced with an exact raw document. */
function composerWorkspace(
  root: SessionIntegrityFixtureRoot,
  workspaceId: string,
  workspaceJson: Record<string, string>,
  sessions: readonly ComposerFixtureSession[]
): void {
  writeComposerWorkspaceSummary(root, workspaceId, root.projectA, sessions);
  writeFileSync(
    join(root.workspaceStorage, workspaceId, 'workspace.json'),
    JSON.stringify(workspaceJson)
  );
}

/** A workspace directory that holds only metadata plus a non-SQLite state.vscdb (poison). */
function metadataOnlyWorkspace(
  root: SessionIntegrityFixtureRoot,
  workspaceId: string,
  workspaceJson: Record<string, string>
): void {
  const dir = join(root.workspaceStorage, workspaceId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'workspace.json'), JSON.stringify(workspaceJson));
  writeFileSync(join(dir, 'state.vscdb'), 'not a sqlite database');
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
}

const ID = (n: number): string => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('listWorkspaces inventory', () => {
  it('merges raw spellings per normalized path without opening any database', async () => {
    const root = fixture();
    metadataOnlyWorkspace(root, 'ws-win', { folder: 'file:///c%3A/Work/Alpha' });
    metadataOnlyWorkspace(root, 'ws-wsl', { folder: 'file:///mnt/c/Work/Alpha' });
    metadataOnlyWorkspace(root, 'ws-code', {
      workspace: 'file:///d%3A/Teams/Beta/beta.code-workspace',
    });
    // Store sidecars beside a junk (non-SQLite) store.db: opening it would throw.
    for (const [lane, id, cwd] of [
      ['lane-a', ID(1), win('C:', 'work', 'ALPHA')],
      ['lane-b', ID(2), win('E:', 'Only', 'Store')],
    ] as const) {
      const dir = join(root.storeRoot, 'chats', lane, id);
      writeStoreMeta(dir, { cwd, hasConversation: true });
      writeFileSync(join(dir, 'store.db'), 'not a sqlite database');
    }

    const recorder = createIoEventRecorder();
    const entries = await listWorkspaceInventory(root.workspaceStorage, undefined, {
      ioObserver: recorder.observer,
    });
    expect(recorder.count()).toBeGreaterThan(0);
    recorder.assertNone({ adapter: 'sqlite' }, 'inventory must not open a SQLite database');
    recorder.assertNone(
      { classification: 'conversation-payload' },
      'inventory must not read conversation payload'
    );
    recorder.assertNone({ resourceClass: 'store-database' });
    recorder.assertNone({ resourceClass: 'workspace-conversation' });

    const alpha = entries.find((entry) => entry.path === 'c:/work/alpha');
    expect(alpha).toBeDefined();
    expect(alpha!.sources).toEqual(['composer', 'store']);
    expect(alpha!.workspaceStorageIds).toEqual(['ws-win', 'ws-wsl']);
    expect(alpha!.aliases).toHaveLength(3);
    expect(alpha!.aliases).toContain(win('C:', 'work', 'ALPHA'));
    expect(alpha!.aliases).toEqual([...alpha!.aliases].sort());
    expect(alpha!.lastModifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/u);

    expect(entries.map((entry) => entry.path).sort()).toEqual([
      'c:/work/alpha',
      'd:/teams/beta/beta.code-workspace',
      'e:/only/store',
    ]);
    const storeOnly = entries.find((entry) => entry.path === 'e:/only/store');
    expect(storeOnly).toMatchObject({ sources: ['store'], workspaceStorageIds: [] });
  });

  it('filters by query, paginates, orders deterministically, and validates limits', async () => {
    const root = fixture();
    metadataOnlyWorkspace(root, 'ws-1', { folder: 'file:///c%3A/Work/Alpha' });
    metadataOnlyWorkspace(root, 'ws-2', { folder: 'file:///c%3A/Work/Beta' });
    metadataOnlyWorkspace(root, 'ws-3', { folder: 'file:///c%3A/Work/Gamma' });

    const all = await listWorkspaces({ dataPath: root.workspaceStorage });
    expect(all.pagination).toEqual({ total: 3, limit: 50, offset: 0, hasMore: false });
    const times = all.data.map((entry) => entry.lastModifiedAt ?? '');
    expect(times).toEqual([...times].sort().reverse());

    const again = await listWorkspaces({ dataPath: root.workspaceStorage });
    expect(again.data.map((entry) => entry.path)).toEqual(all.data.map((entry) => entry.path));

    const filtered = await listWorkspaces({ dataPath: root.workspaceStorage, query: 'WORK/BE' });
    expect(filtered.data.map((entry) => entry.path)).toEqual(['c:/work/beta']);

    const page = await listWorkspaces({ dataPath: root.workspaceStorage, limit: 2, offset: 1 });
    expect(page.data).toHaveLength(2);
    expect(page.data[0]!.path).toBe(all.data[1]!.path);
    expect(page.pagination).toEqual({ total: 3, limit: 2, offset: 1, hasMore: false });

    await expect(
      listWorkspaces({ dataPath: root.workspaceStorage, limit: 1001 })
    ).rejects.toBeInstanceOf(InvalidConfigError);
    await expect(
      listWorkspaces({ dataPath: root.workspaceStorage, offset: -1 })
    ).rejects.toBeInstanceOf(InvalidConfigError);
  });
});

describe('workspace scope resolution and fast not-found', () => {
  function seedAliasCorpus(root: SessionIntegrityFixtureRoot): void {
    const alpha = session(ID(11), 'alpha needle', 'c:/Work/Alpha');
    const beta = session(ID(12), 'beta needle', 'd:/Teams/Beta');
    composerWorkspace(root, 'ws-alpha', { folder: 'file:///c%3A/Work/Alpha' }, [alpha]);
    composerWorkspace(
      root,
      'ws-beta',
      { workspace: 'file:///d%3A/Teams/Beta/beta.code-workspace' },
      [beta]
    );
    writeComposerGlobalSessions(root, [alpha, beta]);
  }

  it.each([
    ['exact', win('C:', 'work', 'ALPHA'), 'exact'],
    ['trailing slash and forward slashes', 'c:/Work/Alpha/', 'exact'],
    ['WSL mount', '/mnt/c/work/alpha', 'exact'],
    ['file URI', 'file:///C:/Work/Alpha', 'exact'],
    ['unique component suffix', 'Work/Alpha', 'unique-suffix'],
    ['.code-workspace', win('D:', 'Teams', 'Beta', 'beta.code-workspace'), 'exact'],
  ])('resolves %s', async (_name, request, matchKind) => {
    const root = fixture();
    seedAliasCorpus(root);
    const result = await listSessionSummaries({
      dataPath: root.workspaceStorage,
      workspace: request,
    });
    expect(result.data).toHaveLength(1);
    expect(result.scope).toMatchObject({ state: 'matched', requested: request, matchKind });
  });

  it('reports a renamed path as not-found with a suggestion', async () => {
    const root = fixture();
    seedAliasCorpus(root);
    const result = await listSessionSummaries({
      dataPath: root.workspaceStorage,
      workspace: win('C:', 'Work', 'AlphaRenamed'),
    });
    expect(result.data).toEqual([]);
    expect(result.pagination.total).toBe(0);
    expect(result.scope).toEqual({
      state: 'not-found',
      requested: win('C:', 'Work', 'AlphaRenamed'),
      normalizedRequest: 'c:/work/alpharenamed',
      suggestions: [{ path: 'c:/work/alpha', reason: 'substring', score: 0.2 }],
    });
  });

  it('ranks variants, shared trailing components, basenames, then substrings (max 5)', async () => {
    const root = fixture();
    for (const [index, path] of [
      '/srv/team/jaee/graphql-api',
      '/old/jaee/GraphQLApi',
      '/old/misc/GraphQLApi',
      '/old/GraphQLApiLegacy',
      '/old/other/GraphQLApi2',
      '/unrelated/thing',
    ].entries()) {
      metadataOnlyWorkspace(root, `ws-${index}`, { folder: `file://${path}` });
    }
    const result = await listSessionSummaries({
      dataPath: root.workspaceStorage,
      workspace: '/srv/team/jaee/GraphQLApi',
    });
    const scope = result.scope as Extract<WorkspaceScopeResolution, { state: 'not-found' }>;
    expect(scope.state).toBe('not-found');
    expect(scope.suggestions.length).toBeLessThanOrEqual(5);
    expect(scope.suggestions.map(({ reason }) => reason)).toEqual(
      [...scope.suggestions.map(({ reason }) => reason)].sort(
        (a, b) =>
          [
            'case-or-separator-variant',
            'shared-trailing-components',
            'same-basename',
            'substring',
          ].indexOf(a) -
          [
            'case-or-separator-variant',
            'shared-trailing-components',
            'same-basename',
            'substring',
          ].indexOf(b)
      )
    );
    const scores = scope.suggestions.map(({ score }) => score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(scope.suggestions[0]).toMatchObject({
      reason: 'case-or-separator-variant',
      score: 1,
    });
    expect(scope.suggestions.map(({ path }) => path)).toContain(
      '/old/jaee/GraphQLApi'.toLowerCase()
    );
    expect(scope.suggestions.some(({ reason }) => reason === 'shared-trailing-components')).toBe(
      true
    );
  });

  it('keeps ambiguous suffixes explicit', async () => {
    const root = fixture();
    metadataOnlyWorkspace(root, 'ws-1', { folder: 'file:///c%3A/x/team/project' });
    metadataOnlyWorkspace(root, 'ws-2', { folder: 'file:///d%3A/y/team/project' });
    await expect(
      listSessionSummaries({ dataPath: root.workspaceStorage, workspace: 'team/project' })
    ).rejects.toBeInstanceOf(WorkspaceAmbiguityError);
    await expect(
      listSessionSummaries({ dataPath: root.workspaceStorage, workspace: 'team/project' })
    ).rejects.toMatchObject({ code: 'WORKSPACE_AMBIGUOUS' });
  });

  it('distinguishes empty (matched, zero sessions) from not-found', async () => {
    const root = fixture();
    composerWorkspace(root, 'ws-empty', { folder: 'file:///c%3A/Work/Empty' }, []);
    const empty = await listSessionSummaries({
      dataPath: root.workspaceStorage,
      workspace: 'c:/work/empty',
    });
    expect(empty.data).toEqual([]);
    expect(empty.scope).toEqual({
      state: 'empty',
      requested: 'c:/work/empty',
      path: 'c:/work/empty',
      matchKind: 'exact',
    });

    const unknown = await listSessionSummaries({
      dataPath: root.workspaceStorage,
      workspace: 'c:/work/never-seen',
    });
    expect(unknown.scope?.state).toBe('not-found');
  });

  it('omits scope for unscoped reads and attaches it to search results without changing them', async () => {
    const root = fixture();
    seedAliasCorpus(root);
    const unscoped = await listSessionSummaries({ dataPath: root.workspaceStorage });
    expect(unscoped).not.toHaveProperty('scope');
    expect(unscoped.data).toHaveLength(2);

    const scoped = await searchSessions('needle', {
      dataPath: root.workspaceStorage,
      workspace: 'c:/work/alpha',
    });
    expect(scoped).toHaveLength(1);
    expect(scoped.scope).toMatchObject({ state: 'matched', path: 'c:/work/alpha' });
    expect(Object.keys(scoped)).toEqual(['0']);
    expect(JSON.parse(JSON.stringify(scoped))).toHaveLength(1);

    const missing = await searchSessions('needle', {
      dataPath: root.workspaceStorage,
      workspace: 'c:/work/missing',
    });
    expect(missing).toEqual([]);
    expect(missing.scope?.state).toBe('not-found');
  });

  it('answers not-found without any database open, Store payload read, or global scan', async () => {
    const root = fixture();
    seedAliasCorpus(root);
    storeSession(root, 'lane-a', ID(21), win('C:', 'work', 'ALPHA'));
    const recorder = createIoEventRecorder();
    const request = win('C:', 'ProjectCode', 'JA', 'repo', 'jaee', 'GraphQLApi');
    const profile = createProfileCollector();
    const context = createSessionReadContext({
      dataPath: root.workspaceStorage,
      workspacePath: request,
      ioObserver: recorder.observer,
      diagnostics: profile,
    });
    try {
      const rows = await coreListSessionSummaries(
        { limit: 0, all: true, workspacePath: request },
        root.workspaceStorage,
        undefined,
        context
      );
      expect(rows).toEqual([]);
      const scope = getWorkspaceScopeResolution(context);
      expect(scope.state).toBe('not-found');
    } finally {
      await context.dispose();
    }
    expect(recorder.count()).toBeGreaterThan(0);
    recorder.assertNone({ adapter: 'sqlite' }, 'fast not-found must not open SQLite');
    recorder.assertNone({ adapter: 'key-value' }, 'fast not-found must not scan global KV');
    recorder.assertNone({ classification: 'conversation-payload' });
    recorder.assertNone({ resourceClass: 'global-session-index' });
    expect(profile.toJSON().dbOpens).toEqual({});
    expect(profile.toJSON().phases).not.toHaveProperty('B:find-workspaces');
    expect(profile.toJSON().phases).not.toHaveProperty('D:global-db');
  });

  it('falls through to the full path when a cheap Store match is not verified', async () => {
    const root = fixture();
    seedAliasCorpus(root);
    // hasConversation:false is omitted by Store metadata discovery, so the cheap superset
    // sees this cwd while the verified set does not. Full resolution must still say not-found.
    writeStoreMeta(join(root.storeRoot, 'chats', 'lane-ghost', ID(31)), {
      cwd: win('C:', 'Ghost', 'Project'),
      hasConversation: false,
    });
    const result = await listSessionSummaries({
      dataPath: root.workspaceStorage,
      workspace: win('C:', 'Ghost', 'Project'),
    });
    expect(result.data).toEqual([]);
    expect(result.scope?.state).toBe('not-found');
  });
});

describe('searchSessions hydration', () => {
  it('hydrates each hit once', async () => {
    const root = fixture();
    const first = session(ID(41), 'shared needle one', 'c:/Work/Alpha');
    const second = session(ID(42), 'shared needle two', 'c:/Work/Alpha');
    composerWorkspace(root, 'ws-alpha', { folder: 'file:///c%3A/Work/Alpha' }, [first, second]);
    writeComposerGlobalSessions(root, [first, second]);

    const profile = createProfileCollector();
    const results = await searchSessions('needle', {
      dataPath: root.workspaceStorage,
      diagnostics: profile,
    });
    expect(results).toHaveLength(2);
    expect(results.map((result) => result.match).sort()).toEqual([
      'shared needle one',
      'shared needle two',
    ]);
    expect(profile.toJSON().phases['getSession/hydrate']?.count).toBe(2);
  });
});

describe('searchSessions with a divergent-replica session', () => {
  function seedDivergentCorpus(root: SessionIntegrityFixtureRoot): {
    healthy: ComposerFixtureSession;
    ambiguousId: string;
  } {
    const healthy = session(ID(51), 'healthy needle', root.projectB);
    composerWorkspace(root, 'ws-healthy', { folder: pathToFileURL(root.projectB).href }, [healthy]);
    writeComposerGlobalSessions(root, [healthy]);
    // Same native UUID in two workspace databases with different content: divergent replicas.
    const left = {
      ...session(ID(52), 'divergent-left needle', root.projectA),
      title: 'divergent-left needle',
    };
    const right = {
      ...session(ID(52), 'divergent-right needle', root.projectA),
      title: 'divergent-right needle',
    };
    composerWorkspace(root, 'ws-left', { folder: pathToFileURL(root.projectA).href }, [left]);
    composerWorkspace(root, 'ws-right', { folder: pathToFileURL(root.projectA).href }, [right]);
    return { healthy, ambiguousId: ID(52) };
  }

  it('returns the other matches and reports the ambiguous session without hydrating it', async () => {
    const root = fixture();
    const { healthy, ambiguousId } = seedDivergentCorpus(root);
    const diagnostics: Array<Record<string, unknown>> = [];
    const profile = createProfileCollector();
    const results = await searchSessions('needle', {
      dataPath: root.workspaceStorage,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic as Record<string, unknown>),
      diagnostics: profile,
    });
    expect(results.map((result) => result.session.id)).toEqual([healthy.id]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: 'SESSION_AMBIGUOUS',
      sessionId: ambiguousId,
      occurrenceCount: 2,
    });
    expect(JSON.stringify(diagnostics)).not.toContain('needle');
    expect(profile.toJSON().phases['getSession/hydrate']?.count).toBe(1);
  });

  it('keeps the strict default explicit but fails before hydrating any conversation', async () => {
    const root = fixture();
    const { ambiguousId } = seedDivergentCorpus(root);
    const profile = createProfileCollector();
    await expect(
      searchSessions('needle', { dataPath: root.workspaceStorage, diagnostics: profile })
    ).rejects.toMatchObject({
      code: 'SESSION_AMBIGUOUS',
      details: { sessionId: ambiguousId },
    });
    expect(profile.toJSON().phases['getSession/hydrate']).toBeUndefined();
  });
});
