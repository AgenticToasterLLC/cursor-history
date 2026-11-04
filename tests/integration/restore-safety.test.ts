import BetterSqlite3 from 'better-sqlite3';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Process detection and the restore commit point are stubbed so the tests are independent of a
// developer's running Cursor and can inject faults. Every restore below targets a temp tree: the
// environment is redirected in beforeEach so the "platform default" is itself a temp directory.
const proc = vi.hoisted(() => ({ running: false }));
const pub = vi.hoisted(() => ({
  calls: 0,
  failOnCall: 0,
  beforeCommit: undefined as undefined | ((destination: string, call: number) => void),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn((file: string) => {
      if (file === 'tasklist') {
        return proc.running ? '"Cursor.exe","1234","Console","1","100 K"\n' : 'INFO: No tasks.\n';
      }
      if (proc.running) return Buffer.from('1234\n');
      throw new Error('not running');
    }),
  };
});

vi.mock('../../src/core/restore-publication.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/restore-publication.js')>();
  return {
    ...actual,
    commitRestorePublication: (
      ...args: Parameters<typeof actual.commitRestorePublication>
    ): void => {
      pub.calls += 1;
      pub.beforeCommit?.(args[1], pub.calls);
      if (pub.failOnCall === pub.calls) throw new Error('injected publication failure');
      actual.commitRestorePublication(...args);
    },
  };
});

