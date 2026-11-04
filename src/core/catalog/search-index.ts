/**
 * Opt-in search index over the sidecar catalog.
 *
 * Soundness: the index only ever NARROWS the set of sessions that are then re-read and
 * re-matched from source by the unchanged direct matcher, so results (counts, snippets,
 * offsets, order) always come from source text.
 *
 * What is indexed: exactly the text `getSearchSnippets` matches, i.e. each message's `content`
 * (nothing else), lowercased with JavaScript `toLowerCase()` - the same fold the matcher applies
 * to the content. Nothing but trigram postings is stored (contentless FTS5 table).
 *
 * Superset argument: the matcher reports a hit iff `content.toLowerCase()` contains
 * `query.toLowerCase()`. For an ASCII query q (lowercased by JS = ASCII lowercase) that substring
 * lies inside the indexed (already lowercased) text, so all of its overlapping 3-grams are
 * adjacent tokens there. FTS5's own case folding maps ASCII lowercase to itself, so those
 * trigrams are indexed unchanged and the trigram phrase `"q"` matches. Hence every message the
 * matcher would hit is a candidate. (Non-ASCII queries are ineligible because FTS5 and JS
 * folds can disagree, e.g. U+0130; ASCII queries are safe even when the content is non-ASCII
 * because the content is pre-folded by JS before indexing.)
 *
 * Sensitivity: no message bodies are stored, but trigram postings let someone holding the
 * sidecar infer substrings of the indexed text. That is why the index is opt-in.
 */
import { randomUUID } from 'node:crypto';
import { mergeWithDefaults } from '../../lib/config.js';
import type { CatalogInfo, LibraryConfig } from '../../lib/types.js';
import * as storage from '../storage.js';
import { SessionAmbiguityError } from '../errors.js';
import type { CatalogMode, CatalogState, IndexerRequest } from './contract.js';
import type { CatalogDeps, CatalogStore } from './catalog-deps.js';
import {
  catalogIneligibleReason,
  lookup,
  openStore,
  reasonOf,
  requestRefresh,
  resolveCatalogScope,
  type ResolvedCatalogScope,
} from './read.js';
import type { CatalogStoreExtended, SearchIndexWriter } from './store.js';

/** Minimum query length (UTF-16 code units) for index use: a trigram index needs 3. */
export const SEARCH_INDEX_MIN_QUERY_LENGTH = 3;

/**
 * Why a query cannot use the index, or undefined when eligible.
 * Eligible: at least 3 UTF-16 code units, and only tab, LF, CR or printable ASCII.
 */
export function searchIndexQueryIneligibleReason(query: string): string | undefined {
  if (query.length < SEARCH_INDEX_MIN_QUERY_LENGTH) return 'QUERY_TOO_SHORT';
  if (!/^[\t\n\r\x20-\x7e]+$/.test(query)) return 'QUERY_NOT_ASCII';
  return undefined;
}

/** Text to index for one message: the matcher's fold of its content. */
export function indexedTextOf(content: string): string {
  return content.toLowerCase();
}

/**
 * Hydrate every resolved, non-ambiguous session of the scope through the storage read path the
 * search uses (same read context options and scope rules) and index each message's content.
 * Marks the snapshot searchable only when all sessions were indexed.
 * @returns Content-free totals.
 */
export async function buildSearchIndex(
  store: CatalogStoreExtended,
  snapshotId: number,
  config: LibraryConfig,
  options: { signal?: AbortSignal } = {}
): Promise<{ sessions: number; messageCount: number; indexBytes?: number }> {
  const resolved = mergeWithDefaults(config);
  const signal = options.signal ?? resolved.signal;
  const context = storage.createSessionReadContext({
    dataPath: resolved.dataPath,
    backupPath: resolved.backupPath,
    workspacePath: resolved.workspace,
    includeCrossWorkspaceSources: resolved.includeCrossWorkspaceSources,
    resolvedSessionCapacity: 0,
    sqliteDriver: resolved.sqliteDriver,
    sourceReadLimits: resolved.sourceReadLimits,
    signal,
    // Ambiguity was already reported with the summary pass; here such sessions are only skipped.
    onDiagnostic: () => undefined,
  });
  let writer: SearchIndexWriter | undefined;
  try {
    writer = store.beginSearchIndex(snapshotId);
    const summaries = await storage.listSessionSummaries(
      {
        limit: 0,
        all: true,
        workspacePath: resolved.workspace,
        includeCrossWorkspaceSources: resolved.includeCrossWorkspaceSources,
        sourceReadLimits: resolved.sourceReadLimits,
        signal,
      },
      resolved.dataPath,
      resolved.backupPath,
      context
    );
    let sessions = 0;
    for (const summary of summaries) {
      signal?.throwIfAborted();
      if (summary.resolutionState === 'ambiguous') continue;
      try {
        const session = await storage.getSession(
          summary.id,
          resolved.dataPath,
          resolved.backupPath,
          context,
          summary.index
        );
        if (!session) continue;
        writer.addSession(
          summary.id,
          session.messages.map((message, index) => ({
            index,
            text: indexedTextOf(message.content),
          }))
        );
        sessions += 1;
      } catch (error) {
        if (!(error instanceof SessionAmbiguityError)) throw error;
      } finally {
        context.releaseSession(summary.id);
      }
    }
    return { sessions, ...writer.finish() };
  } catch (error) {
    writer?.abort();
    throw error;
  } finally {
    await context.dispose();
  }
}

