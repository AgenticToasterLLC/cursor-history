import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { join } from 'node:path';
import { runBuiltCli } from '../helpers/run-cli.js';
import { canonicalTempDir } from '../helpers/canonical-temp.js';
import {
  createSessionIntegrityFixtureRoot,
  seedConflictingWorkspaceCorpus,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';

const WARNING =
  /WARNING: .+ already exists \(\d+ B\) and will be TRUNCATED and overwritten\. This cannot be undone\./;

let fixture: SessionIntegrityFixtureRoot;
let fakeHome: string;
let env: NodeJS.ProcessEnv;
let liveDb: string;

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

beforeEach(() => {
  fixture = createSessionIntegrityFixtureRoot('cursor-history-out-safety-');
  seedConflictingWorkspaceCorpus(fixture);
  // Fake "live Cursor" tree; every user-directory variable is redirected into it.
  fakeHome = mkdtempSync(join(canonicalTempDir(), 'out-safety-home-'));
  const appData = join(fakeHome, 'AppData', 'Roaming');
  const liveGlobal = join(appData, 'Cursor', 'User', 'globalStorage');
  mkdirSync(liveGlobal, { recursive: true });
  mkdirSync(join(appData, 'Cursor', 'User', 'workspaceStorage'), { recursive: true });
  liveDb = join(liveGlobal, 'state.vscdb');
  writeFileSync(liveDb, 'not really a database');
  env = {
    APPDATA: appData,
    LOCALAPPDATA: join(fakeHome, 'AppData', 'Local'),
    USERPROFILE: fakeHome,
    HOME: fakeHome,
    CURSOR_STORE_ROOT: fixture.storeRoot,
  };
  delete env['CURSOR_DATA_PATH'];
});

afterEach(() => {
  fixture.cleanup();
  rmSync(fakeHome, { recursive: true, force: true });
});

const base = (): string[] => [
  '--data-path',
  fixture.workspaceStorage,
  '--workspace',
  fixture.projectA,
];

describe('built CLI export output safety', { timeout: 60_000 }, () => {
  it('writes a new file without any warning', async () => {
    const out = join(fixture.root, 'new.md');
    const run = await runBuiltCli([...base(), 'export', '1', '-o', out], {
      env,
      timeoutMs: 30_000,
    });
    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain('WARNING');
    expect(existsSync(out)).toBe(true);
  });

  it('refuses an existing target without --force, and with --force but no confirmation', async () => {
    const out = join(fixture.root, 'existing.md');
    writeFileSync(out, 'precious');
    const plain = await runBuiltCli([...base(), 'export', '1', '-o', out], {
      env,
      timeoutMs: 30_000,
    });
    expect(plain.status).not.toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('precious');

    const forced = await runBuiltCli([...base(), 'export', '1', '-o', out, '--force'], {
      env,
      timeoutMs: 30_000,
    });
    expect(forced.status).toBe(2);
    expect(forced.stderr).toMatch(WARNING);
    expect(forced.stderr).toContain('--yes');
    expect(readFileSync(out, 'utf8')).toBe('precious');

    const forcedJson = await runBuiltCli(
      ['--json', ...base(), 'export', '1', '-o', out, '--force'],
      {
        env,
        timeoutMs: 30_000,
      }
    );
    expect(forcedJson.status).toBe(2);
    expect(forcedJson.stderr).toContain('OVERWRITE_NOT_CONFIRMED');
    expect(readFileSync(out, 'utf8')).toBe('precious');
  });

  it('--yes without --force does not allow an existing target', async () => {
    const out = join(fixture.root, 'existing.md');
    writeFileSync(out, 'precious');
    const run = await runBuiltCli([...base(), 'export', '1', '-o', out, '--yes'], {
      env,
      timeoutMs: 30_000,
    });
    expect(run.status).not.toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('precious');
  });

  it('overwrites atomically with --force --yes and prints the warning on stderr', async () => {
    const out = join(fixture.root, 'existing.md');
    writeFileSync(out, 'precious');
    const run = await runBuiltCli([...base(), 'export', '1', '-o', out, '--force', '--yes'], {
      env,
      timeoutMs: 30_000,
    });
    expect(run.status).toBe(0);
    expect(run.stderr).toMatch(WARNING);
    expect(readFileSync(out, 'utf8')).not.toBe('precious');
    expect(readdirSync(fixture.root).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('directory-mode export --all requires confirmation to replace files', async () => {
    const dir = join(fixture.root, 'all');
    const first = await runBuiltCli([...base(), 'export', '--all', '-o', dir], {
      env,
      timeoutMs: 30_000,
    });
    expect(first.status).toBe(0);
    const files = readdirSync(dir);
    expect(files.length).toBeGreaterThan(0);
    const victim = join(dir, files[0]!);
    writeFileSync(victim, 'precious');
    const refused = await runBuiltCli([...base(), 'export', '--all', '-o', dir, '--force'], {
      env,
      timeoutMs: 30_000,
    });
    expect(refused.status).toBe(2);
    expect(readFileSync(victim, 'utf8')).toBe('precious');
    const ok = await runBuiltCli([...base(), 'export', '--all', '-o', dir, '--force', '--yes'], {
      env,
      timeoutMs: 30_000,
    });
    expect(ok.status).toBe(0);
    expect(ok.stderr).toMatch(WARNING);
    expect(readFileSync(victim, 'utf8')).not.toBe('precious');
  });

  it('refuses protected targets even with --force --yes', async () => {
    const before = {
      sha: sha(liveDb),
      size: statSync(liveDb).size,
      mtime: statSync(liveDb).mtimeMs,
    };
    const inCursor = join(
      fakeHome,
      'AppData',
      'Roaming',
      'Cursor',
      'User',
      'globalStorage',
      'notes.md'
    );
    const dirInCursor = join(
      fakeHome,
      'AppData',
      'Roaming',
      'Cursor',
      'User',
      'workspaceStorage',
      'out'
    );
    for (const args of [
      ['export', '1', '-o', liveDb, '--force', '--yes'],
      ['export', '1', '-o', inCursor, '--force', '--yes'],
      ['export', '1', '-o', join(fixture.root, 'x.vscdb'), '--force', '--yes'],
      ['export', '--all', '-o', dirInCursor, '--force', '--yes'],
      ['export-training', '-o', liveDb, '--force', '--yes'],
      ['export-training', '-o', inCursor, '--force', '--yes'],
    ]) {
      const run = await runBuiltCli([...base(), ...args], { env, timeoutMs: 30_000 });
      expect(run.status, args.join(' ')).toBe(2);
      expect(run.stderr).toContain('Refusing to write');
    }
    const json = await runBuiltCli(
      ['--json', ...base(), 'export', '1', '-o', liveDb, '--force', '--yes'],
      {
        env,
        timeoutMs: 30_000,
      }
    );
    expect(json.status).toBe(2);
    expect(json.stderr).toContain('PROTECTED_PATH');
    expect({
      sha: sha(liveDb),
      size: statSync(liveDb).size,
      mtime: statSync(liveDb).mtimeMs,
    }).toEqual(before);
    expect(existsSync(inCursor)).toBe(false);
    expect(existsSync(dirInCursor)).toBe(false);
    expect(existsSync(join(fixture.root, 'x.vscdb'))).toBe(false);
  });
});

describe('built CLI export-training output safety', { timeout: 60_000 }, () => {
  it('requires confirmation to replace existing outputs', async () => {
    const out = join(fixture.root, 'train.jsonl');
    const create = await runBuiltCli([...base(), 'export-training', '-o', out], {
      env,
      timeoutMs: 30_000,
    });
    expect(create.status).toBe(0);
    writeFileSync(out, 'precious');

    const plain = await runBuiltCli([...base(), 'export-training', '-o', out], {
      env,
      timeoutMs: 30_000,
    });
    expect(plain.status).not.toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('precious');

    const forced = await runBuiltCli([...base(), 'export-training', '-o', out, '--force'], {
      env,
      timeoutMs: 30_000,
    });
    expect(forced.status).toBe(2);
    expect(forced.stderr).toMatch(WARNING);
    expect(readFileSync(out, 'utf8')).toBe('precious');

    const confirmed = await runBuiltCli(
      [...base(), 'export-training', '-o', out, '--force', '--yes'],
      { env, timeoutMs: 30_000 }
    );
    expect(confirmed.status).toBe(0);
    expect(confirmed.stderr).toMatch(WARNING);
    expect(readFileSync(out, 'utf8')).not.toBe('precious');
  });
});
