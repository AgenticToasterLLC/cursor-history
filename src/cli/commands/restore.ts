/**
 * Restore command - restore chat history from a backup file
 */

import type { Command } from 'commander';
import pc from 'picocolors';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { restoreBackup, validateBackup } from '../../core/backup.js';
import { isLiveDefaultTarget } from '../../core/restore-safety.js';
import type { RestoreProgress, RestoreResult, SourceReadLimitsOverride } from '../../core/types.js';
import { CliError, handleError, ExitCode } from '../errors.js';
import { expandPath, contractPath, getCursorDataPath } from '../../lib/platform.js';
import { validateCliSourceLimitOverrides } from '../source-limit-option.js';

interface RestoreCommandOptions {
  target?: string;
  force?: boolean;
  yes?: boolean;
  allowPartial?: boolean;
  dryRun?: boolean;
  json?: boolean;
  dataPath?: string;
}

/**
 * True when `path` looks like a Cursor `workspaceStorage` directory: it is named
 * `workspaceStorage`, or it already contains workspace directories (each holding a
 * `workspace.json`). Restore treats its parent as the Cursor `User` directory, so passing the
 * `User` directory itself (or anything else) would write into the wrong place.
 */
export function looksLikeWorkspaceStorage(path: string): boolean {
  if (basename(path).toLowerCase() === 'workspacestorage') return true;
  try {
    if (!statSync(path).isDirectory()) return false;
    return readdirSync(path, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && existsSync(join(path, entry.name, 'workspace.json'))
    );
  } catch {
    return false;
  }
}

/** Refuse a --target/--data-path that is not a workspaceStorage directory. */
export function assertWorkspaceStorageTarget(path: string, origin: string): void {
  if (looksLikeWorkspaceStorage(path)) return;
  throw new CliError(
    `${origin} must be the Cursor "workspaceStorage" directory (for example .../Cursor/User/workspaceStorage), not "${path}". Restore uses its parent as the Cursor User directory and would write into the wrong place.`,
    ExitCode.USAGE_ERROR
  );
}

