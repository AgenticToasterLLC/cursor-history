/**
 * Overwrite safety for caller-chosen CLI output files: an explicit truncation
 * warning, a typed confirmation (interactive) or `--yes` (non-interactive),
 * and an atomic write that never truncates the target in place.
 */
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { OverwriteNotConfirmedError } from './errors.js';

/** The exact word an interactive user must type to approve an overwrite. */
export const OVERWRITE_CONFIRMATION_WORD = 'overwrite';

/** Prompt text shown on stderr in an interactive terminal. */
export const OVERWRITE_PROMPT = `Type "${OVERWRITE_CONFIRMATION_WORD}" to continue: `;

/** Injectable environment so the prompt can be tested without a real TTY. */
export interface ConfirmationEnvironment {
  input?: Readable;
  output?: Writable;
  /** Whether stdin is an interactive terminal. Defaults to `process.stdin.isTTY`. */
  interactive?: boolean;
}

export interface OverwriteConfirmationOptions extends ConfirmationEnvironment {
  /** `--yes`: explicit non-interactive approval. */
  yes?: boolean;
  /** `--json`: never prompt, even in a TTY. */
  json?: boolean;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Warning line printed to stderr before an existing file is truncated. */
export function formatTruncationWarning(path: string, sizeBytes: number): string {
  return `WARNING: ${path} already exists (${formatSize(sizeBytes)}) and will be TRUNCATED and overwritten. This cannot be undone.`;
}

/**
 * Ask for the typed confirmation word.
 *
 * @returns True only when the answer is exactly `overwrite`.
 */
export async function promptOverwrite(
  input: Readable = process.stdin,
  output: Writable = process.stderr
): Promise<boolean> {
  const rl = createInterface({ input, output, terminal: false });
  try {
    const closed = new Promise<undefined>((resolve) => rl.once('close', () => resolve(undefined)));
    const answer = await Promise.race([rl.question(OVERWRITE_PROMPT), closed]);
    return answer === OVERWRITE_CONFIRMATION_WORD;
  } finally {
    rl.close();
  }
}

/**
 * Warn that `path` will be truncated and require confirmation.
 *
 * @throws OverwriteNotConfirmedError when not confirmed (usage error exit code).
 */
export async function confirmOverwrite(
  path: string,
  options: OverwriteConfirmationOptions = {}
): Promise<void> {
  const output = options.output ?? process.stderr;
  let size = 0;
  try {
    size = lstatSync(path).size;
  } catch {
    // Reported as 0 B; the write path surfaces real errors.
  }
  output.write(`${formatTruncationWarning(path, size)}\n`);
  if (options.yes) return;
  const interactive = (options.interactive ?? process.stdin.isTTY === true) && !options.json;
  if (!interactive) {
    throw new OverwriteNotConfirmedError(
      `Refusing to overwrite existing file without confirmation: ${path}\n` +
        'Pass --yes together with --force to confirm non-interactively.'
    );
  }
  if (!(await promptOverwrite(options.input ?? process.stdin, output))) {
    throw new OverwriteNotConfirmedError('Overwrite not confirmed; nothing was changed.');
  }
}

/**
 * Write via a sibling temp file and rename over the target so a crash can
 * never leave a truncated or half-written file.
 */
export function writeFileAtomic(path: string, content: string): void {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx');
    writeFileSync(fd, content, 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best effort
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      // temp may not exist
    }
    throw error;
  }
}
