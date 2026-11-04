import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SESSION_INTEGRITY_IDS,
  createFixtureBackup,
  createSessionIntegrityFixtureRoot,
  seedConflictingWorkspaceCorpus,
  writeComposerGlobalSessions,
  writeComposerWorkspaceSummary,
  writeStoreDb,
  type SessionIntegrityFixtureRoot,
} from './session-integrity-fixtures.js';

/** Fixed identifiers so goldens are byte-stable across runs. */
export const R2_IDS = Object.freeze({
  noTimestamps: '11111111-0000-0000-0000-0000000000a1',
  workspaceOnly: '11111111-0000-0000-0000-0000000000a2',
  pointerLinked: '11111111-0000-0000-0000-0000000000a3',
  selectedLinked: '11111111-0000-0000-0000-0000000000a4',
  globalStamped: '11111111-0000-0000-0000-0000000000a5',
  globalUnstamped: '11111111-0000-0000-0000-0000000000a6',
  caseLower: 'abcdef00-0000-0000-0000-0000000000b1',
  caseUpper: 'ABCDEF00-0000-0000-0000-0000000000B1',
  noBubbles: '11111111-0000-0000-0000-0000000000a7',
  storeComplement: '11111111-0000-0000-0000-0000000000a8',
});

export interface R2Corpus {
  fx: SessionIntegrityFixtureRoot;
  projectC: string;
  backupPath: string;
}

function bubble(type: 1 | 2, text: string, createdAt?: number): string {
  return JSON.stringify({ type, text, ...(createdAt === undefined ? {} : { createdAt }) });
}

/**
 * Richest synthetic corpus the existing fixtures support: the conflicting
 * workspace corpus plus timestamp-less global composers, pointer and
 * selectedComposerIds links, unstamped global-only composers, case-variant
 * spellings, a composer without bubbles, a Store complement and a backup.
 */
