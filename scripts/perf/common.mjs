// Shared helpers for the perf harness. Content-free: never logs message text, titles or paths of user data.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const require = createRequire(import.meta.url);

export function perfDir() {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share');
  return process.env.CURSOR_HISTORY_PERF_DIR ?? join(base, 'cursor-history-perf');
}

export function loadBetterSqlite3() {
  return require('better-sqlite3');
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
      else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

/** An empty directory used as the Store root so the real ~/.cursor is never read. */
export function emptyStoreDir() {
  return join(tmpdir(), 'cursor-history-perf-empty-store');
}

export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}
