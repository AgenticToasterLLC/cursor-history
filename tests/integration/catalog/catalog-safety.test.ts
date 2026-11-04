/**
 * Catalog safety: the sidecar catalog must never modify, rename or delete a file that is not
 * positively identified as a cursor-history catalog, and never lives inside Cursor's data.
 *
 * Everything runs in a temp tree; APPDATA/LOCALAPPDATA/USERPROFILE/HOME are redirected into it,
 * so default-path logic can never see the real Cursor directories.
 */
import BetterSqlite3 from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  listSessionSummaries,
  refreshCatalog,
  cancelCatalogRefreshes,
} from '../../../src/lib/index.js';
import {
  CATALOG_PROJECTION_EPOCH,
  CATALOG_SCHEMA_VERSION,
} from '../../../src/core/catalog/contract.js';
import { CatalogUnavailableError } from '../../../src/core/catalog/errors.js';
import { createCatalogLock } from '../../../src/core/catalog/lock.js';
import { defaultCatalogPath } from '../../../src/core/catalog/paths.js';
import { CATALOG_APPLICATION_ID } from '../../../src/core/catalog/identity.js';
import { ensureCatalogDriver, openCatalogStore } from '../../../src/core/catalog/store.js';
import { platformDefaultUserDir } from '../../helpers/live-tree.js';
import { ProtectedPathError } from '../../../src/core/write-guard.js';

const ENV_KEYS = [
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'HOME',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'CURSOR_DATA_PATH',
  'CURSOR_STORE_ROOT',
  'CURSOR_HISTORY_INDEX_PATH',
] as const;
const savedEnv: Record<string, string | undefined> = {};

let root: string;
let globalStorage: string;
let workspaceStorage: string;
let globalDb: string;
let workspaceDb: string;
let liveConn: BetterSqlite3.Database;
let liveWorkspaceConn: BetterSqlite3.Database;

interface Target {
  name: string;
  path: string;
  /** Whether the shared write guard (not just identity) refuses it. */
  protectedPath: boolean;
}
let targets: Target[];

function cursorLikeDb(path: string, wal: boolean): BetterSqlite3.Database {
  const db = new BetterSqlite3(path);
  if (wal) db.pragma('journal_mode = WAL');
  db.exec(
    'CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);' +
      'CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);'
  );
  const ins = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
  for (let i = 0; i < 20; i += 1) ins.run(`composerData:${i}`, JSON.stringify({ i }));
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('k', 'v');
  return db;
}

