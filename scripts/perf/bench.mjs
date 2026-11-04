#!/usr/bin/env node
// Benchmark harness against the built library (dist/lib/index.js).
//
// Usage: node scripts/perf/bench.mjs [--corpus small|medium|large | --root DIR] [--iterations N]
//          [--trace-sql] [--scenarios a,b,...] [--timeout-min M] [--out FILE] [--session-id UUID] [--workspace PATH]
//
// DIR is a data root containing User/ (a generated corpus or the snapshot). The library is pointed at
// DIR/User/workspaceStorage and CURSOR_STORE_ROOT is pointed at an empty temp dir so the real ~/.cursor
// is never read. Each scenario runs in a FRESH child process: iteration 1 is "cold" (fresh process,
// warm-or-cold OS cache as found), the rest are "warm". Results are content-free.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { emptyStoreDir, loadBetterSqlite3, parseArgs, percentile, perfDir } from './common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const libPath = resolve(here, '..', '..', 'dist', 'lib', 'index.js');
const ALL = ['list-global', 'list-full', 'list-workspace', 'list-unknown-workspace', 'get-session', 'search'];

async function childMain(args) {
  const lib = await import(pathToFileURL(libPath).href);
  const scenario = args.child;
  const iterations = Number(args.iterations ?? 5);
  const dataPath = args['data-path'];
  const base = { dataPath, limit: 20 };
  if (args['diagnostics-config'] && typeof args['diagnostics-config'] === 'string') {
    base.diagnostics = JSON.parse(args['diagnostics-config']);
  }
  const run = {
    'list-global': () => lib.listSessionSummaries({ ...base }),
    'list-full': () => lib.listSessions({ ...base }),
    'list-workspace': () => lib.listSessionSummaries({ ...base, workspace: args.workspace }),
    'list-unknown-workspace': () =>
      lib.listSessionSummaries({ ...base, workspace: 'C:\\definitely\\not\\a\\workspace' }),
    'get-session': () => lib.getSession(args['session-id'], { dataPath }),
    search: () => lib.searchSessions(args.query ?? 'function', { ...base }),
  }[scenario];
  const times = [];
  let resultCount = null;
  let error = null;
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    try {
      const r = await run();
      resultCount = Array.isArray(r) ? r.length : (r?.pagination?.total ?? (r ? 1 : 0));
    } catch (err) {
      error = `${err?.name ?? 'Error'}: ${String(err?.message ?? err).slice(0, 80)}`;
      times.push(performance.now() - t0);
      break;
    }
    times.push(performance.now() - t0);
  }
  const mem = process.memoryUsage();
  console.log(
    `RESULT ${JSON.stringify({
      scenario,
      times,
      resultCount,
      error,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
      heapUsedBytes: mem.heapUsed,
    })}`
  );
}

