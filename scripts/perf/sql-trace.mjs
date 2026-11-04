// Preload (node --import) that times every SQLite statement execution (node:sqlite and better-sqlite3)
// by normalized SQL text. Prints one `SQLTRACE {json}` line at exit: per-statement call count,
// total ms, max ms and rows returned. Content-free: only the library's own SQL text is recorded,
// never parameters or results.
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '..', '..', 'package.json'));
const stats = new Map();

function norm(sql) {
  return String(sql).replace(/\s+/gu, ' ').trim().slice(0, 140);
}

function record(sql, dt, result) {
  const key = norm(sql);
  const s = stats.get(key) ?? { calls: 0, totalMs: 0, maxMs: 0, rows: 0 };
  s.calls++;
  s.totalMs += dt;
  s.maxMs = Math.max(s.maxMs, dt);
  s.rows += Array.isArray(result) ? result.length : result ? 1 : 0;
  stats.set(key, s);
}

try {
  const { StatementSync } = require('node:sqlite');
  for (const method of ['all', 'get', 'run']) {
    const original = StatementSync.prototype[method];
    StatementSync.prototype[method] = function patched(...args) {
      const t0 = performance.now();
      const result = original.apply(this, args);
      record(this.sourceSQL, performance.now() - t0, result);
      return result;
    };
  }
} catch {
  /* node:sqlite unavailable */
}

try {
  const Database = require('better-sqlite3');
  const originalPrepare = Database.prototype.prepare;
  Database.prototype.prepare = function patchedPrepare(sql, ...rest) {
    const stmt = originalPrepare.call(this, sql, ...rest);
    for (const method of ['all', 'get', 'run']) {
      const original = stmt[method];
      stmt[method] = function patched(...args) {
        const t0 = performance.now();
        const result = original.apply(this, args);
        record(sql, performance.now() - t0, result);
        return result;
      };
    }
    return stmt;
  };
} catch {
  /* better-sqlite3 unavailable */
}

process.on('exit', () => {
  const rows = [...stats.entries()]
    .map(([sql, s]) => ({ sql, calls: s.calls, totalMs: Math.round(s.totalMs), maxMs: Math.round(s.maxMs), rows: s.rows }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 25);
  console.log(`SQLTRACE ${JSON.stringify(rows)}`);
});
