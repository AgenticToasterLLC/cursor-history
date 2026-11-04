/**
 * Source fingerprinting for the sidecar catalog. STAT-ONLY: this module never
 * opens a database and never reads file contents; it only calls `stat` and
 * lists directory names.
 *
 * Why size+mtime of a db and its -wal is sufficient: a snapshot is invalidated
 * as a whole on ANY change (never per record), and every SQLite write changes
 * the main db file or its -wal (mtime and, for the -wal, usually size). We do
 * not need to know what changed, only that something may have.
 *
 * Residual risk: a filesystem with coarse mtime granularity combined with a
 * same-size rewrite inside one granule would be invisible. Mitigation: the
 * fingerprint's files carry their mtimes and callers must not mark a snapshot
 * `ready` unless `isFingerprintSettled(fp, now, settleMs)` holds, i.e. the
 * fingerprint was taken at least settleMs (default 2 s) after the newest
 * observed mtime. A snapshot that is not settled is served as stale/rebuilt.
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { join, resolve } from 'node:path';

import type { FingerprintInputs, SourceFileFingerprint, SourceFingerprint } from './contract.js';

/** Default settle window (ms) between the newest mtime and fingerprint time. */
export const DEFAULT_FINGERPRINT_SETTLE_MS = 2000;
const CONCURRENCY = 64;
const MAX_TRANSCRIPT_DEPTH = 4;

class Limiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

interface DirEntry {
  name: string;
  dir: boolean;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

class Collector {
  readonly files = new Set<string>();
  readonly listings = new Map<string, string>();
  private readonly limiter = new Limiter(CONCURRENCY);

  addFile(path: string, withWal = false): void {
    this.files.add(resolve(path));
    if (withWal) this.files.add(resolve(`${path}-wal`));
  }

  /** List names (and dir-ness) and record the listing. A missing dir is recorded as absent. */
  async list(dir: string): Promise<DirEntry[]> {
    const key = resolve(dir);
    try {
      const entries = await this.limiter.run(() => fsp.readdir(key, { withFileTypes: true }));
      const mapped = entries
        .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => cmp(a.name, b.name));
      this.listings.set(key, mapped.map((e) => `${e.dir ? 'd' : 'f'}:${e.name}`).join('\n'));
      return mapped;
    } catch {
      this.listings.set(key, '<absent>');
      return [];
    }
  }

  stat(path: string): Promise<SourceFileFingerprint> {
    return this.limiter.run(async () => {
      try {
        const st = await fsp.stat(path, { bigint: true });
        return { path, exists: true, size: Number(st.size), mtimeNs: st.mtimeNs.toString() };
      } catch {
        return { path, exists: false };
      }
    });
  }
}

async function walkComposer(c: Collector, dataPath: string): Promise<void> {
  const entries = await c.list(dataPath);
  for (const e of entries) {
    if (!e.dir) continue;
    const ws = join(dataPath, e.name);
    c.addFile(join(ws, 'state.vscdb'), true);
    c.addFile(join(ws, 'workspace.json'));
  }
}

function addStoreSession(c: Collector, dir: string): void {
  c.addFile(join(dir, 'store.db'), true);
  c.addFile(join(dir, 'meta.json'));
}

async function walkTranscripts(c: Collector, dir: string, depth: number): Promise<void> {
  const entries = await c.list(dir);
  await Promise.all(
    entries.map(async (e) => {
      if (e.dir) {
        if (depth < MAX_TRANSCRIPT_DEPTH) await walkTranscripts(c, join(dir, e.name), depth + 1);
      } else if (e.name.endsWith('.jsonl')) {
        c.addFile(join(dir, e.name));
      }
    })
  );
}

async function walkStore(c: Collector, root: string): Promise<void> {
  const chats = join(root, 'chats');
  const acp = join(root, 'acp-sessions');
  const projects = join(root, 'projects');
  await Promise.all([
    (async () => {
      const hashes = await c.list(chats);
      await Promise.all(
        hashes
          .filter((h) => h.dir)
          .map(async (h) => {
            const hashDir = join(chats, h.name);
            addStoreSession(c, hashDir); // compact-uuid direct layout
            const sessions = await c.list(hashDir);
            for (const s of sessions) if (s.dir) addStoreSession(c, join(hashDir, s.name));
          })
      );
    })(),
    (async () => {
      const sessions = await c.list(acp);
      for (const s of sessions) if (s.dir) addStoreSession(c, join(acp, s.name));
    })(),
    (async () => {
      const subs = await c.list(projects);
      await Promise.all(
        subs
          .filter((s) => s.dir)
          .map((s) => walkTranscripts(c, join(projects, s.name, 'agent-transcripts'), 0))
      );
    })(),
  ]);
}

function digestOf(files: SourceFileFingerprint[], listingsDigest: string): string {
  const h = createHash('sha256');
  for (const f of files) {
    h.update(`${f.path}\0${f.exists ? 1 : 0}\0${f.size ?? ''}\0${f.mtimeNs ?? ''}\n`);
  }
  h.update(`listings:${listingsDigest}`);
  return h.digest('hex');
}

/** Compute the stat-only fingerprint of every source a scope's direct read depends on. */
export async function computeSourceFingerprint(
  inputs: FingerprintInputs
): Promise<SourceFingerprint> {
  const c = new Collector();
  if (inputs.globalDbPath) c.addFile(inputs.globalDbPath, true);
  await Promise.all([
    inputs.dataPath ? walkComposer(c, inputs.dataPath) : Promise.resolve(),
    inputs.storeRoot ? walkStore(c, inputs.storeRoot) : Promise.resolve(),
  ]);
  const paths = [...c.files].sort(cmp);
  const files = await Promise.all(paths.map((p) => c.stat(p)));
  const lh = createHash('sha256');
  for (const key of [...c.listings.keys()].sort(cmp)) {
    lh.update(`${key}\0${c.listings.get(key)}\0\0`);
  }
  const listingsDigest = lh.digest('hex');
  return { files, listingsDigest, digest: digestOf(files, listingsDigest) };
}

/** Number of files that changed, appeared or disappeared; a listing change counts as 1. */
export function countFingerprintChanges(
  before: SourceFingerprint,
  after: SourceFingerprint
): number {
  const prev = new Map(before.files.map((f) => [f.path, f]));
  let changes = before.listingsDigest !== after.listingsDigest ? 1 : 0;
  const seen = new Set<string>();
  for (const f of after.files) {
    seen.add(f.path);
    const p = prev.get(f.path);
    if (!p || p.exists !== f.exists || p.size !== f.size || p.mtimeNs !== f.mtimeNs) changes += 1;
  }
  for (const p of before.files) if (!seen.has(p.path)) changes += 1;
  return changes;
}

/**
 * True when `nowMs` (the time the fingerprint was taken) is at least `settleMs`
 * after the newest observed mtime. A future mtime is never settled.
 */
export function isFingerprintSettled(
  fp: SourceFingerprint,
  nowMs: number,
  settleMs: number = DEFAULT_FINGERPRINT_SETTLE_MS
): boolean {
  let newest = 0;
  for (const f of fp.files) {
    if (f.exists && f.mtimeNs) {
      const ms = Number(BigInt(f.mtimeNs) / 1_000_000n);
      if (ms > newest) newest = ms;
    }
  }
  return nowMs - newest >= settleMs;
}
