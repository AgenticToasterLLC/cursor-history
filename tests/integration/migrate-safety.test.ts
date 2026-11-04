import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { registry } from '../../src/core/database/registry.js';
import { migrationSafetyHooks } from '../../src/core/migrate-safety.js';
import { migrateSession, migrateWorkspace } from '../../src/lib/index.js';
import {
  seedConflictingWorkspaceCorpus,
  createSessionIntegrityFixtureRoot,
  SESSION_INTEGRITY_IDS,
  type ComposerFixtureSession,
  writeComposerWorkspaceSummary,
  writeComposerGlobalSessions,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';
import { platformDefaultUserDir } from '../helpers/live-tree.js';
import { runBuiltCli } from '../helpers/run-cli.js';

const fwd = (p: string): string => p.replaceAll(String.fromCharCode(92), '/');
const cleanups: Array<() => void> = [];
const realStatfs = migrationSafetyHooks.statfs;

const LOCK_SCRIPT = [
  "const Database = require('better-sqlite3');",
  'const db = new Database(process.argv[1]);',
  "db.exec('BEGIN IMMEDIATE');",
  "process.stdout.write('locked');",
  'process.stdin.resume();',
  "process.stdin.on('end', () => process.exit(0));",
  'setTimeout(() => process.exit(0), 60000);',
].join('\n');

/** Hold a write lock on `dbPath` from a child process; resolves once the lock is taken. */
async function holdWriteLockInChildProcess(dbPath: string): Promise<{ release: () => void }> {
  const child = spawn(process.execPath, ['-e', LOCK_SCRIPT, dbPath], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const release = (): void => {
    if (child.exitCode === null && !child.killed) child.kill();
  };
  cleanups.push(release);
  await new Promise<void>((resolveReady, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error('lock helper timed out')), 15_000);
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('locked')) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`lock helper exited early: ${stderr}`));
    });
  });
  return { release };
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function newFixture(): SessionIntegrityFixtureRoot {
  const fixture = createSessionIntegrityFixtureRoot('cursor-history-migrate-safety-');
  // Forward-slash project paths agree between workspace.json file URIs and global fsPath values on Windows.
  fixture.projectA = fwd(fixture.projectA);
  fixture.projectB = fwd(fixture.projectB);
  cleanups.push(() => fixture.cleanup());
  vi.stubEnv('CURSOR_STORE_ROOT', fixture.storeRoot);
  return fixture;
}

/**
 * Same corpus as seedConflictingWorkspaceCorpus, but the global rows spell the workspace the way
 * workspace.json file URIs decode on Windows ("/C:/..."), so membership resolves to one workspace
 * there. (Workspace-path spelling on Windows is a known pre-existing mismatch outside this change.)
 */
function seedCorpus(fixture: SessionIntegrityFixtureRoot): void {
  const make = (
    id: string,
    title: string,
    project: string,
    at: number
  ): ComposerFixtureSession => ({
    id,
    title,
    workspacePath: project,
    createdAt: at,
    messages: [{ id: `${id}:message`, role: 'user', content: title, createdAt: at }],
  });
  const a = make(
    SESSION_INTEGRITY_IDS.workspaceA,
    'Workspace A session',
    fixture.projectA,
    1_700_000_000_000
  );
  const b = make(
    SESSION_INTEGRITY_IDS.workspaceB,
    'Workspace B session',
    fixture.projectB,
    1_800_000_000_000
  );
  writeComposerWorkspaceSummary(fixture, 'workspace-a', fixture.projectA, [a]);
  writeComposerWorkspaceSummary(fixture, 'workspace-b', fixture.projectB, [b]);
  writeComposerGlobalSessions(fixture, [
    { ...a, workspacePath: a.workspacePath },
    { ...b, workspacePath: b.workspacePath },
  ]);
}

function addDestination(fixture: SessionIntegrityFixtureRoot): string {
  const destination = fwd(join(fixture.root, 'workspaces', 'destination'));
  mkdirSync(destination, { recursive: true });
  writeComposerWorkspaceSummary(fixture, 'workspace-destination', destination, []);
  return destination;
}

function databaseFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.vscdb')) found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

/** Content hash plus mtime of every database file: proves "no writes at all". */
function fileState(fixture: SessionIntegrityFixtureRoot): string {
  return JSON.stringify(
    databaseFiles(join(fixture.root, 'User')).map((path) => [
      relative(fixture.root, path),
      createHash('sha256').update(readFileSync(path)).digest('hex'),
      statSync(path).mtimeMs,
    ])
  );
}

