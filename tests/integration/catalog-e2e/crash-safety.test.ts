import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { buildR2Corpus, R2_IDS, type R2Corpus } from '../../helpers/r2-corpus.js';
import {
  BUILD_CHILD_SCRIPT,
  SLOW_DEPS_MODULE,
  backdateTree,
  buildAndWait,
  catalogOf,
  comparable,
  dist,
  makeSidecarDir,
  read,
  resetRefreshLimits,
  setMtime,
  sleep,
  type Config,
} from '../../helpers/catalog-e2e.js';

const distUrl = (p: string) => pathToFileURL(join(process.cwd(), 'dist', p)).href;
const readMod = (await import(distUrl('core/catalog/read.js'))) as {
  resolveCatalogScope: (config: unknown, deps: unknown) => { digest: string; scopeKey: unknown };
};
const depsMod = (await import(distUrl('core/catalog/catalog-deps.js'))) as {
  getCatalogDeps: () => Promise<unknown>;
};
const refreshMod = (await import(distUrl('core/catalog/refresh.js'))) as {
  requestCatalogRefresh: (
    request: unknown,
    options?: unknown
  ) => { jobId: string; alreadyRunning: boolean };
  cancelCatalogRefreshes: () => Promise<void>;
  isCatalogRefreshRunning: (digest: string) => boolean;
  getCatalogRefreshLastError: (digest: string) => { code: string } | undefined;
  waitForCatalogBuild: (digest: string, ms: number) => Promise<{ type: string } | undefined>;
};

const previousStoreRoot = process.env['CURSOR_STORE_ROOT'];
const previousDelay = process.env['CH_E2E_BUILD_DELAY_MS'];
let corpus: R2Corpus;
let sidecar: ReturnType<typeof makeSidecarDir>;
let cfg: Config;
const children: ChildProcess[] = [];

beforeEach(async () => {
  corpus = await buildR2Corpus('ch-c4-crash-');
  process.env['CURSOR_STORE_ROOT'] = corpus.fx.storeRoot;
  backdateTree(corpus.fx.root);
  sidecar = makeSidecarDir();
  cfg = { dataPath: corpus.fx.workspaceStorage, catalogPath: sidecar.catalogPath };
});

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await refreshMod.cancelCatalogRefreshes();
  if (previousStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
  else process.env['CURSOR_STORE_ROOT'] = previousStoreRoot;
  if (previousDelay === undefined) delete process.env['CH_E2E_BUILD_DELAY_MS'];
  else process.env['CH_E2E_BUILD_DELAY_MS'] = previousDelay;
  corpus.fx.cleanup();
  sidecar.cleanup();
});

async function scopeOf(config: Config) {
  const deps = await depsMod.getCatalogDeps();
  return readMod.resolveCatalogScope(config, deps) as {
    digest: string;
    scopeKey: unknown;
    readConfig: unknown;
    storePath: string;
  };
}

const lockPath = (digest: string) => join(`${sidecar.catalogPath}.locks`, `${digest}.lock`);

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

function rewriteComposer(): void {
  const dbPath = join(corpus.fx.globalStorage, 'state.vscdb');
  const db = new BetterSqlite3(dbPath);
  try {
    const key = `composerData:${R2_IDS.globalStamped}`;
    const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(key) as {
      value: string;
    };
    db.prepare('UPDATE cursorDiskKV SET value = ? WHERE key = ?').run(
      row.value.replace('Global stamped B', 'Global stamped Z'),
      key
    );
  } finally {
    db.close();
  }
  setMtime(dbPath, 500);
}

/** Start a build in a real worker whose build is artificially slow after the fingerprint. */
async function startSlowBuild(config: Config, delayMs = 30_000) {
  process.env['CH_E2E_BUILD_DELAY_MS'] = String(delayMs);
  const scope = await scopeOf(config);
  const handle = refreshMod.requestCatalogRefresh(
    { scopeKey: scope.scopeKey, readConfig: scope.readConfig, storePath: scope.storePath },
    { testDepsModule: SLOW_DEPS_MODULE, force: true }
  );
  expect(handle.alreadyRunning).toBe(false);
  expect(await waitFor(() => existsSync(lockPath(scope.digest)), 10_000)).toBe(true);
  await sleep(1000); // worker is now past module load, sleeping inside the build
  expect(refreshMod.isCatalogRefreshRunning(scope.digest)).toBe(true);
  return scope;
}

