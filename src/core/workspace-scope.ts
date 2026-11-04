/**
 * Pure lexical workspace-path normalization and scope matching.
 *
 * This module deliberately has no filesystem dependency. Cursor history may
 * refer to historical, foreign-platform, or currently unmounted workspaces, so
 * matching must never depend on realpath/stat/existence checks.
 */

import { WorkspaceAmbiguityError } from './errors.js';
import type { WorkspaceInventoryEntry, WorkspaceMatchKind, WorkspaceSuggestion } from './types.js';

export { WorkspaceAmbiguityError } from './errors.js';
export type { WorkspaceMatchKind } from './types.js';

export type WorkspaceScopeResult =
  | { kind: 'matched'; path: string; matchKind: WorkspaceMatchKind }
  | { kind: 'not-found'; normalizedRequest: string };

interface NormalizedWorkspacePath {
  /** Stable public spelling used by scope/path projections. */
  path: string;
  /** Path components excluding a root or drive anchor. */
  components: string[];
  /** Drive/UNC paths use case-insensitive comparison. */
  caseInsensitive: boolean;
  /** A drive anchor prevents suffix matching across different drives. */
  drive?: string;
  /** UNC requests match only the same server/share anchor. */
  uncAnchor?: string;
}

/** Unicode code-point ordering, independent of the process locale. */
function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

/** Decode supported file URIs without consulting the host filesystem. */
function decodeFileUri(value: string): string {
  if (!/^file:/i.test(value)) return value;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`Invalid workspace file URI: ${value}`);
  }
  if (url.protocol !== 'file:') return value;

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new TypeError(`Invalid percent encoding in workspace file URI: ${value}`);
  }

  // file://localhost/path is local. Any other host denotes a Windows UNC path.
  if (url.hostname && url.hostname.toLowerCase() !== 'localhost') {
    return `//${url.hostname}${pathname}`;
  }
  return pathname;
}

function collapseSegments(
  rawSegments: readonly string[],
  absolute: boolean,
  protectedCount = 0
): string[] {
  const result: string[] = [];
  for (const segment of rawSegments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (result.length > protectedCount && result[result.length - 1] !== '..') {
        result.pop();
      } else if (!absolute) {
        result.push(segment);
      }
      continue;
    }
    result.push(segment);
  }
  return result;
}

function normalizeWorkspacePathDetails(input: string): NormalizedWorkspacePath {
  if (typeof input !== 'string' || input.length === 0) {
    throw new TypeError('Workspace path must be a non-empty string.');
  }

  let value = decodeFileUri(input).replace(/\\/g, '/');

  // Normalize native Windows and file-URI drive spellings (`C:/x`, `/C:/x`).
  const driveMatch = value.match(/^\/?([a-z]):(?:\/(.*))?$/i);
  if (driveMatch) {
    const drive = driveMatch[1]!.toLowerCase();
    const segments = collapseSegments((driveMatch[2] ?? '').split('/'), true).map((part) =>
      part.toLowerCase()
    );
    return {
      path: segments.length > 0 ? `${drive}:/${segments.join('/')}` : `${drive}:/`,
      components: segments,
      caseInsensitive: true,
      drive,
    };
  }

  // WSL drive mounts are the same historical workspace identity as Windows drives.
  const wslMatch = value.match(/^\/mnt\/([a-z])(?:\/(.*))?$/i);
  if (wslMatch) {
    const drive = wslMatch[1]!.toLowerCase();
    const segments = collapseSegments((wslMatch[2] ?? '').split('/'), true).map((part) =>
      part.toLowerCase()
    );
    return {
      path: segments.length > 0 ? `${drive}:/${segments.join('/')}` : `${drive}:/`,
      components: segments,
      caseInsensitive: true,
      drive,
    };
  }

  if (value.startsWith('//')) {
    const segments = collapseSegments(value.slice(2).split('/'), true, 2).map((part) =>
      part.toLowerCase()
    );
    const server = segments[0] ?? '';
    const share = segments[1] ?? '';
    const uncAnchor = `${server}/${share}`;
    return {
      path: `//${segments.join('/')}`,
      components: segments.slice(2),
      caseInsensitive: true,
      uncAnchor,
    };
  }

  const absolute = value.startsWith('/');
  const segments = collapseSegments(value.split('/'), absolute);
  if (process.platform === 'win32') {
    value = segments.map((part) => part.toLowerCase()).join('/');
    return {
      path: absolute ? `/${value}` : value || '.',
      components: segments.map((part) => part.toLowerCase()),
      caseInsensitive: true,
    };
  }

  return {
    path: absolute ? `/${segments.join('/')}` : segments.join('/') || '.',
    components: segments,
    caseInsensitive: false,
  };
}

