/**
 * Shared helpers for the real-module / real-worker catalog e2e tests.
 *
 * These tests import the BUILT library (dist) because the catalog worker is a
 * compiled `catalog-worker.js`. `npm test` builds first (pretest).
 */
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import * as lib from '../../dist/lib/index.js';
import * as refreshMod from '../../dist/core/catalog/refresh.js';

export const dist = lib;
export const SLOW_DEPS_MODULE = join(
  process.cwd(),
  'tests',
  'helpers',
  'catalog-workers',
  'slow-real-deps.mjs'
);
export const BUILD_CHILD_SCRIPT = join(
  process.cwd(),
  'tests',
  'helpers',
  'catalog-workers',
  'build-child.mjs'
);

export type Config = Record<string, unknown>;

/** Temp dir for sidecars; always outside any fixture and Cursor dir. */
export function makeSidecarDir(): { dir: string; catalogPath: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'ch-catalog-e2e-sidecar-'));
  return {
    dir,
    catalogPath: join(dir, 'catalog.sqlite'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function setMtime(path: string, secondsAgo: number): void {
  const t = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(path, t, t);
}

function walk(root: string, visit: (p: string, isDir: boolean) => void): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name);
    visit(p, entry.isDirectory());
    if (entry.isDirectory()) walk(p, visit);
  }
}

/** Age every file and dir under root so the fingerprint is "settled" (>2 s old). */
export function backdateTree(root: string, secondsAgo = 3600): void {
  walk(root, (p) => setMtime(p, secondsAgo));
}

/** sha256 of every file under root, keyed by relative path (read-only check). */
export function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  walk(root, (p, isDir) => {
    if (!isDir) {
      out[relative(root, p).replaceAll('\\', '/')] = createHash('sha256')
        .update(readFileSync(p))
        .digest('hex');
    }
  });
  return out;
}

/** size+mtime of every file (to prove sources are not even touched). */
export function statTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  walk(root, (p, isDir) => {
    if (!isDir) {
      const st = statSync(p, { bigint: true });
      out[relative(root, p).replaceAll('\\', '/')] = `${st.size}:${st.mtimeNs}`;
    }
  });
  return out;
}

export interface Read {
  result: Awaited<ReturnType<typeof lib.listSessionSummaries>>;
  diagnostics: string[];
}

/** One read with onDiagnostic captured (sorted JSON strings = multiset). */
export async function read(config: Config): Promise<Read> {
  const diagnostics: string[] = [];
  const result = await lib.listSessionSummaries({
    ...config,
    onDiagnostic: (d: unknown) => diagnostics.push(JSON.stringify(d)),
  } as never);
  return { result, diagnostics: diagnostics.sort() };
}

/** The part of a result that must be identical between catalog and direct reads. */
export function comparable(r: Read): unknown {
  return {
    data: r.result.data,
    pagination: r.result.pagination,
    scope: (r.result as { scope?: unknown }).scope ?? null,
    diagnostics: r.diagnostics,
  };
}

export function catalogOf(r: Read): { state: string; complete: boolean; [k: string]: unknown } {
  return (r.result as unknown as { catalog: never }).catalog;
}

/** Forget the per-scope 10 s rate limit so a test can refresh again immediately. */
export function resetRefreshLimits(): void {
  refreshMod.resetCatalogRefreshState();
}

/** Run a build to completion through the public API and report success. */
export async function buildAndWait(config: Config, timeoutMs = 60_000): Promise<boolean> {
  resetRefreshLimits();
  await lib.refreshCatalog(config as never);
  return lib.waitForCatalog(config as never, timeoutMs);
}

/** Add a workspace dir (workspace.json + empty composer list) with no sessions. */
export function addEmptyWorkspace(workspaceStorage: string, name: string, folder: string): string {
  const dir = join(workspaceStorage, name);
  mkdirSync(folder, { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'workspace.json'),
    JSON.stringify({ folder: pathToFileURL(folder).href })
  );
  const db = new BetterSqlite3(join(dir, 'state.vscdb'));
  try {
    db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(
      'composer.composerData',
      JSON.stringify({ allComposers: [], selectedComposerIds: [] })
    );
  } finally {
    db.close();
  }
  return dir;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
