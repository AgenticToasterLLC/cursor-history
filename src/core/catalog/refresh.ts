import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, type ResourceLimits } from 'node:worker_threads';
import type {
  CreateCatalogLock,
  DigestScopeKey,
  IndexerRequest,
  IndexerResponse,
} from './contract.js';
import { getRegisteredModules, registerCatalogModules } from './deps.js';
import { createCatalogLock } from './lock.js';
import { digestScopeKey } from './scope-key.js';

// requestCatalogRefresh is synchronous, so its C1 dependencies are wired
// statically (both modules are pure Node builtins). Tests may still override
// them through registerCatalogModules or options.deps.
registerCatalogModules({ createCatalogLock, digestScopeKey });

export interface RefreshOptions {
  deps?: { createCatalogLock?: CreateCatalogLock; digestScopeKey?: DigestScopeKey };
  /** Override the worker script (tests). */
  workerPath?: string;
  /** Minimum ms between the end of one build and the start of the next for a scope. Default 10000. */
  minIntervalMs?: number;
  /** Bypass the rate limit. */
  force?: boolean;
  lockTtlMs?: number;
  resourceLimits?: ResourceLimits;
  /** Passed to the worker; test hook for injecting deps from a module. */
  testDepsModule?: string;
}

export interface RefreshResult {
  jobId: string;
  alreadyRunning: boolean;
  /** True when skipped because the previous build for the scope finished too recently. */
  rateLimited?: boolean;
}

interface Running {
  jobId: string;
  worker: Worker;
  release: () => void;
  promise: Promise<IndexerResponse>;
  settle: (r: IndexerResponse) => void;
  final?: IndexerResponse;
  cancelled: boolean;
  finished: boolean;
}

const DEFAULT_MIN_INTERVAL_MS = 10_000;
const DEFAULT_LOCK_TTL_MS = 10 * 60_000;
const DEFAULT_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: 1024,
  maxYoungGenerationSizeMb: 64,
};

const running = new Map<string, Running>();
const lastFinished = new Map<string, number>();
const lastErrors = new Map<string, { code: string; at: string }>();
const errorListeners = new Set<(digest: string, error: { code: string; at: string }) => void>();
const storePaths = new Map<string, string>();
let exitHookInstalled = false;

/** Last build error recorded for a scope (read by C3 status). Cleared by a later success. */
export function getCatalogRefreshLastError(
  scopeKeyDigest: string
): { code: string; at: string } | undefined {
  return lastErrors.get(scopeKeyDigest);
}

export function onCatalogRefreshError(
  listener: (digest: string, error: { code: string; at: string }) => void
): () => void {
  errorListeners.add(listener);
  return () => errorListeners.delete(listener);
}

/**
 * Persist a refresh failure (worker crash, termination, start failure) as the scope's
 * `lastError` in the sidecar so `getCatalogStatus` reports it. Best effort: it only touches a
 * store file that already exists, and never throws.
 */
async function persistRefreshError(
  digest: string,
  error: { code: string; at: string }
): Promise<void> {
  const storePath = storePaths.get(digest);
  if (!storePath || !existsSync(storePath)) return;
  try {
    const { openCatalogStoreAsync } = await import('./store.js');
    const store = await openCatalogStoreAsync({ path: storePath });
    try {
      (
        store as { recordScopeError?: (d: string, c: string, at: string) => void }
      ).recordScopeError?.(digest, error.code, error.at);
    } finally {
      store.close();
    }
  } catch {
    /* advisory */
  }
}

onCatalogRefreshError((digest, error) => {
  void persistRefreshError(digest, error);
});

function recordRefreshError(digest: string, code: string): void {
  const err = { code, at: new Date().toISOString() };
  lastErrors.set(digest, err);
  for (const l of errorListeners) {
    try {
      l(digest, err);
    } catch {
      /* ignore */
    }
  }
}

export function isCatalogRefreshRunning(scopeKeyDigest: string): boolean {
  return running.has(scopeKeyDigest);
}

/** Test helper: forget rate-limit and error state. */
export function resetCatalogRefreshState(): void {
  lastFinished.clear();
  lastErrors.clear();
}

function resolveWorkerPath(): string {
  // CJS output: __dirname exists. ESM output: derive this module's URL from the stack,
  // because `import.meta` cannot be compiled by the CommonJS build (tsconfig.cjs.json).
  if (typeof __dirname !== 'undefined') return join(__dirname, 'catalog-worker.js');
  const stack = new Error().stack ?? '';
  const match = /(file:\/\/\/[^\s)]*?refresh\.js):\d+:\d+/.exec(stack);
  if (!match?.[1]) throw new Error('Cannot locate catalog worker');
  return fileURLToPath(new URL('./catalog-worker.js', match[1]));
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const r of running.values()) {
      try {
        r.release();
      } catch {
        /* ignore */
      }
    }
  });
}