function runChild(childArgs, timeoutMs, traceSql) {
  return new Promise((resolveRun) => {
    const preload = traceSql ? ['--import', pathToFileURL(join(here, 'sql-trace.mjs')).href] : [];
    const child = spawn(process.execPath, [...preload, fileURLToPath(import.meta.url), ...childArgs], {
      env: { ...process.env, CURSOR_STORE_ROOT: emptyStoreDir() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', () => {});
    child.on('close', () => {
      clearTimeout(timer);
      const line = out.split('\n').find((l) => l.startsWith('RESULT '));
      const trace = out.split('\n').find((l) => l.startsWith('SQLTRACE '));
      const parsed = line ? JSON.parse(line.slice(7)) : { error: 'no result' };
      if (trace) parsed.sqlTrace = JSON.parse(trace.slice(9));
      resolveRun(timedOut ? { timedOut: true } : parsed);
    });
  });
}

function stats(times) {
  const warm = times.slice(1);
  const s = [...times].sort((a, b) => a - b);
  const w = [...warm].sort((a, b) => a - b);
  const r = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);
  return {
    iterations: times.length,
    coldMs: r(times[0]),
    warmP50Ms: r(percentile(w, 50)),
    warmP95Ms: r(percentile(w, 95)),
    p50Ms: r(percentile(s, 50)),
    p95Ms: r(percentile(s, 95)),
    maxMs: r(s[s.length - 1]),
  };
}

function pickSnapshotIds(userDir) {
  // Content stays local to this process; only counts/timings are reported.
  const out = {};
  const gdb = join(userDir, 'globalStorage', 'state.vscdb');
  if (existsSync(gdb)) {
    const Database = loadBetterSqlite3();
    const db = new Database(gdb, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare("SELECT substr(key, 14) AS id FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;' LIMIT 1")
        .get();
      out.sessionId = row?.id;
    } finally {
      db.close();
    }
  }
  return out;
}

async function parentMain(args) {
  const root = args.root ?? join(perfDir(), `corpus-${args.corpus ?? 'small'}`);
  const userDir = join(root, 'User');
  const dataPath = join(userDir, 'workspaceStorage');
  if (!existsSync(dataPath)) throw new Error(`no data root at ${root}; run perf:corpus first`);
  const iterations = Number(args.iterations ?? 5);
  const scenarios = args.scenarios ? String(args.scenarios).split(',') : ALL;
  const timeoutMs = Number(args['timeout-min'] ?? 30) * 60_000;

  let sessionId = args['session-id'];
  let workspace = args.workspace;
  const manifestPath = join(root, 'corpus-manifest.json');
  if (existsSync(manifestPath)) {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    sessionId ??= m.sampleComposerId;
    workspace ??= m.sampleWorkspacePath;
  }
  sessionId ??= pickSnapshotIds(userDir).sessionId;

  const dts = join(here, '..', '..', 'dist', 'lib', 'types.d.ts');
  const diagnosticsSupported = existsSync(dts) && /^\s+diagnostics\??:/mu.test(readFileSync(dts, 'utf8'));

  const results = {
    root: args.root ? '<custom root>' : `corpus-${args.corpus ?? 'small'}`,
    node: process.version,
    cpu: cpus()[0]?.model,
    cpuCount: cpus().length,
    totalMemBytes: totalmem(),
    iterations,
    diagnosticsSupported,
    startedAt: new Date().toISOString(),
    scenarios: {},
  };
  if (diagnosticsSupported && !args['diagnostics-config']) {
    console.log('note: config.diagnostics exists; pass --diagnostics-config <json> to enable it (shape owned by that workstream)');
  }

  for (const scenario of scenarios) {
    if (scenario === 'list-workspace' && !workspace) {
      results.scenarios[scenario] = { skipped: 'no workspace known (pass --workspace)' };
      continue;
    }
    if (scenario === 'get-session' && !sessionId) {
      results.scenarios[scenario] = { skipped: 'no session id known (pass --session-id)' };
      continue;
    }
    const childArgs = ['--child', scenario, '--iterations', String(iterations), '--data-path', dataPath];
    if (workspace) childArgs.push('--workspace', workspace);
    if (sessionId) childArgs.push('--session-id', sessionId);
    if (args.query) childArgs.push('--query', String(args.query));
    if (args['diagnostics-config']) childArgs.push('--diagnostics-config', String(args['diagnostics-config']));
    const t0 = Date.now();
    const res = await runChild(childArgs, timeoutMs, Boolean(args['trace-sql']));
    if (res.timedOut) {
      results.scenarios[scenario] = { timedOut: true, timeoutMin: timeoutMs / 60_000 };
    } else if (res.times) {
      results.scenarios[scenario] = {
        ...stats(res.times),
        resultCount: res.resultCount,
        error: res.error,
        peakRssMb: Math.round(res.maxRssBytes / 1048576),
        wallMs: Date.now() - t0,
        ...(res.sqlTrace ? { sqlTrace: res.sqlTrace } : {}),
      };
    } else {
      results.scenarios[scenario] = { error: res.error };
    }
    const { sqlTrace: _trace, ...brief } = results.scenarios[scenario];
    console.log(`${scenario.padEnd(24)} ${JSON.stringify(brief)}`);
  }

  const outFile = args.out ?? join(perfDir(), 'results', `bench-${args.root ? 'custom' : (args.corpus ?? 'small')}-${Date.now()}.json`);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(`results written to ${outFile}`);
}

const args = parseArgs(process.argv.slice(2));
if (args.child) await childMain(args);
else await parentMain(args);
