/** Stable machine-readable error codes for session integrity operations. */
export type SessionIntegrityErrorCode =
  | 'WORKSPACE_AMBIGUOUS'
  | 'SESSION_AMBIGUOUS'
  | 'SESSION_SCOPE_MISMATCH'
  | 'UNSUPPORTED_SESSION_MIGRATION'
  | 'MIGRATION_TARGET_CHANGED'
  | 'DATABASE_CAPABILITY_MISSING'
  | 'NO_CAPABLE_DATABASE_DRIVER'
  | 'BACKUP_PUBLISHED_PERMISSION_FAILED'
  | 'BACKUP_PUBLISHED_CLEANUP_FAILED'
  | 'BACKUP_WORKSPACE_SCOPE_METADATA_REQUIRED'
  | 'RESTORE_ROLLBACK_INCOMPLETE'
  | 'RESTORE_SAFETY_COPY_FAILED'
  | 'LIVE_TARGET_NOT_CONFIRMED'
  | 'TEMPORARY_ARTIFACT_CLEANUP_FAILED'
  | 'READ_CONTEXT_SOURCE_MISMATCH'
  | 'READ_CONTEXT_SCOPE_MISMATCH'
  | 'READ_CONTEXT_OPTIONS_MISMATCH'
  | 'READ_CONTEXT_DISPOSED'
  | 'SOURCE_ENCODING_INVALID'
  | 'SOURCE_LIMIT_EXCEEDED'
  | 'SOURCE_LIMIT_CONFIGURATION_INVALID'
  | 'PROTECTED_PATH'
  | 'CURSOR_RUNNING'
  | 'MIGRATION_SAFETY_COPY_FAILED'
  | 'INSUFFICIENT_DISK_SPACE'
  | 'SAFETY_COPY_REQUIRED';

/** JSON-safe primitive values accepted in public error details. */
export type SafeErrorDetailValue = string | number | boolean | null | string[] | number[];

/** Safe details never contain conversation content or physical source locators. */
export type SafeErrorDetails = Readonly<Record<string, SafeErrorDetailValue | undefined>>;

/** Stable Unicode code-point ordering for new set-like public arrays. */
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

/**
 * Base class for typed failures exposed by core, CLI, and library adapters.
 *
 * @param code - Stable machine-readable failure code.
 * @param message - Human-readable summary that does not contain source content or locators.
 * @param details - JSON-safe recovery metadata suitable for structured output.
 */
export class SessionIntegrityError<
  TCode extends SessionIntegrityErrorCode = SessionIntegrityErrorCode,
  TDetails extends SafeErrorDetails = SafeErrorDetails,
> extends Error {
  override readonly name: string = 'SessionIntegrityError';

  constructor(
    public readonly code: TCode,
    message: string,
    public readonly details: TDetails
  ) {
    super(message);
    if (Error.captureStackTrace) Error.captureStackTrace(this, SessionIntegrityError);
  }
}

/**
 * Reports a component-aligned workspace suffix that matches multiple historical paths.
 *
 * @param requestedWorkspace - Normalized workspace value supplied by the caller.
 * @param candidates - Complete safe workspace paths that matched the suffix.
 */
export class WorkspaceAmbiguityError extends SessionIntegrityError<
  'WORKSPACE_AMBIGUOUS',
  { requestedWorkspace: string; candidateCount: number; candidates: string[]; remedy: string }
> {
  override readonly name = 'WorkspaceAmbiguityError';

  constructor(requestedWorkspace: string, candidates: string[]) {
    const ordered = [...new Set(candidates)].sort(compareCodePoints);
    super('WORKSPACE_AMBIGUOUS', `Workspace suffix is ambiguous: ${requestedWorkspace}`, {
      requestedWorkspace,
      candidateCount: ordered.length,
      candidates: ordered,
      remedy: 'Use a longer component-aligned suffix or the complete historical workspace path.',
    });
  }
}

