/**
 * Library read path over the sidecar catalog (C3).
 *
 * The catalog is a disposable cache of the exact rows `listSessionSummaries`
 * produced for one scope. This module decides whether a stored snapshot may
 * serve a request, discloses that decision, and otherwise falls back to the
 * direct reader. A catalog problem NEVER fails a read.
 *
 * State machine (mode x snapshot):
 *   ready   (digest equal && settled)  auto/strict -> rows, state 'ready', complete true
 *   stale   (digest differs/unsettled) auto   -> old rows, 'stale', complete false, refresh requested
 *                                      strict -> sync build then 'ready'; direct + 'degraded' on failure
 *   missing                            auto   -> direct read, 'building', complete true, refresh requested
 *                                      strict -> sync build then 'ready'; direct + 'degraded' on failure
 *   any catalog error                  -> direct read, 'degraded', complete true, reason code
 *   backupPath/readContext/diagnostics/ioObserver -> direct read, 'unavailable'
 */
import { dirname, normalize, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mergeWithDefaults } from '../../lib/config.js';
import {
  findStoreRoot,
  getCursorDataPath,
  getGlobalStoragePath,
  normalizePath,
  resolveStoreRoot,
} from '../../lib/platform.js';
import type {
  CatalogInfo,
  LibraryConfig,
  PaginatedResult,
  SessionSummary,
} from '../../lib/types.js';
import { resolveSourceReadLimits } from '../source-read-limits.js';
import { normalizeWorkspacePath } from '../workspace-scope.js';
import { PACKAGE_VERSION } from '../package-version.generated.js';
import type { SessionDiagnostic, WorkspaceScopeResolution } from '../types.js';
import {
  CATALOG_PROJECTION_EPOCH,
  CATALOG_SCHEMA_VERSION,
  type CatalogMode,
  type CatalogScopeKey,
  type CatalogSnapshotHeader,
  type CatalogState,
  type CatalogStatus,
  type FingerprintInputs,
  type IndexerRequest,
  type SourceFingerprint,
} from './contract.js';
import type { CatalogDeps, CatalogStore } from './catalog-deps.js';

type Summaries = PaginatedResult<SessionSummary>;
type DirectReader = (config?: LibraryConfig) => Promise<Summaries>;

/** Why a config cannot use the catalog, or undefined when eligible. */
export function catalogIneligibleReason(config: LibraryConfig | undefined): string | undefined {
  if (config?.backupPath !== undefined) return 'backupPath';
  if (config?.readContext !== undefined) return 'readContext';
  if (config?.diagnostics !== undefined) return 'diagnostics';
  if ((config as { ioObserver?: unknown } | undefined)?.ioObserver !== undefined) {
    return 'ioObserver';
  }
  return undefined;
}

/** Everything derived from a config that identifies and rebuilds one scope. */
export interface ResolvedCatalogScope {
  scopeKey: CatalogScopeKey;
  digest: string;
  inputs: FingerprintInputs;
  readConfig: Record<string, unknown>;
  storePath: string;
}

/** Build the scope key, fingerprint inputs and serializable read config. */
export function resolveCatalogScope(
  config: LibraryConfig | undefined,
  deps: CatalogDeps
): ResolvedCatalogScope {
  const rawData = getCursorDataPath(config?.dataPath);
  const storeOnly = findStoreRoot(rawData) !== null;
  const dataPath = storeOnly ? null : normalize(resolve(normalizePath(rawData)));
  const storeRoot = normalize(resolveStoreRoot(config?.dataPath));
  const limits = { ...resolveSourceReadLimits(config?.sourceReadLimits) } as unknown as Record<
    string,
    number
  >;
  const scopeKey: CatalogScopeKey = {
    dataPath,
    storeRoot,
    workspace: config?.workspace !== undefined ? normalizeWorkspacePath(config.workspace) : null,
    includeCrossWorkspaceSources: config?.includeCrossWorkspaceSources ?? false,
    sourceReadLimits: limits,
    schemaVersion: CATALOG_SCHEMA_VERSION,
    projectionEpoch: CATALOG_PROJECTION_EPOCH,
    readerVersion: PACKAGE_VERSION,
    ...(config?.searchIndex === true ? { searchIndex: true as const } : {}),
  };
  const inputs: FingerprintInputs = {
    dataPath,
    globalDbPath: dataPath
      ? normalize(join(getGlobalStoragePath(config?.dataPath), 'state.vscdb'))
      : null,
    storeRoot,
  };
  const readConfig: Record<string, unknown> = {
    ...(config?.dataPath !== undefined ? { dataPath: config.dataPath } : {}),
    ...(config?.workspace !== undefined ? { workspace: config.workspace } : {}),
    includeCrossWorkspaceSources: scopeKey.includeCrossWorkspaceSources,
    ...(config?.sourceReadLimits !== undefined
      ? { sourceReadLimits: config.sourceReadLimits }
      : {}),
    ...(config?.sqliteDriver !== undefined ? { sqliteDriver: config.sqliteDriver } : {}),
  };
  return {
    scopeKey,
    digest: deps.digestScopeKey(scopeKey),
    inputs,
    readConfig,
    storePath: config?.catalogPath ?? deps.defaultCatalogPath(),
  };
}