function resolveSyncDeps(o: RefreshOptions): { lock: CreateCatalogLock; digest: DigestScopeKey } {
  const reg = getRegisteredModules();
  const lock = o.deps?.createCatalogLock ?? reg.createCatalogLock;
  const digest = o.deps?.digestScopeKey ?? reg.digestScopeKey;
  if (!lock || !digest) {
    throw Object.assign(new Error('Catalog modules are not registered'), {
      code: 'CATALOG_UNAVAILABLE',
    });
  }
  return { lock, digest };
}

function finalize(digest: string, r: Running, fallback: IndexerResponse): void {
  if (r.finished) return;
  r.finished = true;
  const result = r.final ?? fallback;
  try {
    r.release();
  } catch {
    /* ignore */
  }
  if (running.get(digest) === r) running.delete(digest);
  lastFinished.set(digest, Date.now());
  if (result.type === 'failed') {
    recordRefreshError(digest, result.code);
  } else if (result.type === 'done') {
    lastErrors.delete(digest);
  }
  r.settle(result);
}

export function requestCatalogRefresh(
  request: Omit<IndexerRequest, 'type' | 'jobId'>,
  options: RefreshOptions = {}
): RefreshResult {
  const { lock: createLock, digest: digestOf } = resolveSyncDeps(options);
  const digest = digestOf(request.scopeKey);
  storePaths.set(digest, request.storePath);

  const existing = running.get(digest);
  if (existing) return { jobId: existing.jobId, alreadyRunning: true };

  const minInterval = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const last = lastFinished.get(digest);
  const jobId = randomUUID();
  if (!options.force && last !== undefined && Date.now() - last < minInterval) {
    return { jobId, alreadyRunning: false, rateLimited: true };
  }

  const handle = createLock(request.storePath).tryAcquire(
    digest,
    options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS
  );
  if (!handle) return { jobId, alreadyRunning: true };

  let settle!: (r: IndexerResponse) => void;
  const promise = new Promise<IndexerResponse>((res) => (settle = res));
  const failedResp = (code: string): IndexerResponse => ({
    type: 'failed',
    jobId,
    code,
    message: `Catalog build failed (${code}).`,
  });

  let worker: Worker;
  try {
    worker = new Worker(options.workerPath ?? resolveWorkerPath(), {
      workerData: {
        request: { ...request, type: 'build', jobId },
        testDepsModule: options.testDepsModule,
      },
      resourceLimits: options.resourceLimits ?? DEFAULT_LIMITS,
    });
  } catch {
    handle.release();
    lastFinished.set(digest, Date.now());
    recordRefreshError(digest, 'WORKER_START_FAILED');
    return { jobId, alreadyRunning: false };
  }

  const r: Running = {
    jobId,
    worker,
    release: () => handle.release(),
    promise,
    settle,
    cancelled: false,
    finished: false,
  };
  running.set(digest, r);
  installExitHook();

  worker.on('message', (m: IndexerResponse) => {
    if (m && (m.type === 'done' || m.type === 'failed')) r.final = m;
  });
  let errored = false;
  worker.on('error', () => {
    errored = true;
  });
  worker.on('exit', (code) => {
    finalize(
      digest,
      r,
      failedResp(
        r.cancelled
          ? 'BUILD_CANCELLED'
          : errored
            ? 'WORKER_CRASHED'
            : code !== 0
              ? 'WORKER_EXIT'
              : 'WORKER_NO_RESULT'
      )
    );
  });
  worker.unref();
  return { jobId, alreadyRunning: false };
}

export async function waitForCatalogBuild(
  scopeKeyDigest: string,
  timeoutMs: number
): Promise<IndexerResponse | undefined> {
  const r = running.get(scopeKeyDigest);
  if (!r) return undefined;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((res) => {
    timer = setTimeout(() => res(undefined), timeoutMs);
  });
  try {
    return await Promise.race([r.promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function cancelCatalogRefreshes(): Promise<void> {
  const all = [...running.entries()];
  await Promise.all(
    all.map(async ([digest, r]) => {
      r.cancelled = true;
      try {
        await r.worker.terminate();
      } catch {
        /* ignore */
      }
      finalize(digest, r, {
        type: 'failed',
        jobId: r.jobId,
        code: 'BUILD_CANCELLED',
        message: 'Catalog build failed (BUILD_CANCELLED).',
      });
    })
  );
}