/**
 * Reports divergent physical occurrences of one native logical session UUID.
 *
 * @param sessionId - Native Cursor session UUID shared by the occurrences.
 * @param occurrenceRefs - Opaque, deterministic references safe to present to callers.
 */
export class SessionAmbiguityError extends SessionIntegrityError<
  'SESSION_AMBIGUOUS',
  { sessionId: string; occurrenceCount: number; occurrenceRefs: string[]; remedy: string }
> {
  override readonly name = 'SessionAmbiguityError';

  constructor(sessionId: string, occurrenceRefs: string[]) {
    const ordered = [...new Set(occurrenceRefs)].sort(compareCodePoints);
    super('SESSION_AMBIGUOUS', 'The logical session has divergent source replicas.', {
      sessionId,
      occurrenceCount: ordered.length,
      occurrenceRefs: ordered,
      remedy: 'Inspect or reconcile the divergent Cursor source occurrences before retrying.',
    });
  }
}

/**
 * Reports that a direct session ID is not a member of the active workspace scope.
 *
 * @param sessionId - Native Cursor session UUID requested by the caller.
 * @param workspacePath - Active normalized workspace scope, when one was bound.
 */
export class SessionScopeMismatchError extends SessionIntegrityError<
  'SESSION_SCOPE_MISMATCH',
  { sessionId: string; workspacePath?: string; remedy: string }
> {
  override readonly name = 'SessionScopeMismatchError';

  constructor(sessionId: string, workspacePath?: string) {
    super('SESSION_SCOPE_MISMATCH', 'The session is not a member of the active workspace scope.', {
      sessionId,
      workspacePath,
      remedy: 'List sessions in the same workspace scope and reuse that scoped index or ID.',
    });
  }
}

/**
 * Refuses a workspace-scoped backup read when legacy archive metadata cannot identify every
 * off-scope Composer membership without extracting conversation databases.
 *
 * @param workspaceCount - Number of workspace databases declared by the manifest, when known.
 */
export class BackupWorkspaceScopeMetadataError extends SessionIntegrityError<
  'BACKUP_WORKSPACE_SCOPE_METADATA_REQUIRED',
  { workspaceCount: number | null; remedy: string }
> {
  override readonly name = 'BackupWorkspaceScopeMetadataError';

  constructor(workspaceCount: number | null) {
    super(
      'BACKUP_WORKSPACE_SCOPE_METADATA_REQUIRED',
      'This backup cannot be read safely with a workspace scope because it lacks a complete metadata-only Composer workspace inventory.',
      {
        workspaceCount,
        remedy:
          'Recreate the backup with cursor-history 0.18.0 or later, or omit the workspace filter only when reading every archived workspace is intended.',
      }
    );
  }
}

/**
 * Refuses a migration that cannot move exactly one eligible Composer occurrence safely.
 *
 * @param sessionId - Native Cursor session UUID selected for migration.
 * @param eligibility - Stable safe reason describing why the target is ineligible.
 */
export class UnsupportedSessionMigrationError extends SessionIntegrityError<
  'UNSUPPORTED_SESSION_MIGRATION',
  { sessionId: string; eligibility: string; remedy: string }
> {
  override readonly name = 'UnsupportedSessionMigrationError';

  constructor(sessionId: string, eligibility: string) {
    super(
      'UNSUPPORTED_SESSION_MIGRATION',
      'The selected logical session cannot be migrated safely.',
      {
        sessionId,
        eligibility,
        remedy: 'Select one unambiguous Composer-only physical session occurrence.',
      }
    );
  }
}

/**
 * Reports that a prepared migration target changed before the first write.
 *
 * @param sessionId - Native Cursor session UUID whose bound fingerprint changed.
 */
export class MigrationTargetChangedError extends SessionIntegrityError<
  'MIGRATION_TARGET_CHANGED',
  { sessionId: string; remedy: string }
> {
  override readonly name = 'MigrationTargetChangedError';

  constructor(sessionId: string) {
    super('MIGRATION_TARGET_CHANGED', 'The bound migration target changed after preview.', {
      sessionId,
      remedy: 'Run the migration preview again and review the newly bound target.',
    });
  }
}