/**
 * Normalize a historical workspace path lexically.
 *
 * Supported transformations include file-URI decoding, separator and dot
 * segment normalization, trailing-separator removal, and Windows/WSL drive
 * equivalence. The path is not opened or checked for existence.
 */
export function normalizeWorkspacePath(input: string): string {
  return normalizeWorkspacePathDetails(input).path;
}

/**
 * Return whether a value is one of the display-only workspace labels used by
 * legacy discovery code. These labels are useful in human-readable tables,
 * but they are not filesystem paths and must never escape as canonical path
 * metadata.
 */
function isInternalWorkspaceLabel(value: string): boolean {
  const label = value.trim();
  return (
    /^(?:global|unknown)$/iu.test(label) ||
    /^\((?:global|unknown workspace|workspace:\s*[^)]*)\)$/iu.test(label)
  );
}

/**
 * Normalize a verified public workspace path, or return `undefined` for an
 * absent, malformed, or display-only value.
 *
 * "Verified" is intentionally lexical: historical paths may refer to an
 * unmounted filesystem, so this helper never performs filesystem I/O. It
 * verifies only that the value is a path rather than an internal presentation
 * sentinel, then applies the same stable normalization as scope matching.
 */
export function normalizePublicWorkspacePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || isInternalWorkspaceLabel(value)) {
    return undefined;
  }

  try {
    const normalized = normalizeWorkspacePath(value);
    return isInternalWorkspaceLabel(normalized) ? undefined : normalized;
  } catch {
    return undefined;
  }
}

/** True when a value can be exposed as public canonical workspace metadata. */
export function isPublicWorkspacePath(value: unknown): value is string {
  return normalizePublicWorkspacePath(value) !== undefined;
}

function exactComparisonKey(path: NormalizedWorkspacePath): string {
  return path.caseInsensitive ? path.path.toLowerCase() : path.path;
}