interface FileState {
  sha256: string;
  size: number;
  mtimeMs: number;
}
function fileState(path: string): FileState | null {
  if (!existsSync(path)) return null;
  const st = statSync(path);
  return {
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
}
function snapshot(path: string): Record<string, FileState | null> {
  return {
    main: fileState(path),
    wal: fileState(`${path}-wal`),
    shm: fileState(`${path}-shm`),
  };
}
/** Like snapshot() but without -shm: a direct read of a live WAL db may touch the shm mapping. */
function snapshotNoShm(path: string): Record<string, FileState | null> {
  const { main, wal } = snapshot(path);
  return { main, wal };
}
function listing(dir: string): string[] {
  return readdirSync(dir).sort();
}

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  root = mkdtempSync(join(tmpdir(), 'catalog-safety-'));
  const appData = join(root, 'AppData', 'Roaming');
  const home = join(root, 'home');
  mkdirSync(join(root, 'AppData', 'Local'), { recursive: true });
  mkdirSync(home, { recursive: true });
  process.env['APPDATA'] = appData;
  process.env['LOCALAPPDATA'] = join(root, 'AppData', 'Local');
  process.env['USERPROFILE'] = home;
  process.env['HOME'] = home;
  process.env['XDG_CACHE_HOME'] = join(home, '.cache');
  delete process.env['XDG_CONFIG_HOME'];
  delete process.env['CURSOR_DATA_PATH'];
  delete process.env['CURSOR_STORE_ROOT'];
  delete process.env['CURSOR_HISTORY_INDEX_PATH'];

  // The fake live tree must sit where the product resolves the platform default (per OS).
  const user = platformDefaultUserDir();
  globalStorage = join(user, 'globalStorage');
  workspaceStorage = join(user, 'workspaceStorage');
  mkdirSync(globalStorage, { recursive: true });
  mkdirSync(join(workspaceStorage, 'x'), { recursive: true });
  globalDb = join(globalStorage, 'state.vscdb');
  workspaceDb = join(workspaceStorage, 'x', 'state.vscdb');
  // Held open so a non-empty -wal / -shm stays on disk like a running Cursor's.
  liveConn = cursorLikeDb(globalDb, true);
  liveWorkspaceConn = cursorLikeDb(workspaceDb, true);
  expect(existsSync(`${globalDb}-wal`)).toBe(true);

  const other = join(root, 'other');
  mkdirSync(other, { recursive: true });
  const appDb = join(other, 'app.db');
  const app = new BetterSqlite3(appDb);
  app.exec(
    "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users VALUES (1, 'a');"
  );
  app.close();
  const textFile = join(other, 'notes.txt');
  writeFileSync(textFile, 'just some text that is not a database\n'.repeat(200));
  const zipFile = join(other, 'archive.zip');
  writeFileSync(
    zipFile,
    Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(2000, 7)])
  );
  // A zero-byte file at a custom name.
  const emptyFile = join(other, 'empty.sqlite');
  writeFileSync(emptyFile, '');

  targets = [
    { name: 'fake global state.vscdb', path: globalDb, protectedPath: true },
    { name: 'fake workspace state.vscdb', path: workspaceDb, protectedPath: true },
    { name: 'other user sqlite db', path: appDb, protectedPath: false },
    { name: 'random text file', path: textFile, protectedPath: false },
    { name: 'zip file', path: zipFile, protectedPath: false },
    { name: 'zero-byte file at a custom name', path: emptyFile, protectedPath: false },
  ];
  await ensureCatalogDriver();
});

afterAll(async () => {
  try {
    await cancelCatalogRefreshes();
  } catch {
    // ignore
  }
  try {
    liveConn?.close();
    liveWorkspaceConn?.close();
  } catch {
    // ignore
  }
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  // Remove junctions first so the recursive delete can never follow them.
  for (const link of ['link-to-global', 'link-to-workspaces']) {
    try {
      rmdirSync(join(root, link));
    } catch {
      // absent
    }
  }
  rmSync(root, { recursive: true, force: true });
});

/** Run `fn`, assert it was refused, and prove nothing around `path` changed. */
function expectUntouched(path: string, fn: () => unknown): void {
  const dir = join(path, '..');
  const before = snapshot(path);
  const names = listing(dir);
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeDefined();
  expect(thrown instanceof ProtectedPathError || thrown instanceof CatalogUnavailableError).toBe(
    true
  );
  expect(snapshot(path)).toEqual(before);
  expect(listing(dir)).toEqual(names);
  expect(listing(dir).some((n) => n.includes('.corrupt-'))).toBe(false);
}

describe('explicit catalogPath is refused and nothing is touched', () => {
  it('openCatalogStore refuses every foreign target', () => {
    for (const target of targets) {
      expectUntouched(target.path, () => openCatalogStore({ path: target.path }));
    }
  });

  it('reports content-free reasons', () => {
    for (const target of targets) {
      try {
        openCatalogStore({ path: target.path });
        expect.unreachable();
      } catch (error) {
        if (target.protectedPath) {
          expect((error as ProtectedPathError).code).toBe('PROTECTED_PATH');
        } else {
          expect((error as CatalogUnavailableError).code).toBe('CATALOG_UNAVAILABLE');
          expect((error as CatalogUnavailableError).reason).toBe('NOT_A_CATALOG');
        }
        expect((error as Error).message).not.toContain(root);
      }
    }
  });

  it('createCatalogLock refuses and creates no .locks directory', () => {
    for (const target of targets) {
      expect(() => createCatalogLock(target.path)).toThrow();
      expect(existsSync(`${target.path}.locks`)).toBe(false);
    }
  });
});

