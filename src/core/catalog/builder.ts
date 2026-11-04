import { dirname, join } from 'node:path';
import type {
  CatalogScopeKey,
  CatalogSnapshotHeader,
  IndexerRequest,
  IndexerResponse,
} from './contract.js';
import { resolveCatalogDeps, type CatalogDeps } from './deps.js';
import type { LibraryConfig } from '../../lib/types.js';

export interface BuildCatalogOptions {
  signal?: AbortSignal;
  /** Test/merge seam; production defaults are resolved by deps.ts. */
  deps?: Partial<CatalogDeps>;
  onProgress?: (phase: string) => void;
}

const BUILDER_KEYS = [
  'openCatalogStore',
  'computeSourceFingerprint',
  'digestScopeKey',
  'listSessionSummaries',
] as const;

function failure(jobId: string, code: string): IndexerResponse {
  // Content-free: never include paths, titles or raw error text.
  return { type: 'failed', jobId, code, message: `Catalog build failed (${code}).` };
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code;
  if ((error as { name?: unknown } | null)?.name === 'AbortError') return 'BUILD_ABORTED';
  return 'BUILD_FAILED';
}

function readConfigFor(request: IndexerRequest, signal?: AbortSignal): LibraryConfig {
  const key: CatalogScopeKey = request.scopeKey;
  const rc = request.readConfig;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const config: LibraryConfig = {
    dataPath: str(rc['dataPath']) ?? key.dataPath ?? undefined,
    backupPath: str(rc['backupPath']),
    workspace: str(rc['workspace']) ?? key.workspace ?? undefined,
    includeCrossWorkspaceSources: key.includeCrossWorkspaceSources,
    signal,
  };
  // Pass the caller's original override (not the resolved key form, which
  // includes policyVersion and every field and is rejected by config
  // validation). The key was derived deterministically from this same
  // override, so the read reproduces exactly the limits the key records.
  if (rc['sourceReadLimits'] !== undefined && rc['sourceReadLimits'] !== null) {
    config.sourceReadLimits = rc['sourceReadLimits'] as LibraryConfig['sourceReadLimits'];
  }
  const driver = str(rc['sqliteDriver']);
  if (driver) config.sqliteDriver = driver as LibraryConfig['sqliteDriver'];
  return config;
}

/**
 * Build and publish one scope snapshot in the current thread.
 * Order: fingerprint -> direct read -> publish (so changes during the read yield stale, never falsely ready).
 */
export async function buildCatalogSnapshot(
  request: IndexerRequest,
  options: BuildCatalogOptions = {}
): Promise<IndexerResponse> {
  const started = Date.now();
  const { jobId } = request;
  let scopeDigest = '';
  let store: ReturnType<CatalogDeps['openCatalogStore']> | undefined;
  try {
    const deps = await resolveCatalogDeps(options.deps, BUILDER_KEYS);
    options.signal?.throwIfAborted();
    const digest = deps.digestScopeKey(request.scopeKey);
    scopeDigest = digest;
    await deps.ensureCatalogDriver?.();
    store = deps.openCatalogStore({ path: request.storePath });

    options.onProgress?.('fingerprint');
    const dataPath = request.scopeKey.dataPath;
    const fingerprint = await deps.computeSourceFingerprint({
      dataPath,
      globalDbPath: dataPath ? join(dirname(dataPath), 'globalStorage', 'state.vscdb') : null,
      storeRoot: request.scopeKey.storeRoot,
    });
    options.signal?.throwIfAborted();

    options.onProgress?.('reading');
    const diagnostics: unknown[] = [];
    const config = readConfigFor(request, options.signal);
    config.onDiagnostic = (d) => {
      diagnostics.push(d);
    };
    // No limit/offset: the library defaults to limit=MAX_SAFE_INTEGER, offset=0, i.e. the whole
    // catalog from ONE storage call (one source snapshot, direct order).
    const result = await deps.listSessionSummaries({ ...config, catalog: 'direct' });
    options.signal?.throwIfAborted();

    const rows = result.data;
    const header: Omit<CatalogSnapshotHeader, 'snapshotId'> = {
      scopeKeyDigest: digest,
      scopeKey: request.scopeKey,
      fingerprint,
      builtAt: new Date().toISOString(),
      buildMs: Date.now() - started,
      rowCount: rows.length,
      diagnosticsJson: JSON.stringify(diagnostics),
      scopeJson: result.scope ? JSON.stringify(result.scope) : null,
    };
    options.onProgress?.('publishing');
    const snapshotId = store.publishSnapshot(
      header,
      (function* () {
        for (const row of rows) yield JSON.stringify(row);
      })()
    );
    return {
      type: 'done',
      jobId,
      snapshotId,
      rowCount: rows.length,
      buildMs: Date.now() - started,
    };
  } catch (error) {
    const code = codeOf(error);
    try {
      // Best effort: C1 store records the last error per scope (content-free code only).
      (
        store as { recordScopeError?: (d: string, c: string) => void } | undefined
      )?.recordScopeError?.(scopeDigest, code);
    } catch {
      /* ignore */
    }
    return failure(jobId, code);
  } finally {
    try {
      store?.close();
    } catch {
      /* ignore */
    }
  }
}
