import BetterSqlite3 from 'better-sqlite3';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createProfileCollector,
  listSessionSummaries,
  type LibraryConfig,
} from '../../src/lib/index.js';
import { buildR2Corpus, type R2Corpus } from '../helpers/r2-corpus.js';

/**
 * R2 read-reduction proof, measured with the diagnostics collector. The corpus
 * has three workspace databases (a, b, c) and one global database.
 */
const previousStoreRoot = process.env['CURSOR_STORE_ROOT'];
let corpus: R2Corpus;

beforeAll(async () => {
  corpus = await buildR2Corpus('r2-reads-');
  process.env['CURSOR_STORE_ROOT'] = corpus.fx.storeRoot;
});

afterAll(() => {
  if (previousStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = previousStoreRoot;
  corpus?.fx.cleanup();
});

const BUBBLE_RANGE_SCAN =
  /FROM cursorDiskKV WHERE key >= \? AND key < \? ORDER BY key ASC LIMIT \?/u;

async function profile(config: LibraryConfig) {
  const collector = createProfileCollector();
  await listSessionSummaries({ ...config, diagnostics: collector });
  const summary = collector.toJSON();
  const opens = Object.fromEntries(
    Object.entries(summary.dbOpens).map(([name, value]) => [name, value.count])
  );
  // Each statement emits one "prepare" event plus one per execution; count executions.
  const executions = (q: { count: number; ops: Record<string, number> }): number =>
    q.count - (q.ops['prepare'] ?? 0);
  const count = (pattern: RegExp): number =>
    summary.queries
      .filter(({ sqlShape }) => pattern.test(sqlShape))
      .reduce((total, q) => total + executions(q), 0);
  return {
    opens,
    bubbleKeyRangeScans: count(BUBBLE_RANGE_SCAN),
    composerDataPageQueries: count(
      /^SELECT CAST\(cursorDiskKV\.rowid AS TEXT\) AS rowId, key, length\(CAST\(value AS BLOB\)\) AS byteLength FROM cursorDiskKV WHERE key LIKE/u
    ),
    membershipProjections: count(/END AS workspaceId/u),
    jsonEachStatements: count(/json_each/u),
    totalStatements: summary.queries.reduce((total, q) => total + executions(q), 0),
    summary,
  };
}

describe('R2 read reduction (diagnostics collector)', () => {
  it('global list opens each database once and scans bubble keys once', async () => {
    const result = await profile({ dataPath: corpus.fx.workspaceStorage });
    if (process.env['R2_PRINT']) {
      const { summary: _omit, ...rest } = result;
      console.log('R2 global', JSON.stringify(rest));
    }
    // Three workspace databases, each opened exactly once (previously twice:
    // discovery in phase B and again in the workspace loop in phase C).
    expect(result.opens['workspace-conversation']).toBe(3);
    // The global database handle is opened twice: once by findWorkspaces
    // (phase B) and once by phase D, which needs a live handle for point reads.
    // Opening is cheap; the expensive part, the scans, is shared (below).
    expect(result.opens['global-session-index']).toBe(2);
    // Counts and spellings come from one bubbleId: key-range walk
    // (previously 4: counts and spellings, in both phase B and phase D).
    expect(result.bubbleKeyRangeScans).toBe(1);
    // The composerData table is walked once, by the record scan that also
    // yields the key spellings (previously 4 page-query passes).
    expect(result.composerDataPageQueries).toBe(1);
  });

  it('workspace-scoped list shares scans and the membership projection', async () => {
    const result = await profile({
      dataPath: corpus.fx.workspaceStorage,
      workspace: corpus.fx.projectA,
    });
    if (process.env['R2_PRINT']) {
      const { summary: _omit, ...rest } = result;
      console.log('R2 ws-a', JSON.stringify(rest));
    }
    // The in-scope workspace is read once (previously twice); the two
    // off-scope workspaces are opened once each for their UUID-only index.
    expect(result.opens['workspace-conversation']).toBe(1);
    expect(result.opens['workspace-session-index']).toBe(2);
    expect(result.opens['global-session-index']).toBe(2);
    expect(result.bubbleKeyRangeScans).toBe(1);
    // One projection pass over the composerData rows, shared by phases B and D
    // (previously one pass per candidate workspace in each phase).
    const db = new BetterSqlite3(join(corpus.fx.globalStorage, 'state.vscdb'), { readonly: true });
    const composerRows = (
      db
        .prepare("SELECT COUNT(*) AS n FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
        .get() as {
        n: number;
      }
    ).n;
    db.close();
    expect(result.membershipProjections).toBe(composerRows);
    // UUID projection is one paged statement, not one statement per item.
    expect(result.jsonEachStatements).toBeLessThanOrEqual(2);
  });
});

describe('R2 off-scope Composer UUID projection paging', () => {
  it('finds a UUID past the first page with one statement per page', async () => {
    const fx = (
      await import('../helpers/session-integrity-fixtures.js')
    ).createSessionIntegrityFixtureRoot('r2-paging-');
    try {
      const { writeComposerWorkspaceSummary } =
        await import('../helpers/session-integrity-fixtures.js');
      const shared = 'cccccccc-0000-0000-0000-00000000ffff';
      const many = Array.from({ length: 600 }, (_, index) => ({
        id: index === 590 ? shared : `dddddddd-0000-0000-0000-${String(index).padStart(12, '0')}`,
        title: `Bulk ${index}`,
        workspacePath: fx.projectB,
        createdAt: 1_700_000_000_000 + index,
        messages: [],
      }));
      writeComposerWorkspaceSummary(fx, 'workspace-bulk', fx.projectB, many);
      writeComposerWorkspaceSummary(fx, 'workspace-a', fx.projectA, [
        {
          id: shared,
          title: 'Shared with bulk',
          workspacePath: fx.projectA,
          createdAt: 1_700_000_000_000,
          messages: [],
        },
      ]);
      process.env['CURSOR_STORE_ROOT'] = fx.storeRoot;
      const collector = createProfileCollector();
      const rows = await listSessionSummaries({
        dataPath: fx.workspaceStorage,
        workspace: fx.projectA,
        includeCrossWorkspaceSources: true,
        diagnostics: collector,
      });
      const summary = collector.toJSON();
      const jsonEach = summary.queries
        .filter(({ sqlShape }) => /json_each/u.test(sqlShape))
        .reduce((total, q) => total + q.count - (q.ops['prepare'] ?? 0), 0);
      // 600 IDs at 256 per page: three UUID pages plus the contributor
      // hydration reads; never one statement per ID.
      expect(jsonEach).toBeLessThan(12);
      const row = rows.data.find(({ id }) => id === shared);
      expect(row).toBeDefined();
      // The shared UUID sits at index 590 of the off-scope workspace, beyond
      // the first 256-row page; finding it yields a second divergent occurrence.
      expect(row).toMatchObject({ resolutionState: 'ambiguous', occurrenceCount: 2 });
    } finally {
      process.env['CURSOR_STORE_ROOT'] = corpus.fx.storeRoot;
      fx.cleanup();
    }
  });
});

describe('R2 Source Read Limits accounting', () => {
  const limits = (sqliteRowCount: number) => ({ sqlitePageRows: 1, sqliteRowCount });

  it('still enforces the row bound when the reduced reads exceed it', async () => {
    await expect(
      listSessionSummaries({
        dataPath: corpus.fx.workspaceStorage,
        sourceReadLimits: limits(10),
      })
    ).rejects.toMatchObject({ code: 'SOURCE_LIMIT_EXCEEDED' });
  });

  it('admits a request the duplicated reads used to reject', async () => {
    // Measured on this corpus: the unshared implementation needed a row budget
    // of 84 (phase B charged both bubble-key walks plus the bubble payload
    // reads it used for summaries); the shared scans need 27. Any budget in
    // between used to fail only because the same rows were charged twice.
    const rows = await listSessionSummaries({
      dataPath: corpus.fx.workspaceStorage,
      sourceReadLimits: limits(40),
    });
    expect(rows.data.length).toBeGreaterThan(0);
  });
});
