import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getSession,
  listSessionSummaries,
  listSessions,
  searchSessions,
  type LibraryConfig,
} from '../../src/lib/index.js';
import { R2_IDS, buildR2Corpus, normalizeForGolden, type R2Corpus } from '../helpers/r2-corpus.js';

/**
 * R2 equivalence proof. Goldens under tests/fixtures/r2-golden/ were captured
 * from the UNMODIFIED discovery code (set R2_UPDATE_GOLDEN=1 to regenerate);
 * the same corpus is rebuilt on every run and every public read must match.
 */
const GOLDEN_DIR = join(process.cwd(), 'tests', 'fixtures', 'r2-golden');
const UPDATE = process.env['R2_UPDATE_GOLDEN'] === '1';
const previousStoreRoot = process.env['CURSOR_STORE_ROOT'];

let corpus: R2Corpus;

beforeAll(async () => {
  corpus = await buildR2Corpus();
  process.env['CURSOR_STORE_ROOT'] = corpus.fx.storeRoot;
});

afterAll(() => {
  if (previousStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = previousStoreRoot;
  corpus?.fx.cleanup();
});

async function capture<T>(run: () => Promise<T>): Promise<unknown> {
  try {
    return { ok: await run() };
  } catch (error) {
    const err = error as { name?: string; code?: string };
    return { error: { name: err.name, code: err.code } };
  }
}

async function readAll(config: LibraryConfig): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  out['summaries'] = await capture(() => listSessionSummaries(config));
  out['sessions'] = await capture(() => listSessions(config));
  for (const query of ['needle', 'reply']) {
    out[`search:${query}`] = await capture(() => searchSessions(query, config));
  }
  const summaries = (out['summaries'] as { ok?: { data: Array<{ id: string }> } }).ok;
  const ids = [...new Set((summaries?.data ?? []).map(({ id }) => id))].sort();
  for (const id of ids) {
    out[`get:${id}`] = await capture(() => getSession(id, config));
  }
  return out;
}

function scenarios(): Record<string, LibraryConfig> {
  const dataPath = corpus.fx.workspaceStorage;
  return {
    global: { dataPath },
    'ws-a': { dataPath, workspace: corpus.fx.projectA },
    'ws-b': { dataPath, workspace: corpus.fx.projectB },
    'ws-c': { dataPath, workspace: corpus.projectC },
    'ws-a-cross': { dataPath, workspace: corpus.fx.projectA, includeCrossWorkspaceSources: true },
    'ws-c-cross': { dataPath, workspace: corpus.projectC, includeCrossWorkspaceSources: true },
    'ws-missing': { dataPath, workspace: join(corpus.fx.root, 'nope') },
    'backup-global': { dataPath, backupPath: corpus.backupPath },
    'backup-ws-a': { dataPath, backupPath: corpus.backupPath, workspace: corpus.fx.projectA },
    'backup-ws-a-cross': {
      dataPath,
      backupPath: corpus.backupPath,
      workspace: corpus.fx.projectA,
      includeCrossWorkspaceSources: true,
    },
  };
}

describe('R2 discovery equivalence against pre-change goldens', () => {
  const names = [
    'global',
    'ws-a',
    'ws-b',
    'ws-c',
    'ws-a-cross',
    'ws-c-cross',
    'ws-missing',
    'backup-global',
    'backup-ws-a',
    'backup-ws-a-cross',
  ];
  for (const name of names) {
    it(`scenario ${name} is byte-identical`, async () => {
      const actual = normalizeForGolden(await readAll(scenarios()[name]!), corpus.fx.root);
      const goldenPath = join(GOLDEN_DIR, `${name}.json`);
      const text = `${JSON.stringify(actual, null, 2)}\n`;
      if (UPDATE) {
        mkdirSync(GOLDEN_DIR, { recursive: true });
        writeFileSync(goldenPath, text, 'utf8');
        return;
      }
      expect(existsSync(goldenPath)).toBe(true);
      expect(text).toBe(readFileSync(goldenPath, 'utf8').replaceAll('\r\n', '\n'));
    }, 60_000);
  }

  it('golden corpus actually exercises the interesting shapes', () => {
    const global = JSON.parse(readFileSync(join(GOLDEN_DIR, 'global.json'), 'utf8')) as {
      summaries: { ok: { data: Array<{ id: string }> } };
    };
    const ids = new Set(global.summaries.ok.data.map(({ id }) => id));
    for (const id of [
      R2_IDS.noTimestamps,
      R2_IDS.pointerLinked,
      R2_IDS.selectedLinked,
      R2_IDS.globalStamped,
      R2_IDS.globalUnstamped,
    ]) {
      expect(ids.has(id)).toBe(true);
    }
    expect(ids.has(R2_IDS.noBubbles)).toBe(false);
  });
});
