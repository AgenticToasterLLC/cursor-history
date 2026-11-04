/**
 * Cross-platform helpers for tests that plant a fake "live" Cursor tree at the platform default.
 * Always call AFTER the home/APPDATA env vars have been redirected into a temp dir, so the
 * product resolver can never point at a real user directory.
 */
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { getDefaultCursorDataPath } from '../../src/lib/platform.js';

/** Env vars that influence the platform default Cursor / cache locations. */
export const PLATFORM_ENV_NAMES = [
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
] as const;

/**
 * Redirect every platform-default location into `root` (mutates process.env).
 * Returns a function restoring the previous values.
 */
export function redirectPlatformEnv(root: string): () => void {
  const prior = new Map<string, string | undefined>();
  for (const name of PLATFORM_ENV_NAMES) prior.set(name, process.env[name]);
  process.env['APPDATA'] = join(root, 'appdata');
  process.env['LOCALAPPDATA'] = join(root, 'local');
  process.env['USERPROFILE'] = join(root, 'home');
  process.env['HOME'] = join(root, 'home');
  delete process.env['XDG_CONFIG_HOME'];
  delete process.env['XDG_CACHE_HOME'];
  return () => {
    for (const name of PLATFORM_ENV_NAMES) {
      const value = prior.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/** The `<...>/Cursor/User` directory the product treats as the live tree under the current env. */
export function platformDefaultUserDir(): string {
  const dir = dirname(getDefaultCursorDataPath());
  // Refuse to hand out a real user directory: the env must already point into the temp dir.
  const rel = relative(resolve(tmpdir()), resolve(dir));
  if (rel === '' || rel.startsWith('..') || resolve(rel) === rel) {
    throw new Error(
      `platformDefaultUserDir resolved outside the temp dir (${dir}); redirect HOME/APPDATA first`
    );
  }
  return dir;
}

/**
 * The platform-default `<...>/Cursor/User` directory a child process would resolve with `env`
 * (HOME/USERPROFILE/APPDATA), computed with the product resolver. process.env is restored.
 */
export function platformDefaultUserDirFor(env: Record<string, string | undefined>): string {
  const names = ['APPDATA', 'USERPROFILE', 'HOME'] as const;
  const prior = new Map<string, string | undefined>();
  for (const name of names) {
    prior.set(name, process.env[name]);
    if (env[name] === undefined) delete process.env[name];
    else process.env[name] = env[name];
  }
  try {
    return platformDefaultUserDir();
  } finally {
    for (const name of names) {
      const value = prior.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