describe('CURSOR_HISTORY_INDEX_PATH is refused and nothing is touched', () => {
  it('defaultCatalogPath/openCatalogStore refuse every foreign target', () => {
    try {
      for (const target of targets) {
        process.env['CURSOR_HISTORY_INDEX_PATH'] = target.path;
        if (target.protectedPath) {
          expectUntouched(target.path, () => defaultCatalogPath());
        }
        expectUntouched(target.path, () => openCatalogStore());
      }
    } finally {
      delete process.env['CURSOR_HISTORY_INDEX_PATH'];
    }
  });
});

describe('the read path degrades instead of failing', () => {
  it('serves a direct read with state degraded for explicit catalogPath', async () => {
    for (const target of targets) {
      const before = snapshotNoShm(target.path);
      for (const catalog of ['auto', 'strict'] as const) {
        const result = await listSessionSummaries({
          dataPath: workspaceStorage,
          catalog,
          catalogPath: target.path,
        });
        expect(result.catalog?.state).toBe('degraded');
        expect(result.catalog?.reason).toBe(
          target.protectedPath ? 'PROTECTED_PATH' : 'NOT_A_CATALOG'
        );
      }
      expect(snapshotNoShm(target.path)).toEqual(before);
      expect(existsSync(`${target.path}.locks`)).toBe(false);
    }
  }, 60_000);

  it('degrades for CURSOR_HISTORY_INDEX_PATH', async () => {
    try {
      for (const target of targets) {
        process.env['CURSOR_HISTORY_INDEX_PATH'] = target.path;
        const before = snapshotNoShm(target.path);
        const result = await listSessionSummaries({ dataPath: workspaceStorage, catalog: 'auto' });
        expect(result.catalog?.state).toBe('degraded');
        expect(['PROTECTED_PATH', 'NOT_A_CATALOG']).toContain(result.catalog?.reason);
        expect(snapshotNoShm(target.path)).toEqual(before);
      }
    } finally {
      delete process.env['CURSOR_HISTORY_INDEX_PATH'];
    }
  }, 60_000);

  it('refreshCatalog throws a typed error for protected paths and leaves others untouched', async () => {
    for (const target of targets) {
      const before = snapshotNoShm(target.path);
      if (target.protectedPath) {
        await expect(
          refreshCatalog({ dataPath: workspaceStorage, catalog: 'auto', catalogPath: target.path })
        ).rejects.toMatchObject({ name: 'InvalidConfigError' });
      } else {
        await refreshCatalog({
          dataPath: workspaceStorage,
          catalog: 'auto',
          catalogPath: target.path,
        }).catch(() => undefined);
        await cancelCatalogRefreshes();
        await new Promise((done) => setTimeout(done, 300));
      }
      expect(snapshotNoShm(target.path)).toEqual(before);
      expect(existsSync(`${target.path}.locks`)).toBe(false);
    }
  }, 60_000);
});

describe('junction / symlink into the fake Cursor directory', () => {
  it('refuses a path that resolves into globalStorage and creates nothing there', () => {
    const link = join(root, 'link-to-global');
    symlinkSync(globalStorage, link, 'junction');
    const before = listing(globalStorage);
    const viaLink = join(link, 'sidecar.sqlite');
    expect(() => openCatalogStore({ path: viaLink })).toThrow(ProtectedPathError);
    process.env['CURSOR_HISTORY_INDEX_PATH'] = viaLink;
    try {
      expect(() => defaultCatalogPath()).toThrow(ProtectedPathError);
    } finally {
      delete process.env['CURSOR_HISTORY_INDEX_PATH'];
    }
    expect(() => createCatalogLock(viaLink)).toThrow(ProtectedPathError);
    expect(listing(globalStorage)).toEqual(before);
    expect(existsSync(join(globalStorage, 'sidecar.sqlite'))).toBe(false);
  });

  it('refuses a junction into workspaceStorage as well', () => {
    const link = join(root, 'link-to-workspaces');
    symlinkSync(workspaceStorage, link, 'junction');
    const before = listing(workspaceStorage);
    expect(() => openCatalogStore({ path: join(link, 'x', 'c.sqlite') })).toThrow(
      ProtectedPathError
    );
    expect(listing(workspaceStorage)).toEqual(before);
  });
});

