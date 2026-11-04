/**
 * Dependency seam for the catalog builder / worker / refresh.
 *
 * C1 modules (store, lock, fingerprint, scope-key) and the library read path
 * are reached only through `CatalogDeps`. Defaults come from:
 *  - `loadCatalogDepsDynamic()` (async; used by the builder and worker), which
 *    imports the C1 modules by their contract paths at run time, and
 *  - `registerCatalogModules()` / `getRegisteredModules()` (sync; used by
 *    requestCatalogRefresh, which must be synchronous).
 * At merge, wire the sync path by calling `registerCatalogModules` once with
 * static imports of the C1 modules (e.g. from the library entry).
 */
import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';
import type {
  ComputeSourceFingerprint,
  CreateCatalogLock,
  DigestScopeKey,
  OpenCatalogStore,
} from './contract.js';
import type { LibraryConfig, PaginatedResult, SessionSummary } from '../../lib/types.js';

export type DirectListSessionSummaries = (
  config?: LibraryConfig & { catalog?: 'direct' }
) => Promise<PaginatedResult<SessionSummary>>;

export interface CatalogModules {
  openCatalogStore: OpenCatalogStore;
  createCatalogLock: CreateCatalogLock;
  computeSourceFingerprint: ComputeSourceFingerprint;
  digestScopeKey: DigestScopeKey;
}

export interface CatalogDeps extends CatalogModules {
  /** C1: `ensureCatalogDriver` from store.js; must resolve before openCatalogStore (when present). */
  ensureCatalogDriver?: () => Promise<void>;
  listSessionSummaries: DirectListSessionSummaries;
}

/** True when this file was compiled as CommonJS (dist/cjs). */
export const IS_CJS = typeof __dirname !== 'undefined';

let registered: Partial<CatalogModules> = {};

export function registerCatalogModules(modules: Partial<CatalogModules>): void {
  registered = { ...registered, ...modules };
}

export function getRegisteredModules(): Partial<CatalogModules> {
  return registered;
}

async function importModule(specifier: string): Promise<Record<string, unknown>> {
  // Variable specifiers keep tsc from resolving modules that may be absent in a branch.
  return (await import(specifier)) as Record<string, unknown>;
}

/** Import an absolute-path module (test hook) in a way that works for ESM and CJS output. */
export async function importAbsolute(path: string): Promise<Record<string, unknown>> {
  if (!isAbsolute(path)) throw new Error('absolute path required');
  return importModule(IS_CJS ? path : pathToFileURL(path).href);
}

/** Import the C1 modules and the library by contract path. */
export async function loadCatalogDepsDynamic(
  need: ReadonlySet<keyof CatalogDeps>
): Promise<Partial<CatalogDeps>> {
  const out: Partial<CatalogDeps> = {};
  if (need.has('openCatalogStore')) {
    const store = await importModule('./store.js');
    out.openCatalogStore = store['openCatalogStore'] as OpenCatalogStore;
    if (typeof store['ensureCatalogDriver'] === 'function') {
      out.ensureCatalogDriver = store['ensureCatalogDriver'] as () => Promise<void>;
    }
  }
  if (need.has('createCatalogLock')) {
    out.createCatalogLock = (await importModule('./lock.js'))[
      'createCatalogLock'
    ] as CreateCatalogLock;
  }
  if (need.has('computeSourceFingerprint')) {
    out.computeSourceFingerprint = (await importModule('./fingerprint.js'))[
      'computeSourceFingerprint'
    ] as ComputeSourceFingerprint;
  }
  if (need.has('digestScopeKey')) {
    out.digestScopeKey = (await importModule('./scope-key.js'))['digestScopeKey'] as DigestScopeKey;
  }
  if (need.has('listSessionSummaries')) {
    out.listSessionSummaries = (await import('../../lib/index.js'))
      .listSessionSummaries as DirectListSessionSummaries;
  }
  return out;
}

const ALL_KEYS: Array<keyof CatalogDeps> = [
  'openCatalogStore',
  'createCatalogLock',
  'computeSourceFingerprint',
  'digestScopeKey',
  'listSessionSummaries',
];

/** Complete deps: overrides first, then registered modules, then dynamic imports. */
export async function resolveCatalogDeps(
  overrides?: Partial<CatalogDeps>,
  keys: ReadonlyArray<keyof CatalogDeps> = ALL_KEYS
): Promise<CatalogDeps> {
  const merged: Partial<CatalogDeps> = { ...registered, ...overrides };
  const missing = new Set(keys.filter((k) => merged[k] === undefined));
  if (missing.size > 0) Object.assign(merged, await loadCatalogDepsDynamic(missing));
  return merged as CatalogDeps;
}
