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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackup } from '../../src/core/backup.js';
import { StagedOutputs } from '../../src/core/staged-output.js';
import { ProtectedPathError } from '../../src/core/write-guard.js';
import {
  confirmOverwrite,
  formatTruncationWarning,
  promptOverwrite,
  writeFileAtomic,
} from '../../src/cli/overwrite-confirmation.js';
import { isCursorRunningError, isProtectedPathError } from '../../src/lib/index.js';
import { canonicalTempDir } from '../helpers/canonical-temp.js';

const ENV_KEYS = ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'CURSOR_DATA_PATH'] as const;

interface Snapshot {
  sha: string;
  size: number;
  mtimeMs: number;
}

function snapshot(path: string): Snapshot {
  const stat = statSync(path);
  return {
    sha: createHash('sha256').update(readFileSync(path)).digest('hex'),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      out.push(full);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out.sort();
}

function sink(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

describe('output path safety', () => {
  let root: string;
  let cursorRoot: string;
  let workspaceStorage: string;
  let globalDb: string;
  let wsDb: string;
  let outside: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    root = mkdtempSync(join(canonicalTempDir(), 'output-safety-'));
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    const appData = join(root, 'AppData', 'Roaming');
    cursorRoot = join(appData, 'Cursor', 'User');
    workspaceStorage = join(cursorRoot, 'workspaceStorage');
    const globalStorage = join(cursorRoot, 'globalStorage');
    mkdirSync(join(workspaceStorage, 'ws1'), { recursive: true });
    mkdirSync(globalStorage, { recursive: true });
    globalDb = join(globalStorage, 'state.vscdb');
    wsDb = join(workspaceStorage, 'ws1', 'state.vscdb');
    for (const path of [globalDb, wsDb]) {
      const db = new BetterSqlite3(path);
      db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      db.close();
    }
    writeFileSync(`${globalDb}-wal`, 'wal-bytes');
    writeFileSync(join(workspaceStorage, 'ws1', 'notes.txt'), 'keep me');
    outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    process.env['APPDATA'] = appData;
    process.env['LOCALAPPDATA'] = join(root, 'AppData', 'Local');
    process.env['USERPROFILE'] = join(root, 'home');
    process.env['HOME'] = join(root, 'home');
    process.env['CURSOR_DATA_PATH'] = workspaceStorage;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(root, { recursive: true, force: true });
  });

  describe('createBackup', () => {
    it('refuses protected outputs with and without force and leaves Cursor data untouched', async () => {
      const link = join(outside, 'link-to-ws');
      let linkOk = true;
      try {
        symlinkSync(join(workspaceStorage, 'ws1'), link, 'junction');
      } catch {
        linkOk = false;
      }
      const targets = [
        globalDb,
        `${globalDb}-wal`,
        join(workspaceStorage, 'ws1', 'notes.txt'),
        join(workspaceStorage, 'ws1', 'new-backup.zip'),
        join(outside, 'x.vscdb'),
        ...(linkOk ? [join(link, 'notes.txt'), join(link, 'fresh.zip')] : []),
      ];
      const watched = [
        globalDb,
        `${globalDb}-wal`,
        wsDb,
        join(workspaceStorage, 'ws1', 'notes.txt'),
      ];
      const before = new Map(watched.map((p) => [p, snapshot(p)]));
      const treeBefore = listTree(cursorRoot);
      for (const outputPath of targets) {
        for (const force of [false, true]) {
          await expect(
            createBackup({ sourcePath: workspaceStorage, outputPath, force })
          ).rejects.toMatchObject({ code: 'PROTECTED_PATH' });
        }
      }
      for (const [path, snap] of before) expect(snapshot(path)).toEqual(snap);
      expect(listTree(cursorRoot)).toEqual(treeBefore);
      expect(existsSync(join(outside, 'x.vscdb'))).toBe(false);
    });

    it('error is recognized by the exported type guard', async () => {
      const error = await createBackup({
        sourcePath: workspaceStorage,
        outputPath: globalDb,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProtectedPathError);
      expect(isProtectedPathError(error)).toBe(true);
      expect(isCursorRunningError(error)).toBe(false);
    });

    it('still writes a normal output path', async () => {
      const outputPath = join(outside, 'backup.zip');
      const result = await createBackup({ sourcePath: workspaceStorage, outputPath });
      expect(result.success).toBe(true);
      expect(statSync(outputPath).size).toBeGreaterThan(0);
    });
  });

  describe('overwrite confirmation', () => {
    it('prompt proceeds only on exactly "overwrite"', async () => {
      for (const [answer, expected] of [
        ['overwrite\n', true],
        ['Overwrite\n', false],
        ['yes\n', false],
        ['overwrite please\n', false],
        ['\n', false],
        ['', false],
      ] as const) {
        const input = new PassThrough();
        const out = sink();
        const pending = promptOverwrite(input, out.stream);
        if (answer) input.write(answer);
        else input.end();
        expect(await pending).toBe(expected);
        expect(out.text()).toContain('Type "overwrite" to continue:');
      }
    });

    it('prints the warning and aborts on a wrong interactive answer', async () => {
      const target = join(outside, 'a.md');
      writeFileSync(target, 'x'.repeat(2048));
      const input = new PassThrough();
      const out = sink();
      const pending = confirmOverwrite(target, { input, output: out.stream, interactive: true });
      input.write('no\n');
      await expect(pending).rejects.toThrow(/not confirmed/);
      expect(out.text()).toContain(formatTruncationWarning(target, 2048));
      expect(out.text()).toContain(
        '(2.0 KiB) and will be TRUNCATED and overwritten. This cannot be undone.'
      );
    });

    it('accepts the typed word interactively', async () => {
      const target = join(outside, 'a.md');
      writeFileSync(target, 'old');
      const input = new PassThrough();
      const out = sink();
      const pending = confirmOverwrite(target, { input, output: out.stream, interactive: true });
      input.write('overwrite\n');
      await expect(pending).resolves.toBeUndefined();
    });

    it('requires --yes when non-interactive or json, even in a tty', async () => {
      const target = join(outside, 'a.md');
      writeFileSync(target, 'old');
      const out = sink();
      await expect(
        confirmOverwrite(target, { output: out.stream, interactive: false })
      ).rejects.toThrow(/--yes/);
      await expect(
        confirmOverwrite(target, { output: out.stream, interactive: true, json: true })
      ).rejects.toThrow(/--yes/);
      await expect(
        confirmOverwrite(target, { output: out.stream, interactive: false, yes: true })
      ).resolves.toBeUndefined();
      expect(out.text()).toContain('WARNING:');
    });

    it('writeFileAtomic replaces the file and leaves no temp files', () => {
      const target = join(outside, 'b.md');
      writeFileSync(target, 'old');
      writeFileAtomic(target, 'new');
      expect(readFileSync(target, 'utf8')).toBe('new');
      expect(readdirSync(outside).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    });
  });

  describe('training staged outputs', () => {
    it('refuses protected targets before creating anything', async () => {
      const treeBefore = listTree(cursorRoot);
      await expect(
        StagedOutputs.create([join(workspaceStorage, 'ws1', 'train.jsonl')], true)
      ).rejects.toMatchObject({ code: 'PROTECTED_PATH' });
      await expect(StagedOutputs.create([globalDb], true)).rejects.toMatchObject({
        code: 'PROTECTED_PATH',
      });
      await expect(
        StagedOutputs.create([join(outside, 'ok.jsonl'), join(outside, 'x.vscdb')], true)
      ).rejects.toMatchObject({ code: 'PROTECTED_PATH' });
      expect(listTree(cursorRoot)).toEqual(treeBefore);
      expect(readdirSync(outside)).toEqual([]);
    });
  });
});
