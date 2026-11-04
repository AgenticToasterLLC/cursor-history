/**
 * Shared pre-write confirmation for `migrate` and `migrate-session`.
 *
 * Migration writes into Cursor's live databases, so a real (non-dry) run prints
 * a warning to stderr and requires explicit consent: an interactive
 * `Type "migrate" to continue:` prompt, or `--yes` when stdin/stderr is not a
 * TTY or `--json` output is requested.
 */
import { createInterface } from 'node:readline/promises';
import { defaultSafetyBaseDir } from '../core/migrate-safety.js';
import { CursorRunningError } from '../core/write-guard.js';
import { CliError, ExitCode } from './errors.js';

/** Exact confirmation word typed at the interactive prompt. */
export const CONFIRMATION_WORD = 'migrate';

/** Prompt text shown on stderr. */
export const CONFIRMATION_PROMPT = `Type "${CONFIRMATION_WORD}" to continue: `;

/** Facts gathered by a read-only preflight (dry run) for the warning. */
export interface MigrationPreflight {
  /** What will change, for example "3 session(s) moved to /dest". */
  readonly description: string;
  readonly safetyCopyEstimateBytes?: number;
  readonly blockers?: ReadonlyArray<{ code: string; message: string; evidence: string[] }>;
}

export interface ConfirmOptions {
  readonly yes?: boolean;
  readonly json?: boolean;
  readonly safetyDir?: string;
}

/** True when a prompt can be answered interactively. */
export function isInteractive(json: boolean | undefined): boolean {
  return !json && process.stdin.isTTY === true && process.stderr.isTTY === true;
}

/** Throw before any work when consent cannot be obtained. */
export function assertConfirmationPossible(options: ConfirmOptions): void {
  if (options.yes || isInteractive(options.json)) return;
  throw new CliError(
    'Refusing to modify Cursor data without confirmation. This command writes to Cursor databases; re-run with --yes to confirm (Cursor must be closed), or use --dry-run to preview.',
    ExitCode.USAGE_ERROR,
    'CONFIRMATION_REQUIRED'
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${String(Math.ceil(bytes / 1024))} KiB`;
}

/** Build the warning lines (plain text; the caller colors if desired). */
export function buildWarning(preflight: MigrationPreflight, options: ConfirmOptions): string[] {
  const where = options.safetyDir ?? defaultSafetyBaseDir();
  const lines = [
    'WARNING: this will modify Cursor databases (global state.vscdb and the workspace state.vscdb files).',
    `  Change: ${preflight.description}`,
    `  Before writing, a consistent safety copy is saved under: ${where}`,
  ];
  if (preflight.safetyCopyEstimateBytes !== undefined) {
    lines.push(
      `  Estimated safety copy size: ${formatBytes(preflight.safetyCopyEstimateBytes)} (copying a large global database can take minutes)`
    );
  }
  lines.push('  Safety copies are never deleted automatically. Cursor must be closed.');
  return lines;
}

/**
 * Show the warning and obtain consent, or throw.
 *
 * @throws CursorRunningError when the preflight already shows Cursor running.
 * @throws CliError (`CONFIRMATION_REQUIRED`) when consent is missing or wrong.
 */
export async function confirmMigrationWrite(
  preflight: MigrationPreflight,
  options: ConfirmOptions
): Promise<void> {
  const running = preflight.blockers?.find((blocker) => blocker.code === 'CURSOR_RUNNING');
  if (running) throw new CursorRunningError('migrate', running.evidence);
  assertConfirmationPossible(options);
  // In --json mode stderr is reserved for the single fatal-error object; results carry safetyCopy.
  if (!options.json) {
    process.stderr.write(`${buildWarning(preflight, options).join('\n')}\n`);
  }
  if (options.yes) return;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(CONFIRMATION_PROMPT)).trim();
    if (answer !== CONFIRMATION_WORD) {
      throw new CliError(
        'Migration cancelled: confirmation not given. Nothing was changed.',
        ExitCode.USAGE_ERROR,
        'CONFIRMATION_REQUIRED'
      );
    }
  } finally {
    rl.close();
  }
}