describe('crash safety: worker killed mid-build', () => {
  it('previous snapshot stays intact and stale; lock released; next refresh succeeds', async () => {
    expect(await buildAndWait({ ...cfg, catalog: 'auto' })).toBe(true);
    const ready = await read({ ...cfg, catalog: 'auto' });
    expect(catalogOf(ready).state).toBe('ready');
    const statusBefore = await dist.getCatalogStatus(cfg as never);
    const own = statusBefore.scopes[0]!;

    rewriteComposer(); // sources changed -> snapshot is stale and a refresh is wanted
    const scope = await startSlowBuild(cfg);
    await refreshMod.cancelCatalogRefreshes(); // kill the worker mid-build

    expect(refreshMod.isCatalogRefreshRunning(scope.digest)).toBe(false);
    expect(refreshMod.getCatalogRefreshLastError(scope.digest)?.code).toBe('BUILD_CANCELLED');
    expect(existsSync(lockPath(scope.digest))).toBe(false); // lock released

    // Status (does not schedule anything): same snapshot as before the crash, now stale.
    const statusAfter = await dist.getCatalogStatus(cfg as never);
    const after = statusAfter.scopes.find((s) => s.scopeKeyDigest === scope.digest)!;
    expect(after.snapshotBuiltAt).toBe(own.snapshotBuiltAt);
    expect(after.rowCount).toBe(own.rowCount);
    expect(after.state).toBe('stale');

    // Served as stale with the OLD rows; nothing was published by the killed build.
    const stale = await read({ ...cfg, catalog: 'auto' });
    expect(catalogOf(stale)).toMatchObject({ state: 'stale', complete: false });
    expect(catalogOf(stale)['snapshotBuiltAt']).toBe(catalogOf(ready)['snapshotBuiltAt']);
    expect(stale.result.data).toEqual(ready.result.data);

    // Next refresh succeeds and converges on the direct result.
    process.env['CH_E2E_BUILD_DELAY_MS'] = '0';
    expect(await buildAndWait({ ...cfg, catalog: 'auto' })).toBe(true);
    const refreshed = await read({ ...cfg, catalog: 'auto' });
    expect(catalogOf(refreshed)).toMatchObject({ state: 'ready', complete: true });
    expect(comparable(refreshed)).toEqual(comparable(await read({ ...cfg, catalog: 'direct' })));
    expect(JSON.stringify(refreshed.result.data)).toContain('Global stamped Z');
  }, 120_000);

  it('first-ever build killed: no snapshot is published; reads fall back to direct', async () => {
    const scope = await startSlowBuild(cfg);
    await refreshMod.cancelCatalogRefreshes();
    expect(existsSync(lockPath(scope.digest))).toBe(false);

    const status = await dist.getCatalogStatus(cfg as never);
    const row = status.scopes.find((s) => s.scopeKeyDigest === scope.digest);
    expect(row?.rowCount).toBeUndefined();
    expect(row?.snapshotBuiltAt).toBeUndefined();

    const auto = await read({ ...cfg, catalog: 'auto' });
    expect(catalogOf(auto).state).toBe('building'); // no snapshot
    expect(comparable(auto)).toEqual(comparable(await read({ ...cfg, catalog: 'direct' })));

    process.env['CH_E2E_BUILD_DELAY_MS'] = '0';
    expect(await buildAndWait({ ...cfg, catalog: 'auto' })).toBe(true);
    expect(catalogOf(await read({ ...cfg, catalog: 'auto' })).state).toBe('ready');
  }, 120_000);
});

interface ChildMessage {
  type: string;
  result?: { alreadyRunning: boolean; jobId: string };
  response?: string | null;
}

function spawnChild(mode: 'kill' | 'wait', delayMs: number) {
  const child = fork(
    BUILD_CHILD_SCRIPT,
    [JSON.stringify({ config: cfg, delayMs, mode, depsModule: SLOW_DEPS_MODULE })],
    { cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }
  );
  children.push(child);
  const messages: ChildMessage[] = [];
  const waiters: Array<() => void> = [];
  child.on('message', (m: ChildMessage) => {
    messages.push(m);
    for (const w of waiters.splice(0)) w();
  });
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const exitWaiters: Array<() => void> = [];
  child.on('exit', (code, signal) => {
    exited = { code, signal };
    for (const w of exitWaiters.splice(0)) w();
    for (const w of waiters.splice(0)) w();
  });
  return {
    child,
    async message(type: string, ms = 30_000): Promise<ChildMessage> {
      const end = Date.now() + ms;
      for (;;) {
        const found = messages.find((m) => m.type === type);
        if (found) return found;
        if (exited || Date.now() > end) throw new Error(`child never sent ${type}`);
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 200);
        });
      }
    },
    async exit(ms = 30_000) {
      if (exited) return exited;
      await Promise.race([new Promise<void>((r) => exitWaiters.push(r)), sleep(ms)]);
      if (!exited) throw new Error('child did not exit');
      return exited;
    },
  };
}