/** SQLite operations that a selected driver can be required to support. */
export type DatabaseCapability = 'read' | 'readWrite' | 'onlineBackup';
export type DatabaseOperation = 'read-session' | 'migrate' | 'backup' | 'store-snapshot';

const DATABASE_CAPABILITY_ORDER: readonly DatabaseCapability[] = [
  'read',
  'readWrite',
  'onlineBackup',
];

function orderedDatabaseCapabilities(
  capabilities: Iterable<DatabaseCapability>
): DatabaseCapability[] {
  const values = new Set(capabilities);
  return DATABASE_CAPABILITY_ORDER.filter((capability) => values.has(capability));
}

/**
 * Reports that an explicitly selected SQLite driver lacks required operations.
 *
 * @param driver - Public driver name selected by the caller.
 * @param operation - Database operation whose complete capability set is required.
 * @param missingCapabilities - Required capabilities absent from the selected driver.
 * @param alternatives - Available capable driver names, excluding the selected driver.
 */
export class DatabaseCapabilityError extends SessionIntegrityError<
  'DATABASE_CAPABILITY_MISSING',
  {
    driver: string;
    operation: string;
    missingCapabilities: string[];
    alternatives: string[];
    remedy: string;
  }
> {
  override readonly name = 'DatabaseCapabilityError';

  constructor(
    driver: string,
    operation: DatabaseOperation,
    missingCapabilities: Iterable<DatabaseCapability>,
    alternatives: Iterable<string> = []
  ) {
    const missing = orderedDatabaseCapabilities(missingCapabilities);
    const capableAlternatives = [...new Set(alternatives)]
      .filter((name) => name !== driver)
      .sort(compareCodePoints);
    const remedy =
      capableAlternatives.length > 0
        ? `Use automatic selection or select a capable driver: ${capableAlternatives.join(', ')}.`
        : 'Install a capable SQLite provider or use a Node.js runtime exposing the required APIs.';
    super(
      'DATABASE_CAPABILITY_MISSING',
      `Database driver "${driver}" cannot perform ${operation}; missing capabilities: ${missing.join(', ')}. ${remedy}`,
      {
        driver,
        operation,
        missingCapabilities: missing,
        alternatives: capableAlternatives,
        remedy,
      }
    );
  }
}

/**
 * Reports that automatic selection found no installed driver with all required operations.
 *
 * @param operation - Database operation for which automatic selection failed.
 * @param requiredCapabilities - Complete capability set required by the operation.
 */
export class NoCapableDriverError extends SessionIntegrityError<
  'NO_CAPABLE_DATABASE_DRIVER',
  { operation: string; requiredCapabilities: string[]; remedies: string[] }
> {
  override readonly name = 'NoCapableDriverError';

  constructor(operation: DatabaseOperation, requiredCapabilities: Iterable<DatabaseCapability>) {
    const required = orderedDatabaseCapabilities(requiredCapabilities);
    const remedies = [
      'Install a capable better-sqlite3 provider.',
      'Use a Node.js runtime whose node:sqlite module exposes every required API.',
      'Review CURSOR_HISTORY_SQLITE_DRIVER or the operation-specific sqliteDriver setting.',
    ];
    super(
      'NO_CAPABLE_DATABASE_DRIVER',
      `No available SQLite driver can perform ${operation}; required capabilities: ${required.join(', ')}.`,
      {
        operation,
        requiredCapabilities: required,
        remedies,
      }
    );
  }
}

// Compatibility aliases preserve the initially drafted feature-016 export
// names while making every actual registry failure share one constructor.
export {
  DatabaseCapabilityError as DatabaseCapabilityMissingError,
  NoCapableDriverError as NoCapableDatabaseDriverError,
};

