/**
 * Per-operation record of how a workspace request resolved.
 *
 * Kept outside the read-context shape so it never widens the context's public surface, and in
 * its own module so presentation layers can read the outcome without depending on storage.
 */

import type { WorkspaceScopeResolution } from './types.js';

export type RecordedWorkspaceScope = Exclude<WorkspaceScopeResolution, { state: 'empty' }>;

const workspaceScopeByContext = new WeakMap<
  object,
  { resolution: RecordedWorkspaceScope; sessionCount?: number }
>();

/** Record the scope outcome for the operation that owns `context`. */
export function recordWorkspaceScope(context: object, resolution: RecordedWorkspaceScope): void {
  workspaceScopeByContext.set(context, { resolution });
}

/** Record how many sessions a scoped operation found, so a matched scope can report `empty`. */
export function recordWorkspaceScopeSessionCount(context: object, count: number): void {
  const recorded = workspaceScopeByContext.get(context);
  if (recorded) recorded.sessionCount = count;
}

/**
 * Report how the most recent listing on this context resolved its workspace request.
 * @param context - The core read context used for the listing
 * @param sessionCount - Number of sessions the scoped listing returned; defaults to the
 *   count recorded by the operation. A matched scope with zero sessions reports `empty`.
 */
export function getWorkspaceScopeResolution(
  context: object,
  sessionCount?: number
): WorkspaceScopeResolution {
  const recorded = workspaceScopeByContext.get(context);
  if (!recorded) return { state: 'unscoped' };
  const resolution = recorded.resolution;
  const count = sessionCount ?? recorded.sessionCount;
  if (resolution.state === 'matched' && count === 0) {
    return { ...resolution, state: 'empty' };
  }
  return resolution;
}