/** @internal */
export async function openStore(
  config: LibraryConfig | undefined,
  deps: CatalogDeps
): Promise<CatalogStore> {
  return deps.openCatalogStore(
    config?.catalogPath !== undefined ? { path: config.catalogPath } : {}
  );
}

/** Content-free reason: an upper-snake error code, else a fixed token. */
/** @internal */
export function reasonOf(error: unknown): string {
  const reason = (error as { reason?: unknown } | null)?.reason;
  if (typeof reason === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(reason)) return reason;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : 'CATALOG_ERROR';
}

// In-process record of refreshes this process requested, for status reporting.
const requestedAt = new Map<string, number>();
const BUILDING_TTL_MS = 2 * 60_000;

/**
 * Request a background refresh and describe the outcome for `CatalogInfo`. A rate-limited
 * request runs nothing, so it is reported as not scheduled plus `refreshRateLimited`.
 * @internal
 */
export function requestRefreshInfo(
  deps: CatalogDeps,
  scope: ResolvedCatalogScope
): Pick<CatalogInfo, 'refreshScheduled' | 'refreshRateLimited'> {
  try {
    const handle = deps.requestCatalogRefresh({
      scopeKey: scope.scopeKey,
      readConfig: scope.readConfig,
      storePath: scope.storePath,
    });
    if (handle.rateLimited === true) return { refreshScheduled: false, refreshRateLimited: true };
    requestedAt.set(scope.digest, Date.now());
    return { refreshScheduled: true };
  } catch {
    return { refreshScheduled: false };
  }
}

/** @internal */
export function requestRefresh(deps: CatalogDeps, scope: ResolvedCatalogScope): boolean {
  return requestRefreshInfo(deps, scope).refreshScheduled === true;
}

/** Longest a strict read waits for an unchanged fingerprint to settle after a build. */
const SETTLE_WAIT_MAX_MS = 3000;
const SETTLE_POLL_MS = 200;

/**
 * Strict mode, after a build: re-fingerprint and look the snapshot up. When the sources are
 * unchanged since the build but still inside the settle window (recently written), wait it out
 * (bounded by 3 s, polling) and serve `ready`; report not-ready only when the sources really
 * changed again or the bounded wait expired.
 * @internal
 */
export async function lookupAfterBuild(
  store: CatalogStore,
  deps: CatalogDeps,
  scope: ResolvedCatalogScope
): Promise<Lookup> {
  const deadline = Date.now() + SETTLE_WAIT_MAX_MS;
  for (;;) {
    const current = await deps.computeSourceFingerprint(scope.inputs);
    const found = lookup(store, deps, scope, current);
    const unsettledOnly =
      found.kind === 'stale' && found.header.fingerprint.digest === current.digest;
    if (!unsettledOnly || Date.now() >= deadline) return found;
    await new Promise<void>((done) =>
      setTimeout(done, Math.min(SETTLE_POLL_MS, Math.max(1, deadline - Date.now())))
    );
  }
}

/** @internal */
export type Lookup =
  | { kind: 'ready'; header: CatalogSnapshotHeader }
  | { kind: 'stale'; header: CatalogSnapshotHeader; changedSources: number }
  | { kind: 'missing' };

/** @internal */
export function lookup(
  store: CatalogStore,
  deps: CatalogDeps,
  scope: ResolvedCatalogScope,
  current: SourceFingerprint
): Lookup {
  const header = store.getSnapshotHeader(scope.digest);
  if (!header) return { kind: 'missing' };
  if (header.fingerprint.digest === current.digest && deps.isFingerprintSettled(current)) {
    return { kind: 'ready', header };
  }
  return {
    kind: 'stale',
    header,
    changedSources: Math.max(1, deps.countFingerprintChanges(header.fingerprint, current)),
  };
}