async function confirmLiveRestore(
  fileCount: number,
  target: string,
  safetyRoot: string | undefined
): Promise<boolean> {
  const lines = [
    pc.yellow('WARNING: this will overwrite your LIVE Cursor data.'),
    `  Target:         ${contractPath(target)}`,
    `  Files replaced: ${fileCount}`,
    `  Safety copy:    ${safetyRoot ? contractPath(safetyRoot) : 'cursor-history cache directory'} (timestamped folder; never deleted automatically)`,
    '  Quit Cursor completely before continuing.',
  ];
  console.error(lines.join('\n'));
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question("Type 'yes' to overwrite the live Cursor data: ");
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * Format duration for display
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * T050: Progress display for restore command
 */
function displayProgress(progress: RestoreProgress): void {
  const phases: Record<RestoreProgress['phase'], string> = {
    validating: '🔍 Validating backup integrity...',
    extracting: '📦 Extracting files...',
    finalizing: '✨ Finalizing restore...',
  };

  const phaseText = phases[progress.phase];
  const fileProgress =
    progress.totalFiles > 0 ? ` [${progress.filesCompleted}/${progress.totalFiles}]` : '';
  const currentFile = progress.currentFile ? ` ${pc.dim(progress.currentFile)}` : '';

  // Show integrity status during validation
  const integrityText =
    progress.phase === 'validating' && progress.integrityStatus === 'warnings'
      ? pc.yellow(' (some files have warnings)')
      : '';

  // Clear line and print progress
  process.stdout.write(`\r${phaseText}${fileProgress}${currentFile}${integrityText}`.padEnd(80));
}

/**
 * Format restore result for JSON output
 */
function formatRestoreResultJson(result: RestoreResult): string {
  return JSON.stringify(
    {
      success: result.success,
      targetPath: result.targetPath,
      filesRestored: result.filesRestored,
      durationMs: result.durationMs,
      ...(result.warnings.length > 0 && { warnings: result.warnings }),
      ...(result.dryRun && { dryRun: true }),
      ...(result.blockingConditions && { blockingConditions: result.blockingConditions }),
      ...(result.filesToReplace && { filesToReplace: result.filesToReplace.length }),
      ...(result.safetyCopy && { safetyCopy: result.safetyCopy }),
      ...(result.safetyCopyRoot && { safetyCopyRoot: result.safetyCopyRoot }),
      ...(result.partial && { partial: true, skippedFiles: result.skippedFiles }),
      ...(result.rolledBack && { rolledBack: true }),
      ...(result.error && { error: result.error }),
    },
    null,
    2
  );
}

/**
 * Format restore result for human-readable output
 */
function formatRestoreResult(result: RestoreResult): string {
  const lines: string[] = [];

  if (result.success) {
    lines.push(
      result.dryRun
        ? pc.green('✓ Dry run: restore would proceed (nothing was written)')
        : pc.green('✓ Backup restored successfully!')
    );
    lines.push('');
    lines.push(`  ${pc.bold('Target:')} ${contractPath(result.targetPath)}`);
    lines.push(`  ${pc.bold('Files restored:')} ${result.filesRestored}`);
    lines.push(`  ${pc.bold('Duration:')} ${formatDuration(result.durationMs)}`);
    if (result.partial) {
      lines.push(
        pc.yellow(
          `  PARTIAL RESTORE: ${result.skippedFiles?.length ?? 0} corrupt file(s) were skipped.`
        )
      );
    }
    if (result.safetyCopy) {
      lines.push(
        `  ${pc.bold('Safety copy:')} ${contractPath(result.safetyCopy.directory)} (${result.safetyCopy.fileCount} file(s))`
      );
      lines.push(
        pc.dim(
          '  To roll back: quit Cursor, then copy the files listed in manifest.json back into the Cursor User directory.'
        )
      );
    }

    if (result.warnings.length > 0) {
      lines.push('');
      lines.push(pc.yellow('  Warnings:'));
      for (const warning of result.warnings) {
        lines.push(`    ${pc.dim('•')} ${warning}`);
      }
    }
  } else {
    lines.push(pc.red(result.dryRun ? '✗ Dry run: restore would be refused' : '✗ Restore failed'));
    lines.push('');
    if (result.error) {
      lines.push(`  ${pc.bold('Error:')} ${result.error}`);
    }
    if (result.safetyCopy) {
      lines.push(
        `  ${pc.bold('Safety copy:')} ${contractPath(result.safetyCopy.directory)} (never deleted automatically)`
      );
    }
  }

  return lines.join('\n');
}

/**
 * Register the restore command
 */
export function registerRestoreCommand(program: Command): void {
  program
    .command('restore <backup>')
    .description('Restore chat history from a backup file')
    .option(
      '-t, --target <path>',
      'Target Cursor data path (default: platform-specific Cursor data directory)'
    )
    .option(
      '-f, --force',
      'Overwrite validated Cursor destinations; never bypass integrity or path-safety checks'
    )
    .option('-y, --yes', 'Confirm overwriting the live Cursor data directory without prompting')
    .option(
      '--allow-partial',
      'Restore only intact entries when some fail their checksum (default: abort without writing)'
    )
    .option('--dry-run', 'Validate and report what would happen without writing anything')
    .action(async (backupArg: string, options: RestoreCommandOptions, command: Command) => {
      const globalOptions = command.parent?.opts() as {
        json?: boolean;
        dataPath?: string;
        sourceLimit?: SourceReadLimitsOverride;
      };
      const useJson = options.json ?? globalOptions?.json ?? false;
      const customPath = options.dataPath ?? globalOptions?.dataPath;

      // Resolve backup path
      const backupPath = expandPath(backupArg);

      try {
        const sourceReadLimits = validateCliSourceLimitOverrides(globalOptions?.sourceLimit);
        // T051: Check if backup file exists
        if (!existsSync(backupPath)) {
          if (useJson) {
            throw new CliError(
              'Backup file not found',
              ExitCode.USAGE_ERROR,
              undefined,
              undefined,
              { error: 'Backup file not found', path: backupPath }
            );
          } else {
            console.error(pc.red('Backup file not found:'));
            console.error(pc.dim(`  ${backupPath}`));
          }
          process.exit(ExitCode.USAGE_ERROR);
        }

        // T052: Validate backup before attempting restore
        const validation = await validateBackup(backupPath, {
          sourceReadLimits,
        });
        if (validation.status === 'invalid') {
          if (useJson) {
            throw new CliError(
              'Invalid or corrupted backup',
              ExitCode.NOT_FOUND,
              undefined,
              undefined,
              { error: 'Invalid or corrupted backup', errors: validation.errors }
            );
          } else {
            console.error(pc.red('Invalid or corrupted backup file:'));
            for (const err of validation.errors) {
              console.error(pc.dim(`  ${err}`));
            }
          }
          process.exit(ExitCode.NOT_FOUND);
        }

        // Show warning for backups with integrity issues
        if (validation.status === 'warnings' && !useJson) {
          console.log(
            pc.yellow(
              `Warning: Backup has ${validation.corruptedFiles.length} file(s) with checksum mismatches.`
            )
          );
          console.log(
            pc.dim(
              options.allowPartial
                ? 'These files will be skipped; only intact files will be restored.\n'
                : 'Restore will abort without writing. Use --allow-partial to restore only the intact files.\n'
            )
          );
        }

        // Resolve target path if provided
        const targetPath = options.target
          ? expandPath(options.target)
          : customPath
            ? expandPath(customPath)
            : undefined;

        if (options.target) assertWorkspaceStorageTarget(targetPath!, '--target');
        else if (customPath) assertWorkspaceStorageTarget(targetPath!, '--data-path');

        // Show progress if not JSON mode
        const onProgress = useJson ? undefined : displayProgress;
        const force = options.force ?? false;
        const allowPartial = options.allowPartial ?? false;
        const live = force && isLiveDefaultTarget(targetPath ?? getCursorDataPath());
        let confirmLiveTarget = false;

        if (live || options.dryRun) {
          // Preview first: blocking conditions and the number of files that would be replaced.
          const preview = await restoreBackup({
            backupPath,
            targetPath,
            force,
            allowPartial,
            dryRun: true,
            confirmLiveTarget: true,
            sourceReadLimits,
          });
          if (options.dryRun || !preview.success) {
            console.log(useJson ? formatRestoreResultJson(preview) : formatRestoreResult(preview));
            process.exit(preview.success ? 0 : ExitCode.GENERAL_ERROR);
          }
          if (live) {
            if (options.yes) {
              confirmLiveTarget = true;
            } else if (useJson || !process.stdin.isTTY) {
              throw new CliError(
                'Refusing to overwrite the live Cursor data directory without confirmation. Re-run with --yes after quitting Cursor.',
                ExitCode.USAGE_ERROR
              );
            } else {
              confirmLiveTarget = await confirmLiveRestore(
                preview.filesToReplace?.length ?? 0,
                targetPath ?? getCursorDataPath(),
                preview.safetyCopyRoot
              );
              if (!confirmLiveTarget) {
                console.error(pc.red('Restore cancelled; nothing was changed.'));
                process.exit(ExitCode.USAGE_ERROR);
              }
            }
          }
        }

        // Perform restore
        const result = await restoreBackup({
          backupPath,
          targetPath,
          force,
          allowPartial,
          confirmLiveTarget,
          sourceReadLimits,
          onProgress,
        });

        // Clear progress line
        if (!useJson) {
          process.stdout.write('\r'.padEnd(80) + '\r');
        }

        // Handle different error cases with appropriate exit codes
        if (!result.success) {
          // T053: Target exists without --force
          if (result.error?.includes('already has Cursor data')) {
            if (useJson) {
              throw new CliError(
                result.error ?? 'Target directory already has Cursor data.',
                ExitCode.IO_ERROR,
                undefined,
                undefined,
                JSON.parse(formatRestoreResultJson(result)) as Record<string, unknown>
              );
            } else {
              console.error(pc.red('Target directory already has Cursor data.'));
              console.error(pc.dim('Use --force to overwrite existing data.'));
            }
            process.exit(ExitCode.IO_ERROR);
          }

          // T054: Integrity check failures
          if (result.error?.includes('integrity') || result.error?.includes('checksum')) {
            if (useJson) {
              throw new CliError(
                result.error ?? 'Backup integrity check failed.',
                ExitCode.INTEGRITY_ERROR,
                undefined,
                undefined,
                JSON.parse(formatRestoreResultJson(result)) as Record<string, unknown>
              );
            } else {
              console.error(pc.red('Backup integrity check failed.'));
              console.error(pc.dim(result.error));
            }
            process.exit(5); // Special exit code for integrity failures
          }

          // Generic error
          if (useJson) {
            throw new CliError(
              result.error ?? 'Restore failed.',
              ExitCode.GENERAL_ERROR,
              undefined,
              undefined,
              JSON.parse(formatRestoreResultJson(result)) as Record<string, unknown>
            );
          } else {
            console.error(formatRestoreResult(result));
          }
          process.exit(ExitCode.GENERAL_ERROR);
        }

        // Success
        if (useJson) {
          console.log(formatRestoreResultJson(result));
        } else {
          console.log(formatRestoreResult(result));
        }
      } catch (error) {
        handleError(error, { json: useJson });
      }
    });
}