import {
  assertWorkspaceStorageTarget,
  looksLikeWorkspaceStorage,
} from '../../src/cli/commands/restore.js';
import { platformDefaultUserDir } from '../helpers/live-tree.js';
import { defaultRestoreSafetyRoot } from '../../src/core/restore-safety.js';
import { CliError } from '../../src/cli/errors.js';
import { readBackupManifest, restoreBackup } from '../../src/core/backup.js';
import { LiveTargetNotConfirmedError, RestoreSafetyCopyError } from '../../src/lib/errors.js';
import { CursorRunningError, ProtectedPathError } from '../../src/core/write-guard.js';
import {
  createFixtureBackup,
  seedConflictingWorkspaceCorpus,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';

const ENV_NAMES = [
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'HOME',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'CURSOR_DATA_PATH',
  'CURSOR_HISTORY_SKIP_RUNNING_CHECK',
  'CURSOR_HISTORY_RESTORE_SAFETY_DIR',
] as const;

interface Env {
  root: string;
  user: string;
  workspaceStorage: string;
  safetyRoot: string;
  archive: string;
  fixture: SessionIntegrityFixtureRoot;
}

const prior = new Map<string, string | undefined>();
let env: Env;

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Content hash of every file below `dir`, keyed by relative path. */
function snapshot(dir: string = env.user): Record<string, string> {
  const result: Record<string, string> = {};
  for (const file of walk(dir)) {
    result[relative(dir, file).split(sep).join('/')] = sha(file);
  }
  return result;
}

function mtimes(dir: string = env.user): Record<string, number> {
  const result: Record<string, number> = {};
  for (const file of walk(dir)) {
    result[relative(dir, file).split(sep).join('/')] = statSync(file).mtimeMs;
  }
  return result;
}

function mutateLive(): void {
  for (const file of walk(env.user).filter((path) => path.endsWith('state.vscdb'))) {
    const db = new BetterSqlite3(file);
    try {
      db.exec('CREATE TABLE IF NOT EXISTS live_only (x TEXT)');
      db.prepare('INSERT INTO live_only (x) VALUES (?)').run('live-only-row');
    } finally {
      db.close();
    }
  }
  for (const file of walk(env.user).filter((path) => path.endsWith('workspace.json'))) {
    writeFileSync(file, JSON.stringify({ folder: 'file:///live/only' }));
  }
}

function addStaleCompanions(): void {
  for (const name of ['workspace-a', 'workspace-b']) {
    const db = join(env.workspaceStorage, name, 'state.vscdb');
    writeFileSync(`${db}-wal`, Buffer.alloc(0));
    writeFileSync(`${db}-shm`, Buffer.alloc(32768, 0xab));
  }
}

function integrity(path: string): string {
  const db = new BetterSqlite3(path, { readonly: true });
  try {
    return String(db.pragma('integrity_check', { simple: true }));
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  for (const name of ENV_NAMES) prior.set(name, process.env[name]);
  const root = mkdtempSync(join(tmpdir(), 'restore-safety-'));
  process.env['APPDATA'] = join(root, 'appdata');
  process.env['LOCALAPPDATA'] = join(root, 'local');
  process.env['USERPROFILE'] = join(root, 'home');
  process.env['HOME'] = join(root, 'home');
  delete process.env['XDG_CACHE_HOME'];
  delete process.env['XDG_CONFIG_HOME'];
  delete process.env['CURSOR_DATA_PATH'];
  delete process.env['CURSOR_HISTORY_SKIP_RUNNING_CHECK'];
  delete process.env['CURSOR_HISTORY_RESTORE_SAFETY_DIR'];
  for (const dir of ['appdata', 'local', 'home']) mkdirSync(join(root, dir), { recursive: true });

  // The platform default (per OS) resolved under the redirected env is a temp fake "live" tree.
  const user = platformDefaultUserDir();
  const fixture: SessionIntegrityFixtureRoot = {
    root,
    workspaceStorage: join(user, 'workspaceStorage'),
    globalStorage: join(user, 'globalStorage'),
    storeRoot: join(root, 'store'),
    projectA: join(root, 'workspaces', 'a'),
    projectB: join(root, 'workspaces', 'b'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  for (const dir of [fixture.workspaceStorage, fixture.globalStorage, fixture.storeRoot]) {
    mkdirSync(dir, { recursive: true });
  }
  seedConflictingWorkspaceCorpus(fixture);
  env = {
    root,
    user,
    workspaceStorage: fixture.workspaceStorage,
    safetyRoot: defaultRestoreSafetyRoot(),
    archive: '',
    fixture,
  };
  env.archive = await createFixtureBackup(fixture, 'live.zip');
  mutateLive();
  proc.running = false;
  pub.calls = 0;
  pub.failOnCall = 0;
  pub.beforeCommit = undefined;
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = prior.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  env.fixture.cleanup();
});

describe('restore safety copies', () => {
  it('copies and verifies every replaced file before replacing anything, then restores exactly', async () => {
    addStaleCompanions();
    const before = snapshot();
    let safetyAtFirstCommit: string[] | undefined;
    pub.beforeCommit = (_destination, call) => {
      if (call === 1)
        safetyAtFirstCommit = walk(env.safetyRoot).map((file) => file.split(sep).pop()!);
    };

    const result = await restoreBackup({
      backupPath: env.archive,
      force: true,
      confirmLiveTarget: true,
    });
    expect(result.success, result.error).toBe(true);
    expect(safetyAtFirstCommit).toContain('manifest.json');

    const safety = result.safetyCopy!;
    expect(safety.directory.startsWith(env.safetyRoot)).toBe(true);
    expect(relative(env.user, safety.directory).startsWith('..')).toBe(true);
    const manifest = JSON.parse(readFileSync(safety.manifestPath, 'utf8')) as {
      files: Array<{ path: string; size: number; sha256: string }>;
    };
    const paths = manifest.files.map((file) => file.path).sort();
    expect(paths).toEqual(
      expect.arrayContaining([
        'globalStorage/state.vscdb',
        'workspaceStorage/workspace-a/state.vscdb',
        'workspaceStorage/workspace-a/state.vscdb-shm',
        'workspaceStorage/workspace-a/state.vscdb-wal',
        'workspaceStorage/workspace-b/workspace.json',
      ])
    );
    expect(safety.fileCount).toBe(manifest.files.length);
    for (const entry of manifest.files) {
      // Safety copy holds the pre-restore bytes, verified against the manifest.
      expect(entry.sha256).toBe(before[entry.path]);
      expect(sha(join(safety.directory, ...entry.path.split('/')))).toBe(entry.sha256);
      expect(statSync(join(safety.directory, ...entry.path.split('/'))).size).toBe(entry.size);
    }

    // Live files now equal the archive byte for byte.
    const archived = (await readBackupManifest(env.archive))!;
    const after = snapshot();
    for (const file of archived.files) {
      expect(after[file.path], file.path).toBe(file.checksum.replace('sha256:', ''));
    }
    expect(Object.keys(after).filter((path) => /-wal$|-shm$|old-wal|\.tmp$/u.test(path))).toEqual(
      []
    );
  });

  it('honours safetyCopyDir and refuses one inside Cursor data', async () => {
    const custom = join(env.root, 'my-safety');
    const ok = await restoreBackup({
      backupPath: env.archive,
      force: true,
      confirmLiveTarget: true,
      safetyCopyDir: custom,
    });
    expect(ok.success, ok.error).toBe(true);
    expect(ok.safetyCopy!.directory.startsWith(custom)).toBe(true);

    mutateLive();
    const before = snapshot();
    for (const bad of [join(env.user, 'safety'), join(env.workspaceStorage, 'x')]) {
      await expect(
        restoreBackup({
          backupPath: env.archive,
          force: true,
          confirmLiveTarget: true,
          safetyCopyDir: bad,
        })
      ).rejects.toBeInstanceOf(ProtectedPathError);
    }
    expect(snapshot()).toEqual(before);
  });

  it('aborts untouched when the safety copy cannot be created', async () => {
    const blocker = join(env.root, 'blocker');
    writeFileSync(blocker, 'a file, not a directory');
    const before = snapshot();
    const times = mtimes();
    await expect(
      restoreBackup({
        backupPath: env.archive,
        force: true,
        confirmLiveTarget: true,
        safetyCopyDir: join(blocker, 'sub'),
      })
    ).rejects.toBeInstanceOf(RestoreSafetyCopyError);
    expect(snapshot()).toEqual(before);
    expect(mtimes()).toEqual(times);
    expect(pub.calls).toBe(0);
  });
});

describe('rollback on publication failure', () => {
  it('rolls back the first file when the second publication fails, keeping the safety copy', async () => {
    addStaleCompanions();
    const before = snapshot();
    pub.failOnCall = 2;

    const result = await restoreBackup({
      backupPath: env.archive,
      force: true,
      confirmLiveTarget: true,
    });
    expect(pub.calls).toBe(2);
    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain('injected publication failure');
    // Every live file (including -wal/-shm) is byte-identical and nothing stray is left behind.
    expect(snapshot()).toEqual(before);
    expect(existsSync(result.safetyCopy!.directory)).toBe(true);
    expect(existsSync(result.safetyCopy!.manifestPath)).toBe(true);
  });

  it('throws RESTORE_ROLLBACK_INCOMPLETE naming the safety copy only when rollback itself fails', async () => {
    pub.failOnCall = 2;
    pub.beforeCommit = (_destination, call) => {
      // Destroy the safety copy of the file that was already replaced so rollback cannot work.
      if (call === 2) {
        for (const file of walk(env.safetyRoot).filter((path) => path.endsWith('.vscdb'))) {
          rmSync(file);
        }
        for (const file of walk(env.safetyRoot).filter((path) => path.endsWith('.json'))) {
          if (!file.endsWith('manifest.json')) rmSync(file);
        }
      }
    };
    const error = await restoreBackup({
      backupPath: env.archive,
      force: true,
      confirmLiveTarget: true,
    }).then(
      () => undefined,
      (caught: unknown) => caught as { code?: string; details?: Record<string, unknown> }
    );
    expect(error?.code).toBe('RESTORE_ROLLBACK_INCOMPLETE');
    expect(String(error?.details?.['safetyCopyDir'])).toContain('restore-safety');
    expect(Number(error?.details?.['rollbackFailureCount'])).toBeGreaterThan(0);
    expect(String(error?.details?.['remedy'])).toContain('manifest.json');
    expect(existsSync(String(error?.details?.['safetyCopyDir']))).toBe(true);
  });
});

describe('Cursor running', () => {
  it('refuses on a non-empty -wal before any write', async () => {
    const wal = join(env.workspaceStorage, 'workspace-a', 'state.vscdb-wal');
    writeFileSync(wal, Buffer.from('pending pages'));
    const before = snapshot();
    const times = mtimes();

    await expect(
      restoreBackup({ backupPath: env.archive, force: true, confirmLiveTarget: true })
    ).rejects.toBeInstanceOf(CursorRunningError);
    expect(snapshot()).toEqual(before);
    expect(mtimes()).toEqual(times);
    expect(existsSync(env.safetyRoot)).toBe(false);
    expect(pub.calls).toBe(0);
  });

  it('refuses when a Cursor process is detected, and the dry run reports it', async () => {
    proc.running = true;
    const before = snapshot();
    const times = mtimes();

    await expect(
      restoreBackup({ backupPath: env.archive, force: true, confirmLiveTarget: true })
    ).rejects.toBeInstanceOf(CursorRunningError);

    const preview = await restoreBackup({
      backupPath: env.archive,
      force: true,
      confirmLiveTarget: true,
      dryRun: true,
    });
    expect(preview.dryRun).toBe(true);
    expect(preview.success).toBe(false);
    expect(preview.blockingConditions?.map((condition) => condition.code)).toEqual([
      'CURSOR_RUNNING',
    ]);
    expect(preview.filesToReplace?.length).toBeGreaterThan(0);
    expect(snapshot()).toEqual(before);
    expect(mtimes()).toEqual(times);
    expect(existsSync(env.safetyRoot)).toBe(false);

    proc.running = false;
    const clear = await restoreBackup({
      backupPath: env.archive,
      force: true,
      confirmLiveTarget: true,
      dryRun: true,
    });
    expect(clear.success).toBe(true);
    expect(clear.blockingConditions).toEqual([]);
    expect(snapshot()).toEqual(before);
  });
});

describe('WAL and SHM handling', () => {
  it('removes stale -wal/-shm so the restored database opens cleanly', async () => {
    addStaleCompanions();
    const dbA = join(env.workspaceStorage, 'workspace-a', 'state.vscdb');
    const observed: Array<{ destination: string; wal: boolean; shm: boolean; dbHash: string }> = [];
    const oldHashes = new Map<string, string>();
    for (const file of walk(env.user).filter((path) => path.endsWith('.vscdb'))) {
      oldHashes.set(file, sha(file));
    }
    pub.beforeCommit = (destination) => {
      observed.push({
        destination,
        wal: existsSync(`${destination}-wal`),
        shm: existsSync(`${destination}-shm`),
        // Still the OLD database at the commit point.
        dbHash: existsSync(destination) ? sha(destination) : '',
      });
    };

    const result = await restoreBackup({
      backupPath: env.archive,
      force: true,
      confirmLiveTarget: true,
    });
    expect(result.success, result.error).toBe(true);

    // Crash-safe order: at the instant the new database is renamed in, the old WAL/SHM are already
    // out of the way, so the new file can never sit next to the old WAL.
    const databases = observed.filter(({ destination }) => destination.endsWith('state.vscdb'));
    expect(databases.length).toBeGreaterThanOrEqual(3);
    for (const entry of databases) {
      expect(entry.wal).toBe(false);
      expect(entry.shm).toBe(false);
      expect(entry.dbHash).toBe(oldHashes.get(entry.destination));
    }

    expect(existsSync(`${dbA}-wal`)).toBe(false);
    expect(existsSync(`${dbA}-shm`)).toBe(false);
    expect(walk(env.user).filter((path) => path.includes('old-wal'))).toEqual([]);
    for (const file of walk(env.user).filter((path) => path.endsWith('.vscdb'))) {
      expect(integrity(file)).toBe('ok');
    }
  });

  it('removes an orphan -wal/-shm that sits next to a database that does not exist yet', async () => {
    rmSync(join(env.workspaceStorage, 'workspace-b'), { recursive: true, force: true });
    mkdirSync(join(env.workspaceStorage, 'workspace-b'), { recursive: true });
    const orphan = join(env.workspaceStorage, 'workspace-b', 'state.vscdb');
    writeFileSync(`${orphan}-shm`, Buffer.alloc(4096, 1));

    const result = await restoreBackup({
      backupPath: env.archive,
      force: true,
      confirmLiveTarget: true,
    });
    expect(result.success, result.error).toBe(true);
    expect(existsSync(`${orphan}-shm`)).toBe(false);
    expect(integrity(orphan)).toBe('ok');
  });
});

describe('checksum failures', () => {
  async function corruptedArchive(): Promise<string> {
    const zip = await JSZip.loadAsync(readFileSync(env.archive));
    const name = 'workspaceStorage/workspace-b/state.vscdb';
    expect(zip.file(name)).not.toBeNull();
    zip.file(name, Buffer.from('tampered database bytes'));
    const path = join(env.root, 'corrupt.zip');
    writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer' }));
    return path;
  }

  it('aborts the whole restore without writing by default', async () => {
    const archive = await corruptedArchive();
    const before = snapshot();
    const times = mtimes();

    const result = await restoreBackup({
      backupPath: archive,
      force: true,
      confirmLiveTarget: true,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/integrity check failed/iu);
    expect(result.error).toContain('allowPartial');
    expect(snapshot()).toEqual(before);
    expect(mtimes()).toEqual(times);
    expect(existsSync(env.safetyRoot)).toBe(false);

    const preview = await restoreBackup({
      backupPath: archive,
      force: true,
      confirmLiveTarget: true,
      dryRun: true,
    });
    expect(preview.blockingConditions?.map((c) => c.code)).toContain('CHECKSUM_MISMATCH');
  });

  it('proceeds with allowPartial and discloses the skipped entry', async () => {
    const archive = await corruptedArchive();
    const bDb = join(env.workspaceStorage, 'workspace-b', 'state.vscdb');
    const bBefore = sha(bDb);

    const result = await restoreBackup({
      backupPath: archive,
      force: true,
      confirmLiveTarget: true,
      allowPartial: true,
    });
    expect(result.success, result.error).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.skippedFiles).toEqual(['workspaceStorage/workspace-b/state.vscdb']);
    expect(result.warnings.join('\n')).toContain(
      'skipped: workspaceStorage/workspace-b/state.vscdb'
    );
    expect(sha(bDb)).toBe(bBefore);
    expect(integrity(join(env.workspaceStorage, 'workspace-a', 'state.vscdb'))).toBe('ok');
  });
});

describe('default live directory', () => {
  it('refuses force alone and proceeds with confirmLiveTarget', async () => {
    const before = snapshot();
    await expect(restoreBackup({ backupPath: env.archive, force: true })).rejects.toBeInstanceOf(
      LiveTargetNotConfirmedError
    );
    expect(snapshot()).toEqual(before);

    const preview = await restoreBackup({ backupPath: env.archive, force: true, dryRun: true });
    expect(preview.blockingConditions?.map((c) => c.code)).toEqual(['LIVE_TARGET_NOT_CONFIRMED']);
    expect(snapshot()).toEqual(before);

    const result = await restoreBackup({
      backupPath: env.archive,
      force: true,
      confirmLiveTarget: true,
    });
    expect(result.success, result.error).toBe(true);
  });

  it('needs no confirmation for an explicit targetPath or a custom CURSOR_DATA_PATH', async () => {
    const custom = join(env.root, 'elsewhere', 'User', 'workspaceStorage');
    const explicit = await restoreBackup({
      backupPath: env.archive,
      targetPath: custom,
      force: true,
    });
    expect(explicit.success, explicit.error).toBe(true);
    expect(explicit.safetyCopy).toBeUndefined();

    process.env['CURSOR_DATA_PATH'] = custom;
    const viaEnv = await restoreBackup({ backupPath: env.archive, force: true });
    expect(viaEnv.success, viaEnv.error).toBe(true);
    expect(viaEnv.safetyCopy?.fileCount).toBeGreaterThan(0);
  });
});

describe('CLI --target validation', () => {
  it('accepts workspaceStorage directories and rejects the User directory', () => {
    expect(looksLikeWorkspaceStorage(env.workspaceStorage)).toBe(true);
    expect(looksLikeWorkspaceStorage(join(env.root, 'new', 'workspaceStorage'))).toBe(true);
    // A differently named directory that contains workspace directories is accepted.
    const renamed = join(env.root, 'renamed');
    mkdirSync(join(renamed, 'abc123'), { recursive: true });
    writeFileSync(join(renamed, 'abc123', 'workspace.json'), '{}');
    expect(looksLikeWorkspaceStorage(renamed)).toBe(true);

    expect(looksLikeWorkspaceStorage(env.user)).toBe(false);
    expect(looksLikeWorkspaceStorage(env.fixture.globalStorage)).toBe(false);
    expect(looksLikeWorkspaceStorage(join(env.root, 'does-not-exist'))).toBe(false);
    expect(() => assertWorkspaceStorageTarget(env.user, '--target')).toThrow(CliError);
    expect(() => assertWorkspaceStorageTarget(env.user, '--target')).toThrow(/workspaceStorage/u);
    expect(() => assertWorkspaceStorageTarget(env.workspaceStorage, '--target')).not.toThrow();
  });
});