describe('crash safety: whole process killed mid-build', () => {
  it('stale lock is recovered by the next process; no phantom-complete snapshot', async () => {
    const scope = await scopeOf(cfg);
    const c = spawnChild('kill', 30_000);
    await c.message('ready');
    c.child.send({ type: 'go' });
    const started = await c.message('started');
    expect(started.result?.alreadyRunning).toBe(false);
    const exit = await c.exit();
    expect(exit.code === 0).toBe(false); // killed, not a clean exit

    // The dead process left its lockfile behind and published nothing.
    expect(existsSync(lockPath(scope.digest))).toBe(true);
    const status = await dist.getCatalogStatus(cfg as never);
    const row = status.scopes.find((s) => s.scopeKeyDigest === scope.digest);
    expect(row?.rowCount).toBeUndefined();
    const auto = await read({ ...cfg, catalog: 'auto' });
    expect(['building', 'degraded']).toContain(catalogOf(auto).state);
    expect(catalogOf(auto).complete).toBe(true); // came from the direct reader
    expect(comparable(auto)).toEqual(comparable(await read({ ...cfg, catalog: 'direct' })));
    await refreshMod.cancelCatalogRefreshes();

    // Next process recovers the stale lock (pid dead) and builds.
    resetRefreshLimits();
    const next = await dist.refreshCatalog(cfg as never);
    expect(next.alreadyRunning).toBe(false);
    expect(await dist.waitForCatalog(cfg as never, 60_000)).toBe(true);
    const refreshed = await read({ ...cfg, catalog: 'auto' });
    expect(catalogOf(refreshed)).toMatchObject({ state: 'ready', complete: true });
    expect(comparable(refreshed)).toEqual(comparable(await read({ ...cfg, catalog: 'direct' })));
    expect(existsSync(lockPath(scope.digest))).toBe(false);
  }, 120_000);

  it('previous snapshot survives a killed rebuild and is still served as stale', async () => {
    expect(await buildAndWait({ ...cfg, catalog: 'auto' })).toBe(true);
    const ready = await read({ ...cfg, catalog: 'auto' });
    rewriteComposer();
    const c = spawnChild('kill', 30_000);
    await c.message('ready');
    c.child.send({ type: 'go' });
    await c.message('started');
    await c.exit();
    resetRefreshLimits();
    // Reading must not hang on the orphaned lock, and serves the old snapshot as stale.
    const stale = await read({ ...cfg, catalog: 'auto' });
    expect(catalogOf(stale)).toMatchObject({ state: 'stale', complete: false });
    expect(stale.result.data).toEqual(ready.result.data);
    expect(await dist.waitForCatalog(cfg as never, 60_000)).toBe(true);
    const refreshed = await read({ ...cfg, catalog: 'auto' });
    expect(catalogOf(refreshed)).toMatchObject({ state: 'ready', complete: true });
    expect(comparable(refreshed)).toEqual(comparable(await read({ ...cfg, catalog: 'direct' })));
  }, 120_000);
});

describe('two processes refreshing the same scope', () => {
  it('exactly one build runs; the other gets alreadyRunning; both then read ready', async () => {
    const a = spawnChild('wait', 3000);
    const b = spawnChild('wait', 3000);
    await Promise.all([a.message('ready'), b.message('ready')]);
    a.child.send({ type: 'go' });
    b.child.send({ type: 'go' });
    const [sa, sb] = await Promise.all([a.message('started'), b.message('started')]);
    const flags = [sa.result!.alreadyRunning, sb.result!.alreadyRunning].sort();
    expect(flags).toEqual([false, true]);

    const [da, db] = await Promise.all([a.message('done', 60_000), b.message('done', 60_000)]);
    const responses = [da.response, db.response];
    // The winner observed its worker finish successfully; the loser had nothing to wait for.
    expect(responses).toContain('done');
    await Promise.all([a.exit(), b.exit()]);

    const scope = await scopeOf(cfg);
    expect(existsSync(lockPath(scope.digest))).toBe(false);
    const ready = await read({ ...cfg, catalog: 'auto' });
    expect(catalogOf(ready)).toMatchObject({ state: 'ready', complete: true });
    expect(comparable(ready)).toEqual(comparable(await read({ ...cfg, catalog: 'direct' })));
    // Exactly one snapshot row for the scope.
    const status = await dist.getCatalogStatus(cfg as never);
    expect(status.scopes.filter((s) => s.scopeKeyDigest === scope.digest)).toHaveLength(1);
  }, 120_000);
});