function componentsEndWith(
  candidate: NormalizedWorkspacePath,
  request: NormalizedWorkspacePath
): boolean {
  if (request.drive && candidate.drive !== request.drive) return false;
  if (request.uncAnchor && candidate.uncAnchor !== request.uncAnchor) return false;
  if (request.components.length === 0 || request.components.length > candidate.components.length) {
    return false;
  }

  const offset = candidate.components.length - request.components.length;
  const insensitive = candidate.caseInsensitive || request.caseInsensitive;
  for (let index = 0; index < request.components.length; index++) {
    const candidatePart = candidate.components[offset + index]!;
    const requestPart = request.components[index]!;
    if (
      (insensitive ? candidatePart.toLowerCase() : candidatePart) !==
      (insensitive ? requestPart.toLowerCase() : requestPart)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Resolve a workspace request against known normalized memberships.
 *
 * Exact matches always win. A suffix is accepted only when its complete path
 * components identify one normalized candidate; multiple suffix candidates
 * throw before a caller can proceed to conversation hydration.
 */
export function resolveWorkspaceScope(
  request: string,
  memberships: readonly string[]
): WorkspaceScopeResult {
  const normalizedRequest = normalizeWorkspacePathDetails(request);
  const uniqueCandidates = new Map<string, NormalizedWorkspacePath>();

  for (const membership of memberships) {
    const candidate = normalizeWorkspacePathDetails(membership);
    const key = exactComparisonKey(candidate);
    if (!uniqueCandidates.has(key)) uniqueCandidates.set(key, candidate);
  }

  const candidates = [...uniqueCandidates.values()];
  const requestKey = exactComparisonKey(normalizedRequest);
  const exact = candidates.find((candidate) => exactComparisonKey(candidate) === requestKey);
  if (exact) {
    return { kind: 'matched', path: exact.path, matchKind: 'exact' };
  }

  const suffixMatches = candidates.filter((candidate) =>
    componentsEndWith(candidate, normalizedRequest)
  );
  if (suffixMatches.length === 1) {
    return { kind: 'matched', path: suffixMatches[0]!.path, matchKind: 'unique-suffix' };
  }
  if (suffixMatches.length > 1) {
    throw new WorkspaceAmbiguityError(
      normalizedRequest.path,
      suffixMatches.map((candidate) => candidate.path).sort(compareCodePoints)
    );
  }

  return { kind: 'not-found', normalizedRequest: normalizedRequest.path };
}

const SUGGESTION_REASON_RANK: Record<WorkspaceSuggestion['reason'], number> = {
  'case-or-separator-variant': 0,
  'shared-trailing-components': 1,
  'same-basename': 2,
  substring: 3,
};

/** Case-fold and drop every separator-like character so spelling variants compare equal. */
function looseKey(value: string): string {
  return value.toLowerCase().replace(/[\s/\\._-]+/gu, '');
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function lastComponent(path: NormalizedWorkspacePath): string {
  return path.components[path.components.length - 1]?.toLowerCase() ?? '';
}

/** Count whole trailing path components shared by two normalized paths (case-insensitive). */
function sharedTrailingComponents(
  left: NormalizedWorkspacePath,
  right: NormalizedWorkspacePath
): number {
  let shared = 0;
  while (
    shared < left.components.length &&
    shared < right.components.length &&
    left.components[left.components.length - 1 - shared]!.toLowerCase() ===
      right.components[right.components.length - 1 - shared]!.toLowerCase()
  ) {
    shared += 1;
  }
  return shared;
}

/**
 * Suggest known workspace paths that resemble an unmatched request.
 *
 * Purely lexical: no filesystem access. Ranking is deterministic: spelling variants
 * first, then paths sharing two or more whole trailing components (more shared first),
 * then paths with the same final component, then substring containment. Ties break by
 * code-point path order. At most `max` suggestions are returned.
 */
export function suggestWorkspacePaths(
  request: string,
  knownPaths: readonly string[],
  max = 5
): WorkspaceSuggestion[] {
  const normalizedRequest = normalizeWorkspacePathDetails(request);
  const requestLoose = looseKey(normalizedRequest.path);
  const requestBase = lastComponent(normalizedRequest);
  const requestBaseLoose = looseKey(requestBase);
  const requestText = normalizedRequest.path.toLowerCase();
  const seen = new Set<string>();
  const ranked: Array<WorkspaceSuggestion & { shared: number }> = [];

  for (const known of knownPaths) {
    let candidate: NormalizedWorkspacePath;
    try {
      candidate = normalizeWorkspacePathDetails(known);
    } catch {
      continue;
    }
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    if (candidate.path === normalizedRequest.path) continue;

    const candidateText = candidate.path.toLowerCase();
    const shared = sharedTrailingComponents(normalizedRequest, candidate);
    const candidateBaseLoose = looseKey(lastComponent(candidate));
    let suggestion: (WorkspaceSuggestion & { shared: number }) | undefined;

    if (requestLoose.length > 0 && looseKey(candidate.path) === requestLoose) {
      suggestion = {
        path: candidate.path,
        reason: 'case-or-separator-variant',
        score: 1,
        shared,
      };
    } else if (shared >= 2) {
      suggestion = {
        path: candidate.path,
        reason: 'shared-trailing-components',
        score: roundScore(0.5 + 0.4 * (shared / (shared + 1))),
        shared,
      };
    } else if (
      requestBaseLoose.length > 0 &&
      (shared === 1 || requestBaseLoose === candidateBaseLoose)
    ) {
      suggestion = { path: candidate.path, reason: 'same-basename', score: 0.4, shared };
    } else if (
      (requestText.length >= 3 && candidateText.includes(requestText)) ||
      (candidateText.length >= 3 && requestText.includes(candidateText)) ||
      (requestBaseLoose.length >= 3 &&
        candidateBaseLoose.length >= 3 &&
        (candidateBaseLoose.includes(requestBaseLoose) ||
          requestBaseLoose.includes(candidateBaseLoose)))
    ) {
      suggestion = { path: candidate.path, reason: 'substring', score: 0.2, shared };
    }
    if (suggestion) ranked.push(suggestion);
  }

  ranked.sort(
    (left, right) =>
      SUGGESTION_REASON_RANK[left.reason] - SUGGESTION_REASON_RANK[right.reason] ||
      right.shared - left.shared ||
      compareCodePoints(left.path, right.path)
  );
  return ranked.slice(0, Math.max(0, max)).map(({ path, reason, score }) => ({
    path,
    reason,
    score,
  }));
}

/** Order inventory entries newest first (unknown last), then by path in code-point order. */
export function compareWorkspaceInventoryEntries(
  left: Pick<WorkspaceInventoryEntry, 'path' | 'lastModifiedAt'>,
  right: Pick<WorkspaceInventoryEntry, 'path' | 'lastModifiedAt'>
): number {
  if (left.lastModifiedAt !== right.lastModifiedAt) {
    if (left.lastModifiedAt === undefined) return 1;
    if (right.lastModifiedAt === undefined) return -1;
    return left.lastModifiedAt < right.lastModifiedAt ? 1 : -1;
  }
  return compareCodePoints(left.path, right.path);
}

/** Case-insensitive substring filter over the normalized path and every alias. */
export function inventoryEntryMatchesQuery(entry: WorkspaceInventoryEntry, query: string): boolean {
  const needle = query.toLowerCase();
  if (needle.length === 0) return true;
  return [entry.path, ...entry.aliases].some((value) => value.toLowerCase().includes(needle));
}

/**
 * Merge raw workspace spellings into one entry per normalized path.
 *
 * Display-only labels are skipped. Spellings that cannot be normalized (malformed
 * file URIs) are reported through `unnormalizable` rather than silently dropped, so a
 * caller that needs a provable superset can decline to rely on the inventory.
 */
export function buildWorkspaceInventory(
  observations: ReadonlyArray<{
    raw: string;
    source: 'composer' | 'store';
    workspaceStorageId?: string;
    modifiedMs?: number;
  }>
): { entries: WorkspaceInventoryEntry[]; unnormalizable: boolean } {
  const byPath = new Map<
    string,
    {
      aliases: Set<string>;
      sources: Set<'composer' | 'store'>;
      ids: Set<string>;
      modifiedMs?: number;
    }
  >();
  let unnormalizable = false;
  for (const observation of observations) {
    if (isInternalWorkspaceLabel(observation.raw)) continue;
    const path = normalizePublicWorkspacePath(observation.raw);
    if (path === undefined) {
      unnormalizable = true;
      continue;
    }
    let bucket = byPath.get(path);
    if (!bucket) {
      bucket = { aliases: new Set(), sources: new Set(), ids: new Set() };
      byPath.set(path, bucket);
    }
    bucket.aliases.add(observation.raw);
    bucket.sources.add(observation.source);
    if (observation.workspaceStorageId !== undefined) {
      bucket.ids.add(observation.workspaceStorageId);
    }
    if (
      observation.modifiedMs !== undefined &&
      Number.isFinite(observation.modifiedMs) &&
      (bucket.modifiedMs === undefined || observation.modifiedMs > bucket.modifiedMs)
    ) {
      bucket.modifiedMs = observation.modifiedMs;
    }
  }
  const entries: WorkspaceInventoryEntry[] = [...byPath.entries()].map(([path, bucket]) => ({
    path,
    aliases: [...bucket.aliases].sort(compareCodePoints),
    sources: (['composer', 'store'] as const).filter((source) => bucket.sources.has(source)),
    workspaceStorageIds: [...bucket.ids].sort(compareCodePoints),
    ...(bucket.modifiedMs === undefined
      ? {}
      : { lastModifiedAt: new Date(bucket.modifiedMs).toISOString() }),
  }));
  entries.sort(compareWorkspaceInventoryEntries);
  return { entries, unnormalizable };
}
