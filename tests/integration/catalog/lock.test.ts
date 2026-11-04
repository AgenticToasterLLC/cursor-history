import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSync } from 'esbuild';

import { createCatalogLock } from '../../../src/core/catalog/lock.js';

let work: string;
let bundle: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'catalog-lock-'));
  bundle = join(work, 'lock.mjs');
  buildSync({
    entryPoints: [resolve('src/core/catalog/lock.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
  });
  const bundleUrl = 'file:///' + bundle.replace(/\\/g, '/');
  writeFileSync(
    join(work, 'racer.mjs'),
    [
      `import { createCatalogLock } from ${JSON.stringify(bundleUrl)};`,
      'const [store, digest, hold, startAtText] = process.argv.slice(2);',
      'const startAt = Number(startAtText);',
      'while (Date.now() < startAt) {}',
      'const h = createCatalogLock(store).tryAcquire(digest, 60000);',
      "console.log(h ? 'WON' : 'LOST');",
      'if (h) { await new Promise((r) => setTimeout(r, Number(hold))); h.release(); }',
      '',
    ].join('\n')
  );
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

const lockPath = (store: string, d: string) => join(`${store}.locks`, `${d}.lock`);

function race(store: string, n: number): Promise<string[]> {
  const startAt = Date.now() + 1500;
  return Promise.all(
    Array.from(
      { length: n },
      () =>
        new Promise<string>((res, rej) => {
          const c = spawn(
            process.execPath,
            [join(work, 'racer.mjs'), store, 'race', '800', String(startAt)],
            { stdio: ['ignore', 'pipe', 'inherit'] }
          );
          let out = '';
          c.stdout.on('data', (d) => (out += d));
          c.on('error', rej);
          c.on('close', () => res(out.trim()));
        })
    )
  );
}

describe('catalog lock', () => {
  it('acquires, contends and releases', () => {
    const store = join(work, 'a.sqlite');
    const lock = createCatalogLock(store);
    const h = lock.tryAcquire('d1', 60_000)!;
    expect(h).toBeDefined();
    const body = JSON.parse(readFileSync(lockPath(store, 'd1'), 'utf8'));
    expect(body.pid).toBe(process.pid);
    expect(body.hostname).toBe(hostname());
    expect(lock.tryAcquire('d1', 60_000)).toBeUndefined();
    expect(lock.tryAcquire('d2', 60_000)).toBeDefined();
    h.release();
    expect(lock.tryAcquire('d1', 60_000)).toBeDefined();
  });

  it('recovers a lock held by a dead pid', () => {
    const store = join(work, 'b.sqlite');
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
    const deadPid = Number(child.stdout.toString());
    mkdirSync(`${store}.locks`, { recursive: true });
    writeFileSync(
      lockPath(store, 'd'),
      JSON.stringify({ pid: deadPid, hostname: hostname(), startedAt: Date.now() })
    );
    const h = createCatalogLock(store).tryAcquire('d', 60_000);
    expect(h).toBeDefined();
    expect(JSON.parse(readFileSync(lockPath(store, 'd'), 'utf8')).pid).toBe(process.pid);
  });

  it('recovers a lock older than ttl and does not steal a live one', () => {
    const store = join(work, 'c.sqlite');
    mkdirSync(`${store}.locks`, { recursive: true });
    writeFileSync(
      lockPath(store, 'd'),
      JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: Date.now() - 10_000 })
    );
    const lock = createCatalogLock(store);
    expect(lock.tryAcquire('d', 60_000)).toBeUndefined();
    expect(lock.tryAcquire('d', 1_000)).toBeDefined();
  });

  it('release does not remove a lock it no longer owns', () => {
    const store = join(work, 'd.sqlite');
    const lock = createCatalogLock(store);
    const h = lock.tryAcquire('d', 60_000)!;
    writeFileSync(
      lockPath(store, 'd'),
      JSON.stringify({ pid: 1, hostname: 'other', startedAt: Date.now(), nonce: 'zzz' })
    );
    h.release();
    expect(readdirSync(`${store}.locks`)).toContain('d.lock');
  });

  it('exactly one of several racing processes wins a fresh lock', async () => {
    const results = await race(join(work, 'race.sqlite'), 4);
    expect(results.filter((r) => r === 'WON')).toHaveLength(1);
  }, 30_000);

  it('exactly one racing process recovers a stale lock', async () => {
    const store = join(work, 'race2.sqlite');
    mkdirSync(`${store}.locks`, { recursive: true });
    writeFileSync(
      lockPath(store, 'race'),
      JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: 1 })
    );
    const results = await race(store, 4);
    expect(results.filter((r) => r === 'WON')).toHaveLength(1);
  }, 30_000);
});