/** Safe structured details for a completed backup whose final mode could not be applied. */
export type BackupPublishedPermissionErrorDetails = {
  published: true;
  outputPath: string;
  /** True only when the final path was verified against the staged archive inode. */
  pathIdentityVerified: boolean;
  requestedMode: number;
  /** Observed permission bits, or null when the post-publication observation itself failed. */
  actualMode: number | null;
  remedy: string;
};

function formatPermissionMode(mode: number): string {
  return `0o${mode.toString(8).padStart(3, '0')}`;
}

/**
 * Reports that backup publication crossed its commit point but its requested mode did not.
 *
 * The rename or link is the publication commit point. `pathIdentityVerified` determines whether
 * `outputPath` was subsequently proven to refer to that exact archive inode. Callers must not
 * retry blindly or assume that either the absence or presence of an archive follows only from the
 * thrown error.
 *
 * @param outputPath - Final path selected for publication; trust it only when identity is verified.
 * @param requestedMode - Permission bits requested for the completed archive.
 * @param actualMode - Permission bits observed after failure, or null when mode inspection failed.
 * @param cause - Filesystem failure raised while inspecting or applying the requested mode.
 * @param pathIdentityVerified - Whether the final path still matched the staged archive inode.
 */
export class BackupPublishedPermissionError extends SessionIntegrityError<
  'BACKUP_PUBLISHED_PERMISSION_FAILED',
  BackupPublishedPermissionErrorDetails
> {
  override readonly name = 'BackupPublishedPermissionError';

  constructor(
    outputPath: string,
    requestedMode: number,
    actualMode: number | null,
    cause?: unknown,
    pathIdentityVerified = false
  ) {
    const requested = formatPermissionMode(requestedMode);
    const actual =
      actualMode === null ? 'unknown (mode inspection failed)' : formatPermissionMode(actualMode);
    const message = pathIdentityVerified
      ? `Backup archive was published at ${outputPath}, and that path still refers to the completed archive, but its requested permissions could not be applied (requested ${requested}, actual ${actual}).`
      : `Backup publication crossed its commit point, but the archive identity at ${outputPath} could not be verified after the permission failure (requested ${requested}, actual ${actual}). The actual mode is only the last safely observed archive-inode mode and does not describe the current output path.`;
    const remedy = pathIdentityVerified
      ? `Inspect the verified published archive, then apply ${requested} permissions manually. ` +
        'Do not retry with --force unless replacing this archive is intentional.'
      : 'Do not use or change permissions on the output path based on this error. Inspect the destination and establish which file, if any, is the completed archive before recovery. Do not retry with --force unless replacing the current path is intentional.';
    super('BACKUP_PUBLISHED_PERMISSION_FAILED', message, {
      published: true,
      outputPath,
      pathIdentityVerified,
      requestedMode,
      actualMode,
      remedy,
    });
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { configurable: true, value: cause });
    }
  }
}

/** Safe structured details for private archive names left after successful publication. */
export type BackupPublishedCleanupErrorDetails = {
  published: true;
  outputPath: string;
  /** True only when the final path still names the completed private-stage inode. */
  pathIdentityVerified: boolean;
  /** Paths proven to remain bound to the published archive inode. */
  residueCount: number;
  residuePaths: string[];
  /** Paths whose final identity could not be established and must not be deleted blindly. */
  unverifiedResidueCount: number;
  unverifiedResiduePaths: string[];
  remedy: string;
};

/**
 * Reports that archive publication committed but its owner-private sibling could not be removed.
 *
 * `pathIdentityVerified` governs whether callers may trust `outputPath`; residue paths identify only
 * private publication names that were still bound to the completed archive inode after retries.
 *
 * @param outputPath - Requested final archive path.
 * @param pathIdentityVerified - Whether the final path still names the published archive inode.
 * @param residuePaths - Sibling paths verified to remain bound to the published archive inode.
 * @param cause - Last filesystem cleanup or inspection failure.
 * @param unverifiedResiduePaths - Sibling paths whose final identity could not be established.
 */
