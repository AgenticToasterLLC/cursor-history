import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeSourceFingerprint,
  countFingerprintChanges,
  isFingerprintSettled,
} from '../../../src/core/catalog/fingerprint.js';
import { registry } from '../../../src/core/database/registry.js';

const dirs: string[] = [];
function setup(workspaces = 3) {
  const root = mkdtempSync(join(tmpdir(), 'catalog-fp-'));
  dirs.push(root);
  const dataPath = join(root, 'workspaceStorage');
  const globalDbPath = join(root, 'globalStorage', 'state.vscdb');
  const storeRoot = join(root, 'store');
  mkdirSync(join(root, 'globalStorage'), { recursive: true });
  writeFileSync(globalDbPath, 'g');
  for (let i = 0; i < workspaces; i += 1) {
    const ws = join(dataPath, `ws${i}`);
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'state.vscdb'), 'db' + i);
    writeFileSync(join(ws, 'workspace.json'), '{}');
  }
  const sess = join(storeRoot, 'chats', 'h1', 'u1');
  mkdirSync(sess, { recursive: true });
  writeFileSync(join(sess, 'store.db'), 's');
  writeFileSync(join(sess, 'meta.json'), '{"a":1}');
  const tdir = join(storeRoot, 'projects', 'p', 'agent-transcripts', 'u2');
  mkdirSync(tdir, { recursive: true });
  writeFileSync(join(tdir, 'u2.jsonl'), 'x');
  return { root, inputs: { dataPath, globalDbPath, storeRoot }, sess, dataPath };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('source fingerprint', () => {
  it('is stable when nothing changes', async () => {
    const { inputs } = setup();
    const a = await computeSourceFingerprint(inputs);
    const b = await computeSourceFingerprint(inputs);
    expect(a.digest).toBe(b.digest);
    expect(countFingerprintChanges(a, b)).toBe(0);
  });

  it('detects a same-size in-place rewrite with an mtime bump', async () => {
    const { inputs, dataPath } = setup();
    const a = await computeSourceFingerprint(inputs);
    const f = join(dataPath, 'ws1', 'state.vscdb');
    writeFileSync(f, 'dbX'.slice(0, 3));
    const t = new Date(Date.now() + 5000);
    utimesSync(f, t, t);
    const b = await computeSourceFingerprint(inputs);
    expect(b.digest).not.toBe(a.digest);
    expect(countFingerprintChanges(a, b)).toBe(1);
  });

  it('detects a -wal appearing', async () => {
    const { inputs, dataPath } = setup();
    const a = await computeSourceFingerprint(inputs);
    writeFileSync(join(dataPath, 'ws0', 'state.vscdb-wal'), 'w');
    const b = await computeSourceFingerprint(inputs);
    expect(b.digest).not.toBe(a.digest);
    expect(countFingerprintChanges(a, b)).toBeGreaterThanOrEqual(1);
  });

  it('ignores -shm', async () => {
    const { inputs, dataPath } = setup();
    const a = await computeSourceFingerprint(inputs);
    writeFileSync(join(dataPath, 'ws0', 'state.vscdb-shm'), 'w');
    expect((await computeSourceFingerprint(inputs)).digest).toBe(a.digest);
  });

  it('detects a new workspace dir', async () => {
    const { inputs, dataPath } = setup();
    const a = await computeSourceFingerprint(inputs);
    mkdirSync(join(dataPath, 'wsNew'));
    const b = await computeSourceFingerprint(inputs);
    expect(b.digest).not.toBe(a.digest);
    expect(countFingerprintChanges(a, b)).toBeGreaterThanOrEqual(1);
  });

  it('detects Store meta.json and transcript changes', async () => {
    const { inputs, sess, root } = setup();
    const a = await computeSourceFingerprint(inputs);
    writeFileSync(join(sess, 'meta.json'), '{"a":22}');
    const b = await computeSourceFingerprint(inputs);
    expect(b.digest).not.toBe(a.digest);
    writeFileSync(join(root, 'store', 'projects', 'p', 'agent-transcripts', 'u3.jsonl'), 'new');
    const c = await computeSourceFingerprint(inputs);
    expect(c.digest).not.toBe(b.digest);
  });

  it('records a missing global db as absent and detects appearance', async () => {
    const { inputs } = setup();
    fs.rmSync(inputs.globalDbPath);
    const a = await computeSourceFingerprint(inputs);
    expect(a.files.find((f) => f.path.endsWith('state.vscdb') && !f.exists)).toBeDefined();
    writeFileSync(inputs.globalDbPath, 'g');
    expect((await computeSourceFingerprint(inputs)).digest).not.toBe(a.digest);
  });

  it('fingerprints ~300 files quickly', async () => {
    const { inputs } = setup(140);
    const t0 = performance.now();
    const fp = await computeSourceFingerprint(inputs);
    const ms = performance.now() - t0;
    expect(fp.files.length).toBeGreaterThanOrEqual(300);
    console.log(`fingerprint ${fp.files.length} files: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(1000);
  });

  it('never opens a database or reads file contents', async () => {
    const { inputs } = setup();
    const open = vi.spyOn(registry, 'openSync');
    const openRo = vi.spyOn(registry, 'openDatabase');
    const read = vi.spyOn(fs.promises, 'readFile');
    await computeSourceFingerprint(inputs);
    expect(open).not.toHaveBeenCalled();
    expect(openRo).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('settle helper', async () => {
    const { inputs } = setup();
    const fp = await computeSourceFingerprint(inputs);
    expect(isFingerprintSettled(fp, Date.now() + 10_000, 2000)).toBe(true);
    expect(isFingerprintSettled(fp, Date.now() - 10_000, 2000)).toBe(false);
  });
});
