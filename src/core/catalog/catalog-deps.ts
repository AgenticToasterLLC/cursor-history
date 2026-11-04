/**
 * Dependency seam between the library read path (C3) and the catalog
 * implementation modules owned by C1 (paths/store/lock/fingerprint/scope-key)
 * and C2 (builder/refresh). Those modules are loaded lazily through dynamic
 * `import()` so this branch typechecks without them, and tests inject
 * in-memory fakes via `setCatalogDepsForTesting`.
 *
 * MERGE NOTE: once C1/C2 are merged, the loader below may be replaced by
 * static imports; the specifiers and export names are exactly those in
 * `contract.ts`. `isFingerprintSettled(fp, nowMs, settleMs=2000)` is wrapped with Date.now();
 * the store is opened via `openCatalogStoreAsync` (selects the SQLite driver first).
 */
import type {
  BuildCatalogSnapshot,
  CancelCatalogRefreshes,
  CatalogStore,
  ComputeSourceFingerprint,
  CountFingerprintChanges,
  DefaultCatalogPath,
  DigestScopeKey,
  RequestCatalogRefresh,
  SourceFingerprint,
  WaitForCatalogBuild,
} from './contract.js';

/** Everything the read path needs from the catalog implementation. */
export interface CatalogDeps {
  defaultCatalogPath: DefaultCatalogPath;
  /** May be async: production awaits the SQLite driver selection (C1 openCatalogStoreAsync). */
  openCatalogStore: (options?: { path?: string }) => CatalogStore | Promise<CatalogStore>;
  computeSourceFingerprint: ComputeSourceFingerprint;
  countFingerprintChanges: CountFingerprintChanges;
  /** True when no fingerprinted file was modified recently enough to be mid-write. */
  isFingerprintSettled: (fingerprint: SourceFingerprint) => boolean;
  digestScopeKey: DigestScopeKey;
  buildCatalogSnapshot: BuildCatalogSnapshot;
  requestCatalogRefresh: RequestCatalogRefresh;
  waitForCatalogBuild: WaitForCatalogBuild;
  cancelCatalogRefreshes?: CancelCatalogRefreshes;
}

export type { CatalogStore };

let override: CatalogDeps | undefined;
let loaded: Promise<CatalogDeps> | undefined;

/** Install (or clear with undefined) in-memory dependencies. Test-only. */
export function setCatalogDepsForTesting(deps: CatalogDeps | undefined): void {
  override = deps;
}

// Non-literal specifiers keep tsc/bundlers from resolving modules that are
// not present on this branch; the shapes are asserted through the contract types.
async function lazy<T>(specifier: string): Promise<T> {
  return (await import(specifier)) as T;
}

async function loadProductionDeps(): Promise<CatalogDeps> {
  const [paths, store, fp, scopeKey, builder, refresh] = await Promise.all([
    lazy<{ defaultCatalogPath: DefaultCatalogPath }>('./paths.js'),
    lazy<{
      openCatalogStoreAsync: (options?: { path?: string }) => Promise<CatalogStore>;
    }>('./store.js'),
    lazy<{
      computeSourceFingerprint: ComputeSourceFingerprint;
      countFingerprintChanges: CountFingerprintChanges;
      isFingerprintSettled: (fingerprint: SourceFingerprint, nowMs: number) => boolean;
    }>('./fingerprint.js'),
    lazy<{ digestScopeKey: DigestScopeKey }>('./scope-key.js'),
    lazy<{ buildCatalogSnapshot: BuildCatalogSnapshot }>('./builder.js'),
    lazy<{
      requestCatalogRefresh: RequestCatalogRefresh;
      waitForCatalogBuild: WaitForCatalogBuild;
      cancelCatalogRefreshes?: CancelCatalogRefreshes;
    }>('./refresh.js'),
  ]);
  return {
    defaultCatalogPath: paths.defaultCatalogPath,
    openCatalogStore: (options) => store.openCatalogStoreAsync(options),
    computeSourceFingerprint: fp.computeSourceFingerprint,
    countFingerprintChanges: fp.countFingerprintChanges,
    isFingerprintSettled: (fingerprint) => fp.isFingerprintSettled(fingerprint, Date.now()),
    digestScopeKey: scopeKey.digestScopeKey,
    buildCatalogSnapshot: builder.buildCatalogSnapshot,
    requestCatalogRefresh: refresh.requestCatalogRefresh,
    waitForCatalogBuild: refresh.waitForCatalogBuild,
    cancelCatalogRefreshes: refresh.cancelCatalogRefreshes,
  };
}

/** Resolve dependencies: the test override, else the lazily loaded C1/C2 modules. */
export async function getCatalogDeps(): Promise<CatalogDeps> {
  if (override) return override;
  loaded ??= loadProductionDeps().catch((error: unknown) => {
    loaded = undefined;
    throw error;
  });
  return loaded;
}