export class BackupPublishedCleanupError extends SessionIntegrityError<
  'BACKUP_PUBLISHED_CLEANUP_FAILED',
  BackupPublishedCleanupErrorDetails
> {
  override readonly name = 'BackupPublishedCleanupError';

  constructor(
    outputPath: string,
    pathIdentityVerified: boolean,
    residuePaths: string[],
    cause?: unknown,
    unverifiedResiduePaths: string[] = []
  ) {
    const ordered = [...new Set(residuePaths)].sort(compareCodePoints);
    const unverified = [...new Set(unverifiedResiduePaths)].sort(compareCodePoints);
    const message = pathIdentityVerified
      ? `Backup archive was published at ${outputPath}, but cleanup of its private publication staging could not be completed.`
      : `Backup publication crossed its commit point, but the final archive identity at ${outputPath} could not be verified and cleanup of private publication staging could not be completed.`;
    const residueRemedy =
      unverified.length > 0
        ? ' Do not delete unverified residue paths until their identity has been established.'
        : '';
    const remedy =
      (pathIdentityVerified
        ? 'Keep or inspect the verified published archive and remove only verified private staging paths after confirming no backup operation is active.'
        : 'Treat the output path as untrusted, establish which file is the completed archive, and remove only verified private staging paths after confirming no backup operation is active.') +
      `${residueRemedy} Do not retry with --force.`;
    super('BACKUP_PUBLISHED_CLEANUP_FAILED', message, {
      published: true,
      outputPath,
      pathIdentityVerified,
      residueCount: ordered.length,
      residuePaths: ordered,
      unverifiedResidueCount: unverified.length,
      unverifiedResiduePaths: unverified,
      remedy,
    });
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { configurable: true, value: cause });
    }
  }
}

/**
 * Reports owner-private temporary paths that remained after exhaustive cleanup attempts.
 *
 * @param residuePaths - Paths only; conversation content is never included.
 * @param unverifiedResiduePaths - Paths whose identity could not be established and which callers
 * must not delete or modify blindly.
 */
export class TemporaryArtifactCleanupError extends SessionIntegrityError<
  'TEMPORARY_ARTIFACT_CLEANUP_FAILED',
  {
    residueCount: number;
    residuePaths: string[];
    unverifiedResidueCount: number;
    unverifiedResiduePaths: string[];
    remedy: string;
  }
> {
  override readonly name = 'TemporaryArtifactCleanupError';

  constructor(residuePaths: string[], unverifiedResiduePaths: string[] = []) {
    const ordered = [...new Set(residuePaths)].sort(compareCodePoints);
    const unverified = [...new Set(unverifiedResiduePaths)].sort(compareCodePoints);
    super(
      'TEMPORARY_ARTIFACT_CLEANUP_FAILED',
      'Private temporary artifacts could not be removed.',
      {
        residueCount: ordered.length,
        residuePaths: ordered,
        unverifiedResidueCount: unverified.length,
        unverifiedResiduePaths: unverified,
        remedy:
          'Remove only verified private temporary paths after confirming no operation is active. ' +
          'Do not delete unverified residue paths until their identity has been established.',
      }
    );
  }
}

/**
 * Reports a restore that failed after files were published and whose automatic rollback from the
 * restore safety copy did not fully complete (or that left newly created files behind).
 *
 * Restore keeps a verified copy of every replaced file before its first write. When a later step
 * fails it restores those files automatically; this error is thrown only when that rollback
 * itself failed. `safetyCopyDir` then names the directory holding the verified originals and its
 * `manifest.json`, so the user can copy the files back by hand (see `remedy`).
 *
 * @param publishedFileCount - Number of entries published before the restore failed.
 * @param residualFiles - Manifest-relative entries that were NOT returned to their prior state.
 * @param cause - Original restore failure, when available.
 * @param temporaryCleanupErrors - Additional owner-private cleanup failures to expose at top level.
 * @param recovery - Safety-copy location and rollback outcome, when a safety copy exists.
 */