function serveRows(
  store: CatalogStore,
  header: CatalogSnapshotHeader,
  config: LibraryConfig | undefined,
  info: CatalogInfo
): Summaries {
  const { offset, limit } = mergeWithDefaults(config);
  const total = header.rowCount;
  const end = Math.min(offset + limit, total);
  const count = Math.max(0, end - offset);
  const raw = count === 0 ? [] : store.readRows(header.snapshotId, offset, count);
  const rows = raw.map((row) => JSON.parse(row) as SessionSummary);
  const diagnostics = JSON.parse(header.diagnosticsJson) as SessionDiagnostic[] | null;
  const scope = header.scopeJson
    ? (JSON.parse(header.scopeJson) as WorkspaceScopeResolution)
    : undefined;
  if (Array.isArray(diagnostics) && config?.onDiagnostic) {
    for (const diagnostic of diagnostics) config.onDiagnostic(diagnostic);
  }
  return {
    data: rows,
    pagination: { total, limit, offset, hasMore: end < total },
    ...(Array.isArray(diagnostics) && diagnostics.length > 0 ? { diagnostics } : {}),
    ...(scope ? { scope } : {}),
    catalog: info,
  };
}

/**
 * Serve `listSessionSummaries` for catalog mode `auto` or `strict`.
 * @param config - Caller config (mode is `config.catalog`).
 * @param deps - Catalog dependencies (production or fakes).
 * @param direct - The direct reader (receives a config with `catalog: 'direct'`).
 * @returns The page with a `catalog` disclosure.
 */
export async function listSummariesViaCatalog(
  config: LibraryConfig | undefined,
  deps: CatalogDeps,
  direct: DirectReader
): Promise<Summaries> {
  const mode = (config?.catalog ?? 'direct') as CatalogMode;
  mergeWithDefaults(config); // surface InvalidConfigError exactly as direct does
  const runDirect = async (info: CatalogInfo): Promise<Summaries> => ({
    ...(await direct({ ...config, catalog: 'direct' })),
    catalog: info,
  });
  const ineligible = catalogIneligibleReason(config);
  if (ineligible) {
    return runDirect({ state: 'unavailable', complete: true, reason: ineligible });
  }

  let served: Summaries | undefined;
  let fallback: CatalogInfo | undefined;
  let scope: ResolvedCatalogScope | undefined;
  let store: CatalogStore | undefined;
  try {
    scope = resolveCatalogScope(config, deps);
    store = await openStore(config, deps);
    const current = await deps.computeSourceFingerprint(scope.inputs);
    let found = lookup(store, deps, scope, current);

    if (found.kind !== 'ready' && mode === 'strict') {
      const response = await deps.buildCatalogSnapshot({
        type: 'build',
        jobId: randomUUID(),
        scopeKey: scope.scopeKey,
        readConfig: scope.readConfig,
        storePath: store.path,
      } satisfies IndexerRequest);
      if (response.type === 'failed') {
        fallback = { state: 'degraded', complete: true, reason: reasonOf(response) };
      } else {
        found = await lookupAfterBuild(store, deps, scope);
        if (found.kind !== 'ready') {
          fallback = { state: 'degraded', complete: true, reason: 'CHANGED_DURING_BUILD' };
        }
      }
    }

    if (!fallback) {
      if (found.kind === 'ready') {
        const verifiedAt = new Date().toISOString();
        served = serveRows(store, found.header, config, {
          state: 'ready',
          complete: true,
          snapshotBuiltAt: found.header.builtAt,
          verifiedAt,
        });
        try {
          store.touchVerified(found.header.snapshotId, verifiedAt);
        } catch {
          // verification time is advisory
        }
      } else if (found.kind === 'stale') {
        served = serveRows(store, found.header, config, {
          state: 'stale',
          complete: false,
          snapshotBuiltAt: found.header.builtAt,
          changedSources: found.changedSources,
          ...requestRefreshInfo(deps, scope),
        });
      } else {
        fallback = { state: 'building', complete: true, refreshScheduled: false };
      }
    }
  } catch (error) {
    served = undefined;
    fallback = { state: 'degraded', complete: true, reason: reasonOf(error) };
  } finally {
    try {
      store?.close();
    } catch {
      // ignore close failures
    }
  }

  if (served) return served;
  const info = fallback ?? { state: 'degraded' as CatalogState, complete: true };
  const result = await runDirect(info);
  if (info.state === 'building' && scope) {
    // Request after the direct read so the worker does not compete with it.
    result.catalog = { ...info, ...requestRefreshInfo(deps, scope) };
  }
  return result;
}

/** Optional C1 accessors beyond the contract store. */
interface ExtendedStore extends CatalogStore {
  getScopeState?: (
    digest: string
  ) => { verifiedAt?: string; lastError?: { code: string; at: string } } | undefined;
  listSnapshotHeaders?: () => CatalogSnapshotHeader[];
}