describe('genuine catalogs are still recovered', () => {
  function newDir(): string {
    return mkdtempSync(join(root, 'ok-'));
  }

  it('writes the application id and marker on creation', () => {
    const path = join(newDir(), 'mine.sqlite');
    openCatalogStore({ path }).close();
    const header = readFileSync(path).subarray(0, 100);
    expect(header.readUInt32BE(68)).toBe(CATALOG_APPLICATION_ID);
    const db = new BetterSqlite3(path, { readonly: true });
    expect(db.prepare("SELECT value FROM meta WHERE key = 'application'").get()).toEqual({
      value: 'cursor-history-catalog',
    });
    db.close();
  });

  it('resets a genuine catalog with the wrong epoch (and only its own wal/shm)', () => {
    const dir = newDir();
    const path = join(dir, 'mine.sqlite');
    const store = openCatalogStore({ path });
    store.close();
    const db = new BetterSqlite3(path);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'projection_epoch'").run(
      String(CATALOG_PROJECTION_EPOCH + 100)
    );
    db.close();
    const fresh = openCatalogStore({ path });
    fresh.close();
    expect(listing(dir).some((n) => n.startsWith('mine.sqlite.corrupt-'))).toBe(true);
    const reopened = new BetterSqlite3(path, { readonly: true });
    expect(reopened.prepare("SELECT value FROM meta WHERE key = 'projection_epoch'").get()).toEqual(
      { value: String(CATALOG_PROJECTION_EPOCH) }
    );
    expect(reopened.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: String(CATALOG_SCHEMA_VERSION),
    });
    reopened.close();
  });

  it('recovers a genuine catalog whose body is corrupt', () => {
    const dir = newDir();
    const path = join(dir, 'mine.sqlite');
    openCatalogStore({ path }).close();
    for (const suffix of ['-wal', '-shm']) rmSync(path + suffix, { force: true });
    const bytes = readFileSync(path);
    bytes.fill(0xab, 100); // keep the header (application id), destroy everything else
    writeFileSync(path, bytes);
    const store = openCatalogStore({ path });
    store.close();
    expect(listing(dir).some((n) => n.startsWith('mine.sqlite.corrupt-'))).toBe(true);
  });

  it('recovers garbage and zero-byte files only at the default catalog file name', () => {
    const dir = newDir();
    const garbage = join(dir, 'x.sqlite');
    writeFileSync(garbage, 'garbage'.repeat(500));
    expectUntouched(garbage, () => openCatalogStore({ path: garbage }));

    const empty = join(dir, 'y.sqlite');
    writeFileSync(empty, '');
    expectUntouched(empty, () => openCatalogStore({ path: empty }));

    const defaultGarbage = join(dir, `catalog-v${CATALOG_SCHEMA_VERSION}.sqlite`);
    writeFileSync(defaultGarbage, 'garbage'.repeat(500));
    openCatalogStore({ path: defaultGarbage }).close();
    expect(listing(dir).some((n) => n.includes('.corrupt-'))).toBe(true);

    const dir2 = newDir();
    const defaultEmpty = join(dir2, 'catalog-v9.sqlite');
    writeFileSync(defaultEmpty, '');
    openCatalogStore({ path: defaultEmpty }).close();
    expect(readFileSync(defaultEmpty).subarray(0, 100).readUInt32BE(68)).toBe(
      CATALOG_APPLICATION_ID
    );
    expect(listing(dir2).some((n) => n.includes('.corrupt-'))).toBe(false);
  });

  it('refuses a foreign SQLite db even at the default catalog file name', () => {
    const dir = newDir();
    const path = join(dir, 'catalog-v2.sqlite');
    const db = new BetterSqlite3(path);
    db.exec('CREATE TABLE unrelated (a TEXT); INSERT INTO unrelated VALUES (1)');
    db.close();
    expectUntouched(path, () => openCatalogStore({ path }));
  });

  it('never opens a foreign db read-write (journal mode stays as it was)', () => {
    const appDb = targets.find((t) => t.name === 'other user sqlite db')!.path;
    const db = new BetterSqlite3(appDb, { readonly: true });
    expect(db.pragma('journal_mode', { simple: true })).toBe('delete');
    expect(db.pragma('application_id', { simple: true })).toBe(0);
    db.close();
  });
});
