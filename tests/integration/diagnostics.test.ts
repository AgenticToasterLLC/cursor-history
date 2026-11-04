import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProfileCollector,
  getSession,
  listSessionSummaries,
  searchSessions,
  type DiagnosticEvent,
} from '../../src/lib/index.js';
import {
  createSessionIntegrityFixtureRoot,
  writeComposerGlobalSessions,
  writeComposerWorkspaceSummary,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';

const previousStoreRoot = process.env['CURSOR_STORE_ROOT'];
const fixtures: SessionIntegrityFixtureRoot[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  if (previousStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = previousStoreRoot;
  while (fixtures.length > 0) fixtures.pop()!.cleanup();
});

const MARKER = 'zqxleakmarkerzqx';
const ID_MARKER = 'deadbeef';

function build(): { fx: SessionIntegrityFixtureRoot; id: string } {
  const fx = createSessionIntegrityFixtureRoot('cursor-history-diag-');
  fixtures.push(fx);
  process.env['CURSOR_STORE_ROOT'] = fx.storeRoot;
  const id = `${ID_MARKER}-0000-0000-0000-000000000099`;
  const session = {
    id,
    title: `Title ${MARKER}`,
    workspacePath: `${fx.projectA}-${MARKER}`,
    createdAt: 1_700_000_000_000,
    messages: [
      { role: 'user' as const, content: `hello ${MARKER} text` },
      { role: 'assistant' as const, content: `reply ${MARKER}` },
    ],
  };
  writeComposerWorkspaceSummary(fx, `ws-${MARKER}`, session.workspacePath, [session]);
  writeComposerGlobalSessions(fx, [session]);
  return { fx, id };
}

describe('diagnostics sink', () => {
  it('attributes phases and statements without leaking content', async () => {
    const { fx, id } = build();
    const collector = createProfileCollector();
    const config = { dataPath: fx.workspaceStorage, diagnostics: collector };

    const rows = await listSessionSummaries({ ...config, limit: 10 });
    expect(rows.data.length).toBeGreaterThan(0);
    await getSession(id, config);
    await searchSessions(MARKER, config);

    const summary = collector.toJSON();
    expect(Object.keys(summary.phases)).toEqual(
      expect.arrayContaining([
        'A:store-discovery',
        'B:find-workspaces',
        'C:workspace-loop',
        'D:global-db',
        'F:merge-sort',
        'getSession/hydrate',
        'search:session-loop',
      ])
    );
    expect(summary.queries.length).toBeGreaterThan(0);
    expect(Object.keys(summary.dbOpens).length).toBeGreaterThan(0);

    const serialized = JSON.stringify(summary).toLowerCase();
    for (const secret of [MARKER, ID_MARKER, fx.root, 'hello', 'reply']) {
      expect(serialized).not.toContain(secret.toLowerCase());
    }
  });

  it('leaves results unchanged and survives a throwing sink', async () => {
    const { fx } = build();
    const baseline = await listSessionSummaries({ dataPath: fx.workspaceStorage, limit: 10 });
    const events: DiagnosticEvent[] = [];
    const throwing = {
      onEvent(event: DiagnosticEvent) {
        events.push(event);
        throw new Error('sink failure');
      },
    };
    const observed = await listSessionSummaries({
      dataPath: fx.workspaceStorage,
      limit: 10,
      diagnostics: throwing,
    });
    expect(events.length).toBeGreaterThan(0);
    expect(observed).toEqual(baseline);
  });

  it('reads no clock when no sink is configured', async () => {
    const { fx } = build();
    const now = vi.spyOn(performance, 'now');
    await listSessionSummaries({ dataPath: fx.workspaceStorage, limit: 10 });
    expect(now).not.toHaveBeenCalled();
  });

  it('rejects a malformed sink', async () => {
    await expect(listSessionSummaries({ diagnostics: {} as never })).rejects.toThrow(/diagnostics/);
  });
});