export class RestoreRollbackError extends SessionIntegrityError<
  'RESTORE_ROLLBACK_INCOMPLETE',
  {
    publishedFileCount: number;
    residualFileCount: number;
    residualFiles: string[];
    residueCount: number;
    residuePaths: string[];
    unverifiedResidueCount: number;
    unverifiedResiduePaths: string[];
    safetyCopyDir?: string;
    rollbackFailureCount?: number;
    rollbackFailures?: string[];
    remedy: string;
  }
> {
  override readonly name = 'RestoreRollbackError';

  constructor(
    publishedFileCount: number,
    residualFiles: string[],
    cause?: unknown,
    temporaryCleanupErrors: readonly TemporaryArtifactCleanupError[] = [],
    recovery?: { safetyCopyDir?: string; rollbackFailures?: readonly string[] }
  ) {
    const ordered = [...new Set(residualFiles)].sort(compareCodePoints);
    const cleanupErrors = [
      ...(cause instanceof TemporaryArtifactCleanupError ? [cause] : []),
      ...temporaryCleanupErrors,
    ];
    const unverifiedResiduePaths = [
      ...new Set(cleanupErrors.flatMap((error) => error.details.unverifiedResiduePaths)),
    ].sort(compareCodePoints);
    const unverifiedResidueSet = new Set(unverifiedResiduePaths);
    const residuePaths = [...new Set(cleanupErrors.flatMap((error) => error.details.residuePaths))]
      .filter((path) => !unverifiedResidueSet.has(path))
      .sort(compareCodePoints);
    const cleanupRemedy =
      residuePaths.length > 0 || unverifiedResiduePaths.length > 0
        ? ' Remove only verified private temporary paths after confirming no operation is active; do not delete unverified paths blindly.'
        : '';
    const safetyCopyDir = recovery?.safetyCopyDir;
    const rollbackFailures = [...new Set(recovery?.rollbackFailures ?? [])].sort(compareCodePoints);
    const rollbackAttempted = recovery !== undefined;
    super(
      'RESTORE_ROLLBACK_INCOMPLETE',
      rollbackFailures.length > 0
        ? 'Restore failed after one or more files were published and automatic rollback from the safety copy did not complete.'
        : rollbackAttempted
          ? 'Restore failed after one or more files were published. Replaced files were rolled back from the safety copy; newly created files were left in place and are listed as residual.'
          : 'Restore failed after one or more files were published; automatic rollback was not attempted.',
      {
        publishedFileCount,
        residualFileCount: ordered.length,
        residualFiles: ordered,
        residueCount: residuePaths.length,
        residuePaths,
        unverifiedResidueCount: unverifiedResiduePaths.length,
        unverifiedResiduePaths,
        ...(safetyCopyDir === undefined ? {} : { safetyCopyDir }),
        ...(rollbackAttempted
          ? { rollbackFailureCount: rollbackFailures.length, rollbackFailures }
          : {}),
        remedy:
          (safetyCopyDir === undefined
            ? 'Stop Cursor, inspect the listed archive-relative destinations, and restore them from a known-good backup before retrying.'
            : `Stop Cursor, then copy the files listed in manifest.json inside the safety copy directory back to their original locations (each manifest path is relative to the Cursor User directory, the parent of workspaceStorage). The safety copy is never deleted automatically: ${safetyCopyDir}`) +
          cleanupRemedy,
      }
    );
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { configurable: true, value: cause });
    }
  }
}

/**
 * Refuses a restore because the verified pre-restore safety copy could not be created. Nothing in
 * the Cursor data directory was modified.
 *
 * @param reason - Content-free reason (for example `copy-failed`, `verify-failed`).
 * @param safetyCopyDir - Safety directory that was being written, when known.
 * @param cause - Underlying filesystem failure, when available.
 */
export class RestoreSafetyCopyError extends SessionIntegrityError<
  'RESTORE_SAFETY_COPY_FAILED',
  { reason: string; safetyCopyDir?: string; remedy: string }