/**
 * Report catalog status for every scope in the sidecar plus the config's own scope (content-free).
 * @param config - Optional config identifying the current scope and catalog path.
 * @param deps - Catalog dependencies.
 * @returns Status; `enabled` is false when the sidecar cannot be opened.
 */
export async function readCatalogStatus(
  config: LibraryConfig | undefined,
  deps: CatalogDeps
): Promise<CatalogStatus> {
  mergeWithDefaults(config);
  const base = {
    schemaVersion: CATALOG_SCHEMA_VERSION as number,
    projectionEpoch: CATALOG_PROJECTION_EPOCH as number,
  };
  let store: ExtendedStore | undefined;
  try {
    const own = resolveCatalogScope(config, deps);
    store = await openStore(config, deps);
    const headers = new Map<string, CatalogSnapshotHeader>();
    try {
      for (const h of store.listSnapshotHeaders?.() ?? []) headers.set(h.scopeKeyDigest, h);
    } catch {
      // fall back to the config's own scope below
    }
    const ownHeader = store.getSnapshotHeader(own.digest);
    if (ownHeader) headers.set(own.digest, ownHeader);

    const scopes: CatalogStatus['scopes'] = [];
    const digests = new Set([...headers.keys(), own.digest]);
    for (const digest of digests) {
      const header = headers.get(digest);
      const at = requestedAt.get(digest);
      let building = at !== undefined && Date.now() - at < BUILDING_TTL_MS;
      let state: CatalogState = building ? 'building' : 'unavailable';
      if (header) {
        try {
          const key = header.scopeKey;
          const current = await deps.computeSourceFingerprint({
            dataPath: key.dataPath,
            globalDbPath: key.dataPath
              ? normalize(join(dirname(key.dataPath), 'globalStorage', 'state.vscdb'))
              : null,
            storeRoot: key.storeRoot,
          });
          state =
            header.fingerprint.digest === current.digest && deps.isFingerprintSettled(current)
              ? 'ready'
              : 'stale';
        } catch {
          state = 'stale';
        }
        if (state === 'ready') building = false;
      }
      let scopeState: ReturnType<NonNullable<ExtendedStore['getScopeState']>>;
      try {
        scopeState = store.getScopeState?.(digest);
      } catch {
        scopeState = undefined;
      }
      scopes.push({
        scopeKeyDigest: digest,
        workspace: header ? header.scopeKey.workspace : own.scopeKey.workspace,
        state,
        building,
        ...(header
          ? {
              rowCount: header.rowCount,
              snapshotBuiltAt: header.builtAt,
              buildMs: header.buildMs,
              searchIndexed: header.searchIndexed === true,
              ...(header.searchMessageCount !== undefined
                ? { searchMessageCount: header.searchMessageCount }
                : {}),
              ...(header.searchIndexBytes !== undefined
                ? { searchIndexBytes: header.searchIndexBytes }
                : {}),
            }
          : {}),
        ...(scopeState?.verifiedAt ? { verifiedAt: scopeState.verifiedAt } : {}),
        ...(scopeState?.lastError ? { lastError: scopeState.lastError } : {}),
      });
    }
    return { enabled: true, path: store.path, ...base, scopes };
  } catch {
    return { enabled: false, ...base, scopes: [] };
  } finally {
    try {
      store?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Start a background refresh of the config's scope.
 * @param config - Config identifying the scope.
 * @param deps - Catalog dependencies.
 * @returns The job id, whether a build was already running, and `rateLimited` when skipped.
 */
export function startCatalogRefresh(
  config: LibraryConfig | undefined,
  deps: CatalogDeps
): { jobId: string; alreadyRunning: boolean; rateLimited?: boolean } {
  const scope = resolveCatalogScope(config, deps);
  const handle = deps.requestCatalogRefresh({
    scopeKey: scope.scopeKey,
    readConfig: scope.readConfig,
    storePath: scope.storePath,
  });
  if (handle.rateLimited !== true) requestedAt.set(scope.digest, Date.now());
  return handle;
}

/**
 * Wait for the scope's running build.
 * @param config - Config identifying the scope.
 * @param timeoutMs - Maximum wait.
 * @param deps - Catalog dependencies.
 * @returns True when a build finished successfully within the timeout.
 */
export async function awaitCatalogBuild(
  config: LibraryConfig | undefined,
  timeoutMs: number,
  deps: CatalogDeps
): Promise<boolean> {
  const scope = resolveCatalogScope(config, deps);
  const response = await deps.waitForCatalogBuild(scope.digest, timeoutMs);
  if (response) requestedAt.delete(scope.digest);
  return response?.type === 'done';
}