function allRows(path: string): Array<{ key: string; value: string }> {
  const db = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
  try {
    const table = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ItemTable','cursorDiskKV')"
        )
        .get() as {
        name: string;
      }
    ).name;
    return db.prepare(`SELECT key, value FROM ${table} ORDER BY key`).all() as Array<{
      key: string;
      value: string;
    }>;
  } finally {
    db.close();
  }
}

function rowSnapshot(fixture: SessionIntegrityFixtureRoot): string {
  return JSON.stringify(databaseFiles(join(fixture.root, 'User')).map((p) => [p, allRows(p)]));
}

interface Manifest {
  files: Array<{ path: string; originalPath: string; size: number; sha256: string }>;
}

beforeEach(() => {
  // Each test chooses its own safety directory; never the per-user cache.
  vi.stubEnv('CURSOR_HISTORY_SAFETY_DIR', tempDir('cursor-history-safety-env-'));
  vi.stubEnv('CURSOR_HISTORY_SKIP_RUNNING_CHECK', '1');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  migrationSafetyHooks.statfs = realStatfs;
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      cleanup();
    } catch {
      // Best effort temp cleanup.
    }
  }
});

describe('dry run is strictly read-only', () => {
  it('performs zero read-write opens for migrateSession and migrateWorkspace', async () => {
    const fixture = newFixture();
    seedCorpus(fixture);
    const destination = addDestination(fixture);
    const before = fileState(fixture);
    const rwSpy = vi.spyOn(registry, 'openDatabaseReadWrite');
    const safetyDir = tempDir('cursor-history-safety-');

    const session = await migrateSession({
      sessions: 1,
      destination,
      workspace: fixture.projectA,
      mode: 'move',
      dryRun: true,
      dataPath: fixture.workspaceStorage,
      safetyCopyDir: safetyDir,
    });
    expect(session[0]).toMatchObject({ success: true, dryRun: true });
    expect(session[0]?.safetyCopyEstimateBytes).toBeGreaterThan(0);

    const workspace = await migrateWorkspace({
      source: fixture.projectA,
      destination,
      mode: 'move',
      dryRun: true,
      dataPath: fixture.workspaceStorage,
      safetyCopyDir: safetyDir,
    });
    expect(workspace).toMatchObject({ success: true, dryRun: true, totalSessions: 1 });

    expect(rwSpy).not.toHaveBeenCalled();
    expect(readdirSync(safetyDir)).toEqual([]);
    expect(fileState(fixture)).toBe(before);
  });
});

describe('Cursor running check', () => {
  function holdWal(path: string): BetterSqlite3.Database {
    // A live WAL-mode connection with unmerged pages is what a running Cursor leaves behind.
    const db = new BetterSqlite3(path);
    db.pragma('journal_mode = WAL');
    db.pragma('wal_autocheckpoint = 0');
    db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run('zz.marker', '1');
    cleanups.push(() => {
      if (db.open) db.close();
    });
    return db;
  }

  it('refuses a real migration with no writes, and the dry run reports the blocker', async () => {
    const fixture = newFixture();
    seedCorpus(fixture);
    const destination = addDestination(fixture);
    holdWal(join(fixture.workspaceStorage, 'workspace-a', 'state.vscdb'));
    vi.stubEnv('CURSOR_HISTORY_SKIP_RUNNING_CHECK', '0');
    const before = fileState(fixture);
    const rwSpy = vi.spyOn(registry, 'openDatabaseReadWrite');
    const safetyDir = tempDir('cursor-history-safety-');
    const config = {
      sessions: 1,
      destination,
      workspace: fixture.projectA,
      mode: 'move' as const,
      dataPath: fixture.workspaceStorage,
      safetyCopyDir: safetyDir,
    };

    const preview = await migrateSession({ ...config, dryRun: true });
    expect(preview[0]?.blockers).toEqual([
      expect.objectContaining({
        code: 'CURSOR_RUNNING',
        evidence: expect.arrayContaining(['wal']),
      }),
    ]);

    await expect(migrateSession({ ...config, dryRun: false })).rejects.toMatchObject({
      code: 'CURSOR_RUNNING',
    });
    await expect(
      migrateWorkspace({
        source: fixture.projectA,
        destination,
        mode: 'move',
        dryRun: false,
        dataPath: fixture.workspaceStorage,
        safetyCopyDir: safetyDir,
      })
    ).rejects.toMatchObject({ code: 'CURSOR_RUNNING' });

    expect(rwSpy).not.toHaveBeenCalled();
    expect(readdirSync(safetyDir)).toEqual([]);
    expect(fileState(fixture)).toBe(before);
  });
});