/** Outcome of planning one search. */
export type SearchPlan =
  | {
      mode: 'indexed';
      /** Session ids that may contain the query (superset); verify against source. */
      candidateSessionIds: ReadonlySet<string>;
      catalog: CatalogInfo;
    }
  | { mode: 'direct'; reason: string; catalog?: CatalogInfo };

type SearchStore = CatalogStore & Partial<CatalogStoreExtended>;

/**
 * Decide whether `query` can be answered through the index and, if so, fetch candidates.
 * Never throws for catalog problems: those degrade to `mode: 'direct'`.
 * @param query - The user's query.
 * @param config - Caller config (`catalog` auto|strict, `searchIndex` true).
 * @param deps - Catalog dependencies.
 */
export async function planIndexedSearch(
  query: string,
  config: LibraryConfig,
  deps: CatalogDeps
): Promise<SearchPlan> {
  const queryReason = searchIndexQueryIneligibleReason(query);
  if (queryReason) return { mode: 'direct', reason: queryReason };
  const ineligible = catalogIneligibleReason(config);
  if (ineligible) {
    return {
      mode: 'direct',
      reason: 'CATALOG_UNAVAILABLE',
      catalog: { state: 'unavailable', complete: true, reason: ineligible },
    };
  }
  const mode = (config.catalog ?? 'direct') as CatalogMode;
  let scope: ResolvedCatalogScope | undefined;
  let store: SearchStore | undefined;
  let fallback: { reason: string; catalog: CatalogInfo } | undefined;
  try {
    scope = resolveCatalogScope({ ...config, searchIndex: true }, deps);
    store = (await openStore(config, deps)) as SearchStore;
    let current = await deps.computeSourceFingerprint(scope.inputs);
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
        fallback = {
          reason: 'INDEX_BUILD_FAILED',
          catalog: { state: 'degraded', complete: true, reason: reasonOf(response) },
        };
      } else {
        current = await deps.computeSourceFingerprint(scope.inputs);
        found = lookup(store, deps, scope, current);
        if (found.kind !== 'ready') {
          fallback = {
            reason: 'INDEX_BUILD_FAILED',
            catalog: { state: 'degraded', complete: true, reason: 'CHANGED_DURING_BUILD' },
          };
        }
      }
    }
    if (!fallback) {
      if (found.kind === 'missing') {
        fallback = {
          reason: 'INDEX_BUILDING',
          catalog: { state: 'building', complete: true, refreshScheduled: false },
        };
      } else if (
        !found.header.searchIndexed ||
        typeof (store as Partial<CatalogStoreExtended>).searchCandidates !== 'function'
      ) {
        fallback = {
          reason: 'INDEX_NOT_READY',
          catalog: {
            state: found.kind === 'ready' ? 'ready' : ('stale' as CatalogState),
            complete: found.kind === 'ready',
            snapshotBuiltAt: found.header.builtAt,
            refreshScheduled: false,
          },
        };
      } else {
        const candidates = (store as CatalogStoreExtended).searchCandidates(
          found.header.snapshotId,
          query
        );
        const candidateSessionIds = new Set(candidates.keys());
        if (found.kind === 'ready') {
          const verifiedAt = new Date().toISOString();
          try {
            store.touchVerified(found.header.snapshotId, verifiedAt);
          } catch {
            // advisory
          }
          return {
            mode: 'indexed',
            candidateSessionIds,
            catalog: {
              state: 'ready',
              complete: true,
              snapshotBuiltAt: found.header.builtAt,
              verifiedAt,
            },
          };
        }
        return {
          mode: 'indexed',
          candidateSessionIds,
          catalog: {
            state: 'stale',
            complete: false,
            snapshotBuiltAt: found.header.builtAt,
            changedSources: found.changedSources,
            refreshScheduled: requestRefresh(deps, scope),
          },
        };
      }
    }
  } catch (error) {
    fallback = {
      reason: 'CATALOG_DEGRADED',
      catalog: { state: 'degraded', complete: true, reason: reasonOf(error) },
    };
  } finally {
    try {
      store?.close();
    } catch {
      // ignore
    }
  }
  if (
    fallback &&
    scope &&
    (fallback.reason === 'INDEX_BUILDING' || fallback.reason === 'INDEX_NOT_READY')
  ) {
    fallback.catalog = { ...fallback.catalog, refreshScheduled: requestRefresh(deps, scope) };
  }
  const final = fallback ?? {
    reason: 'CATALOG_DEGRADED',
    catalog: { state: 'degraded' as CatalogState, complete: true },
  };
  return { mode: 'direct', reason: final.reason, catalog: final.catalog };
}