> {
  override readonly name = 'RestoreSafetyCopyError';

  constructor(reason: string, safetyCopyDir?: string, cause?: unknown) {
    super(
      'RESTORE_SAFETY_COPY_FAILED',
      `Restore aborted before any change: the pre-restore safety copy could not be created and verified (${reason}).`,
      {
        reason,
        ...(safetyCopyDir === undefined ? {} : { safetyCopyDir }),
        remedy:
          'No Cursor file was modified. Check free disk space and permissions, or choose another safetyCopyDir outside Cursor data, then retry.',
      }
    );
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { configurable: true, value: cause });
    }
  }
}

/**
 * Refuses a forced restore into the platform-default (live) Cursor data directory without the
 * explicit `confirmLiveTarget` acknowledgement.
 *
 * @param targetPath - The live workspaceStorage directory that would be overwritten.
 */
export class LiveTargetNotConfirmedError extends SessionIntegrityError<
  'LIVE_TARGET_NOT_CONFIRMED',
  { targetPath: string; remedy: string }
> {
  override readonly name = 'LiveTargetNotConfirmedError';

  constructor(targetPath: string) {
    super(
      'LIVE_TARGET_NOT_CONFIRMED',
      'Refusing to overwrite the live Cursor data directory: force alone is not enough. Pass confirmLiveTarget: true (CLI: --yes or answer the prompt) after quitting Cursor.',
      {
        targetPath,
        remedy:
          'Quit Cursor, then retry with confirmLiveTarget: true, or restore into an explicit targetPath.',
      }
    );
  }
}

type ContextMismatchCode =
  | 'READ_CONTEXT_SOURCE_MISMATCH'
  | 'READ_CONTEXT_SCOPE_MISMATCH'
  | 'READ_CONTEXT_OPTIONS_MISMATCH'
  | 'READ_CONTEXT_DISPOSED';

/**
 * Base error for an immutable or disposed session read-context binding.
 *
 * @param code - Stable read-context mismatch or lifecycle code.
 * @param message - Safe human-readable explanation.
 * @param field - Conflicting option name, when the mismatch is option-specific.
 */
export class ReadContextError extends SessionIntegrityError<
  ContextMismatchCode,
  { remedy: string; field?: string }
> {
  override readonly name: string = 'ReadContextError';

  constructor(code: ContextMismatchCode, message: string, field?: string) {
    super(code, message, {
      field,
      remedy:
        code === 'READ_CONTEXT_DISPOSED'
          ? 'Create a new read context.'
          : 'Create a new read context with one immutable source, scope, and option binding.',
    });
  }
}

/** Reports reuse of a read context with a different data source. */
export class ReadContextSourceMismatchError extends ReadContextError {
  override readonly name = 'ReadContextSourceMismatchError';
  constructor() {
    super(
      'READ_CONTEXT_SOURCE_MISMATCH',
      'Read context data source does not match this operation.'
    );
  }
}

/** Reports reuse of a read context with a different workspace content scope. */
export class ReadContextScopeMismatchError extends ReadContextError {
  override readonly name = 'ReadContextScopeMismatchError';
  constructor() {
    super(
      'READ_CONTEXT_SCOPE_MISMATCH',
      'Read context workspace scope does not match this operation.'
    );
  }
}

/**
 * Reports per-call options that conflict with an already-bound read context.
 *
 * @param field - Conflicting public option name, when available.
 */
export class ReadContextOptionsMismatchError extends ReadContextError {
  override readonly name = 'ReadContextOptionsMismatchError';
  constructor(field?: string) {
    super(
      'READ_CONTEXT_OPTIONS_MISMATCH',
      'Caller-supplied read context conflicts with per-call options.',
      field
    );
  }
}

/** Reports use of a session read context after its idempotent disposal. */
export class ReadContextDisposedError extends ReadContextError {
  override readonly name = 'ReadContextDisposedError';
  constructor() {
    super('READ_CONTEXT_DISPOSED', 'Read context has already been disposed.');
  }
}