describe('safety copy', () => {
  it('is complete, verified and consistent before the first read-write open', async () => {
    const fixture = newFixture();
    seedCorpus(fixture);
    const destination = addDestination(fixture);
    const originals = databaseFiles(join(fixture.root, 'User')).map(
      (path) => [path, allRows(path)] as const
    );
    const safetyDir = tempDir('cursor-history-safety-');
    let manifestExistedAtFirstWrite: boolean | undefined;
    const realOpen = registry.openDatabaseReadWrite.bind(registry);
    vi.spyOn(registry, 'openDatabaseReadWrite').mockImplementation((...args) => {
      manifestExistedAtFirstWrite ??= readdirSync(safetyDir).some((name) =>
        existsSync(join(safetyDir, name, 'manifest.json'))
      );
      return realOpen(...args);
    });

    const result = await migrateSession({
      sessions: 1,
      destination,
      workspace: fixture.projectA,
      mode: 'move',
      dryRun: false,
      dataPath: fixture.workspaceStorage,
      safetyCopyDir: safetyDir,
    });
    expect(result[0]).toMatchObject({ success: true });
    expect(manifestExistedAtFirstWrite).toBe(true);

    const copy = result[0]!.safetyCopy!;
    expect(copy.directory.startsWith(safetyDir)).toBe(true);
    const manifest = JSON.parse(readFileSync(copy.manifestPath, 'utf8')) as Manifest;
    expect(manifest.files).toHaveLength(3); // source ws, destination ws, global
    expect(manifest.files.map((f) => f.originalPath).sort()).toEqual(
      originals
        .map(([p]) => p)
        .filter((p) => !p.includes('workspace-b'))
        .sort()
    );
    for (const entry of manifest.files) {
      const copied = join(copy.directory, entry.path);
      expect(entry.path.startsWith('/')).toBe(false);
      const bytes = readFileSync(copied);
      expect(bytes.length).toBe(entry.size);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
      const db = new BetterSqlite3(copied, { readonly: true });
      try {
        expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      } finally {
        db.close();
      }
      // The copy holds the PRE-migration content of its original.
      const original = originals.find(([p]) => p === entry.originalPath)!;
      expect(allRows(copied)).toEqual(original[1]);
    }
    // The live databases did change.
    expect(rowSnapshot(fixture)).not.toBe(JSON.stringify(originals.map(([p, r]) => [p, r])));
  });

  it('aborts before any write when the copy fails', async () => {
    const fixture = newFixture();
    seedCorpus(fixture);
    const destination = addDestination(fixture);
    const before = fileState(fixture);
    const rwSpy = vi.spyOn(registry, 'openDatabaseReadWrite');
    vi.spyOn(registry, 'backupDatabase').mockRejectedValue(new Error('simulated copy failure'));

    await expect(
      migrateSession({
        sessions: 1,
        destination,
        workspace: fixture.projectA,
        mode: 'move',
        dryRun: false,
        dataPath: fixture.workspaceStorage,
        safetyCopyDir: tempDir('cursor-history-safety-'),
      })
    ).rejects.toMatchObject({ code: 'MIGRATION_SAFETY_COPY_FAILED' });
    expect(rwSpy).not.toHaveBeenCalled();
    expect(fileState(fixture)).toBe(before);
  });

  it('keeps the copy and compensates when a write fails after the copy', async () => {
    const fixture = newFixture();
    seedCorpus(fixture);
    const destination = addDestination(fixture);
    // Make the global database reject every row mutation so the failure happens mid-migration.
    const globalPath = join(fixture.globalStorage, 'state.vscdb');
    const setup = new BetterSqlite3(globalPath);
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      setup.exec(
        `CREATE TRIGGER block_${event} BEFORE ${event} ON cursorDiskKV BEGIN SELECT RAISE(ABORT, 'injected failure'); END`
      );
    }
    setup.close();
    const rowsBefore = rowSnapshot(fixture);
    const safetyDir = tempDir('cursor-history-safety-');

    const outcome = await migrateSession({
      sessions: 1,
      destination,
      workspace: fixture.projectA,
      mode: 'move',
      dryRun: false,
      dataPath: fixture.workspaceStorage,
      safetyCopyDir: safetyDir,
    }).catch((error: unknown) => error);

    const failed = Array.isArray(outcome)
      ? outcome[0]?.success === false
      : outcome instanceof Error;
    expect(failed).toBe(true);
    expect(rowSnapshot(fixture)).toBe(rowsBefore);
    const kept = readdirSync(safetyDir);
    expect(kept).toHaveLength(1);
    expect(existsSync(join(safetyDir, kept[0]!, 'manifest.json'))).toBe(true);
  });

  it('refuses with a typed error when free disk space is insufficient', async () => {
    const fixture = newFixture();
    seedCorpus(fixture);
    const destination = addDestination(fixture);
    const before = fileState(fixture);
    const rwSpy = vi.spyOn(registry, 'openDatabaseReadWrite');
    migrationSafetyHooks.statfs = () => Promise.resolve({ bavail: 1, bsize: 512 });
    const safetyDir = tempDir('cursor-history-safety-');

    await expect(
      migrateSession({
        sessions: 1,
        destination,
        workspace: fixture.projectA,
        mode: 'move',
        dryRun: false,
        dataPath: fixture.workspaceStorage,
        safetyCopyDir: safetyDir,
      })
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_DISK_SPACE' });
    expect(rwSpy).not.toHaveBeenCalled();
    expect(readdirSync(safetyDir)).toEqual([]);
    expect(fileState(fixture)).toBe(before);
  });

  it('refuses a safety directory inside Cursor data', async () => {
    const fixture = newFixture();
    seedCorpus(fixture);
    const destination = addDestination(fixture);
    const before = fileState(fixture);
    await expect(
      migrateSession({
        sessions: 1,
        destination,
        workspace: fixture.projectA,
        mode: 'move',
        dryRun: false,
        dataPath: fixture.workspaceStorage,
        safetyCopyDir: join(fixture.workspaceStorage, 'safety'),
      })
    ).rejects.toMatchObject({ code: 'PROTECTED_PATH' });
    expect(fileState(fixture)).toBe(before);
  });

  it('defaults to the platform cache directory (redirected to a temp root)', async () => {
    const fixture = newFixture();
    seedCorpus(fixture);
    const destination = addDestination(fixture);
    const home = tempDir('cursor-history-home-');
    vi.stubEnv('CURSOR_HISTORY_SAFETY_DIR', '');
    vi.stubEnv('LOCALAPPDATA', join(home, 'Local'));
    vi.stubEnv('XDG_CACHE_HOME', join(home, 'cache'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);

    const result = await migrateSession({
      sessions: 1,
      destination,
      workspace: fixture.projectA,
      mode: 'move',
      dryRun: false,
      dataPath: fixture.workspaceStorage,
    });
    const directory = result[0]!.safetyCopy!.directory;
    expect(directory.startsWith(home)).toBe(true);
    expect(directory.replace(/\\/gu, '/')).toContain('cursor-history/migrate-safety/');
  });
});

describe('busy databases', () => {
  it('reports a locked database as a typed CURSOR_RUNNING error with no changes', async () => {
    const fixture = newFixture();
    seedCorpus(fixture);
    const destination = addDestination(fixture);
    // POSIX fcntl locks are per-process, so the lock must be held by a separate process.
    const locker = await holdWriteLockInChildProcess(
      join(fixture.workspaceStorage, 'workspace-a', 'state.vscdb')
    );
    cleanups.push(() => locker.release());
    const before = fileState(fixture);

    await expect(
      migrateSession({
        sessions: 1,
        destination,
        workspace: fixture.projectA,
        mode: 'move',
        dryRun: false,
        dataPath: fixture.workspaceStorage,
        safetyCopyDir: tempDir('cursor-history-safety-'),
      })
    ).rejects.toMatchObject({
      code: 'CURSOR_RUNNING',
      message: expect.stringContaining('Close Cursor'),
    });
    locker.release();
    expect(fileState(fixture)).toBe(before);
  }, 30_000);
});

describe('skipSafetyCopy', () => {
  it('is honored for custom data paths', async () => {
    const fixture = newFixture();
    seedCorpus(fixture);
    const destination = addDestination(fixture);
    const safetyDir = tempDir('cursor-history-safety-');
    const result = await migrateSession({
      sessions: 1,
      destination,
      workspace: fixture.projectA,
      mode: 'move',
      dryRun: false,
      dataPath: fixture.workspaceStorage,
      safetyCopyDir: safetyDir,
      skipSafetyCopy: true,
    });
    expect(result[0]).toMatchObject({ success: true });
    expect(result[0]?.safetyCopy).toBeUndefined();
    expect(readdirSync(safetyDir)).toEqual([]);
  });

  it('is refused for the platform-default Cursor directory', async () => {
    const appData = tempDir('cursor-history-appdata-');
    vi.stubEnv('APPDATA', appData);
    vi.stubEnv('LOCALAPPDATA', join(appData, 'Local'));
    vi.stubEnv('HOME', appData);
    vi.stubEnv('USERPROFILE', appData);
    vi.stubEnv('XDG_CONFIG_HOME', '');
    vi.stubEnv('CURSOR_DATA_PATH', '');
    // Cursor/ directory above the platform-default User dir (differs per OS).
    const userDir = platformDefaultUserDir();
    const root = dirname(userDir);
    const projectA = join(appData, 'workspaces', 'a');
    const projectB = join(appData, 'workspaces', 'b');
    for (const dir of [projectA, projectB, join(userDir, 'globalStorage')]) {
      mkdirSync(dir, { recursive: true });
    }
    const fake: SessionIntegrityFixtureRoot = {
      root,
      workspaceStorage: join(userDir, 'workspaceStorage'),
      globalStorage: join(userDir, 'globalStorage'),
      storeRoot: join(appData, 'store'),
      projectA,
      projectB,
      cleanup: () => undefined,
    };
    vi.stubEnv('CURSOR_STORE_ROOT', fake.storeRoot);
    seedCorpus(fake);
    const destination = join(appData, 'workspaces', 'destination');
    mkdirSync(destination, { recursive: true });
    writeComposerWorkspaceSummary(fake, 'workspace-destination', destination, []);
    writeComposerGlobalSessions(fake, []);
    const before = fileState(fake);
    const rwSpy = vi.spyOn(registry, 'openDatabaseReadWrite');

    await expect(
      migrateSession({
        sessions: 1,
        destination,
        workspace: projectA,
        mode: 'move',
        dryRun: false,
        skipSafetyCopy: true,
      })
    ).rejects.toMatchObject({ code: 'SAFETY_COPY_REQUIRED' });
    expect(rwSpy).not.toHaveBeenCalled();
    expect(fileState(fake)).toBe(before);
  });
});

describe('CLI confirmation', () => {
  it.each([
    [
      'migrate-session',
      (f: SessionIntegrityFixtureRoot, d: string) => [
        'migrate-session',
        '1',
        d,
        '--workspace-unused',
      ],
    ],
    ['migrate', (f: SessionIntegrityFixtureRoot, d: string) => ['migrate', f.projectA, d]],
  ])(
    '%s requires --yes outside a TTY and changes nothing',
    async (name, build) => {
      const fixture = newFixture();
      seedCorpus(fixture);
      const destination = addDestination(fixture);
      const before = fileState(fixture);
      const args = build(fixture, destination).filter((a) => a !== '--workspace-unused');
      const common = ['--json', '--data-path', fixture.workspaceStorage];
      const env = { CURSOR_STORE_ROOT: fixture.storeRoot };
      if (name === 'migrate-session') common.push('--workspace', fixture.projectA);

      const refused = await runBuiltCli([...common, ...args], { env, timeoutMs: 30_000 });
      expect(refused.status).toBe(2);
      expect(refused.stdout).toBe('');
      expect(JSON.parse(refused.stderr)).toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
      expect(fileState(fixture)).toBe(before);

      const safetyDir = tempDir('cursor-history-safety-');
      const accepted = await runBuiltCli([...common, ...args, '--yes', '--safety-dir', safetyDir], {
        env,
        timeoutMs: 60_000,
      });
      expect(accepted.status).toBe(0);
      expect(readdirSync(safetyDir)).toHaveLength(1);
      expect(fileState(fixture)).not.toBe(before);
    },
    120_000
  );
});