export async function buildR2Corpus(prefix = 'r2-corpus-'): Promise<R2Corpus> {
  const fx = createSessionIntegrityFixtureRoot(prefix);
  const projectC = join(fx.root, 'workspaces', 'c');
  mkdirSync(projectC, { recursive: true });
  seedConflictingWorkspaceCorpus(fx);

  // Workspace A also lists composers whose global records are missing or timestamp-less.
  writeComposerWorkspaceSummary(fx, 'workspace-a', fx.projectA, [
    {
      id: SESSION_INTEGRITY_IDS.workspaceA,
      title: 'Workspace A older session',
      workspacePath: fx.projectA,
      createdAt: 1_700_000_000_000,
      messages: [],
    },
    {
      id: R2_IDS.noTimestamps,
      title: 'No timestamp composer',
      workspacePath: fx.projectA,
      createdAt: 1_710_000_000_000,
      messages: [],
    },
    {
      id: R2_IDS.workspaceOnly,
      title: 'Workspace only composer',
      workspacePath: fx.projectA,
      createdAt: 1_720_000_000_000,
      messages: [],
    },
  ]);

  // Workspace C: no allComposers, links via selectedComposerIds and a pointer key.
  const wsC = join(fx.workspaceStorage, 'workspace-c');
  mkdirSync(wsC, { recursive: true });
  writeFileSync(
    join(wsC, 'workspace.json'),
    JSON.stringify({ folder: pathToFileURL(projectC).href })
  );
  const wsCDb = new BetterSqlite3(join(wsC, 'state.vscdb'));
  try {
    wsCDb.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const put = wsCDb.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
    put.run(
      'composer.composerData',
      JSON.stringify({ allComposers: [], selectedComposerIds: [R2_IDS.selectedLinked] })
    );
    put.run(
      `workbench.panel.composerChatViewPane.${R2_IDS.pointerLinked}`,
      JSON.stringify({ visible: true })
    );
  } finally {
    wsCDb.close();
  }

  // Extra global composers, written with raw rows for precise control.
  writeComposerGlobalSessions(fx, [
    {
      id: R2_IDS.pointerLinked,
      title: 'Pointer linked',
      workspacePath: projectC,
      createdAt: 1_730_000_000_000,
      messages: [
        { id: 'p1', role: 'user', content: 'needle-pointer', createdAt: 1_730_000_000_000 },
      ],
    },
  ]);
  const globalDb = new BetterSqlite3(join(fx.globalStorage, 'state.vscdb'));
  try {
    const put = globalDb.prepare('INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)');
    // Timestamp-less composer: extrema must come from bubble timestamps.
    put.run(
      `composerData:${R2_IDS.noTimestamps}`,
      JSON.stringify({
        name: 'Global no timestamps',
        workspaceIdentifier: { uri: { fsPath: fx.projectA } },
      })
    );
    put.run(`bubbleId:${R2_IDS.noTimestamps}:b1`, bubble(1, 'needle-first', 1_711_000_000_000));
    put.run(`bubbleId:${R2_IDS.noTimestamps}:b2`, bubble(2, 'reply', 1_713_000_000_000));
    put.run(`bubbleId:${R2_IDS.noTimestamps}:b3`, bubble(2, 'untimed reply'));
    put.run(`bubbleId:${R2_IDS.noTimestamps}:b4`, bubble(1, 'earlier', 1_709_000_000_000));
    // Selected-id link, unstamped record.
    put.run(
      `composerData:${R2_IDS.selectedLinked}`,
      JSON.stringify({
        name: 'Selected linked',
        createdAt: 1_740_000_000_000,
        lastUpdatedAt: 1_740_000_001_000,
      })
    );
    put.run(
      `bubbleId:${R2_IDS.selectedLinked}:s1`,
      bubble(1, 'needle-selected', 1_740_000_000_000)
    );
    // Stamped global-only (membership through workspaceIdentifier).
    put.run(
      `composerData:${R2_IDS.globalStamped}`,
      JSON.stringify({
        name: 'Global stamped B',
        createdAt: 1_750_000_000_000,
        workspaceIdentifier: { uri: { fsPath: fx.projectB } },
      })
    );
    put.run(`bubbleId:${R2_IDS.globalStamped}:g1`, bubble(1, 'needle-stamped', 1_750_000_000_000));
    // Unstamped global-only (catch-all).
    put.run(
      `composerData:${R2_IDS.globalUnstamped}`,
      JSON.stringify({ title: 'Global unstamped' })
    );
    put.run(
      `bubbleId:${R2_IDS.globalUnstamped}:u1`,
      bubble(1, 'needle-unstamped', 1_760_000_000_000)
    );
    put.run(`bubbleId:${R2_IDS.globalUnstamped}:u2`, bubble(2, 'answer', 1_760_000_005_000));
    // Case-variant spellings with distinct payloads.
    put.run(
      `composerData:${R2_IDS.caseLower}`,
      JSON.stringify({ name: 'Lower spelling', createdAt: 1_770_000_000_000 })
    );
    put.run(
      `composerData:${R2_IDS.caseUpper}`,
      JSON.stringify({ name: 'Upper spelling', createdAt: 1_770_000_100_000 })
    );
    put.run(`bubbleId:${R2_IDS.caseLower}:l1`, bubble(1, 'needle-lower', 1_770_000_000_000));
    put.run(`bubbleId:${R2_IDS.caseUpper}:u1`, bubble(1, 'needle-upper', 1_770_000_100_000));
    // Composer record without any bubble must not surface.
    put.run(
      `composerData:${R2_IDS.noBubbles}`,
      JSON.stringify({ name: 'Empty', createdAt: 1_780_000_000_000 })
    );
    // Store complement of a global-only composer.
    put.run(
      `composerData:${R2_IDS.storeComplement}`,
      JSON.stringify({ name: 'Store complement global', createdAt: 1_790_000_000_000 })
    );
    put.run(
      `bubbleId:${R2_IDS.storeComplement}:c1`,
      bubble(1, 'needle-complement', 1_790_000_000_000)
    );
    // Malformed composer JSON and an orphan bubble spelling.
    put.run('composerData:not-json', '{not json');
    put.run('bubbleId:orphan-spelling:o1', bubble(1, 'orphan', 1_795_000_000_000));
  } finally {
    globalDb.close();
  }

  writeStoreDb(fx, SESSION_INTEGRITY_IDS.storeOnly, [
    { role: 'user', content: 'needle-store' },
    { role: 'assistant', content: 'store answer' },
  ]);
  writeStoreDb(fx, R2_IDS.storeComplement, [
    { role: 'user', content: 'needle-complement' },
    { role: 'assistant', content: 'store complement answer' },
  ]);

  const backupPath = await createFixtureBackup(fx, 'r2-backup.zip');
  return { fx, projectC, backupPath };
}

/** Replace the temp-root prefix of every string so goldens do not depend on the machine. */
export function normalizeForGolden(value: unknown, root: string): unknown {
  const unique = basename(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^.*?${unique}`, 'i');
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      return node.replaceAll('\\', '/').replace(pattern, '<ROOT>');
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map(([k, v]) => [
          walk(k) as string,
          walk(v),
        ])
      );
    }
    return node;
  };
  return walk(JSON.parse(JSON.stringify(value ?? null)));
}