/**
 * Reports source text that cannot be decoded using the deterministic UTF-8 policy.
 *
 * @param sourceKind - Carrier whose text decoding failed.
 * @param outcome - Whether a safe contributor permits a partial result or the operation is fatal.
 */
export class SourceEncodingError extends SessionIntegrityError<
  'SOURCE_ENCODING_INVALID',
  { sourceKind: string; outcome: string; remedy: string }
> {
  override readonly name = 'SourceEncodingError';
  constructor(sourceKind: 'jsonl' | 'sqlite', outcome: 'partial' | 'fatal') {
    super('SOURCE_ENCODING_INVALID', 'Source text is not deterministic UTF-8.', {
      sourceKind,
      outcome,
      remedy: 'Repair or regenerate the Cursor source using UTF-8 without mixed encodings.',
    });
  }
}

/** Safe structured details emitted when an inclusive source-read bound is exceeded. */
export type SourceLimitErrorDetails = {
  policyVersion: 'source-read-limits/v1';
  sourceKind: 'jsonl' | 'sqlite' | 'zip';
  bound: string;
  unit: 'bytes' | 'records' | 'rows' | 'ratio';
  limit: number;
  observedAtLeast: number;
  outcome: 'partial' | 'fatal';
  retryableWithOverride: true;
  remedy: string;
};

/**
 * Reports the first observed source unit above an inclusive Source Read Limits v1 bound.
 *
 * @param details - Exact carrier, bound, unit, limit, observation, and outcome correlation.
 */
export class SourceLimitExceededError extends SessionIntegrityError<
  'SOURCE_LIMIT_EXCEEDED',
  SourceLimitErrorDetails
> {
  override readonly name = 'SourceLimitExceededError';
  constructor(
    details: Omit<SourceLimitErrorDetails, 'policyVersion' | 'retryableWithOverride' | 'remedy'>
  ) {
    super('SOURCE_LIMIT_EXCEEDED', `Source exceeded ${details.bound}.`, {
      ...details,
      policyVersion: 'source-read-limits/v1',
      retryableWithOverride: true,
      remedy:
        'Review the source and explicitly raise only this per-operation bound if it is trusted.',
    });
  }
}

/** Safe structured details emitted for an invalid source-read-limit override. */
export type SourceLimitConfigurationDetails = {
  invalidField: string;
  invalidValue?: string | number;
  receivedType: string;
  violatedConstraint: string;
  remedy: string;
};

/**
 * Reports an invalid Source Read Limits v1 override before payload I/O begins.
 *
 * @param invalidField - Public override field, or configuration location, that failed validation.
 * @param invalidValue - Caller value; only safe primitive values are retained in details.
 * @param violatedConstraint - Stable explanation of the failed validation rule.
 */
export class SourceLimitConfigurationError extends SessionIntegrityError<
  'SOURCE_LIMIT_CONFIGURATION_INVALID',
  SourceLimitConfigurationDetails
> {
  override readonly name = 'SourceLimitConfigurationError';
  constructor(invalidField: string, invalidValue: unknown, violatedConstraint: string) {
    const safeValue =
      typeof invalidValue === 'string' || typeof invalidValue === 'number'
        ? invalidValue
        : undefined;
    super('SOURCE_LIMIT_CONFIGURATION_INVALID', 'Source read limit configuration is invalid.', {
      invalidField,
      invalidValue: safeValue,
      receivedType: invalidValue === null ? 'null' : typeof invalidValue,
      violatedConstraint,
      remedy:
        'Use a documented positive safe-integer bound and preserve the required cross-field relationships.',
    });
  }
}

/**
 * Test whether an unknown value is a feature-016 typed integrity failure.
 *
 * @param error - Unknown caught value.
 * @returns True when the value is a {@link SessionIntegrityError}.
 */
export function isSessionIntegrityError(error: unknown): error is SessionIntegrityError {
  return error instanceof SessionIntegrityError;
}
