import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBackup, restoreBackup, validateBackup } from '../../src/lib/backup.js';
import {
  createSessionIntegrityFixtureRoot,
  seedConflictingWorkspaceCorpus,
  type SessionIntegrityFixtureRoot,
} from '../helpers/session-integrity-fixtures.js';

// Regression for the Windows "backup hangs" report: core backup/restore used a private copy of
// the platform defaults that ignored CURSOR_DATA_PATH, so an env-isolated caller silently backed
// up (and restored into) the real per-user Cursor directory. The round trip below therefore
// relies only on the environment, with APPDATA/home redirected so a regression cannot reach real
// data.
const ENV_NAMES = ['CURSOR_DATA_PATH', 'APPDATA', 'USERPROFILE', 'HOME'] as const;

describe('backup/restore round trip resolved from the environment', () => {
  let fixture: SessionIntegrityFixtureRoot;
  const prior = new Map<string, string | undefined>();

  beforeEach(() => {
    fixture = createSessionIntegrityFixtureRoot('backup-roundtrip-');
    seedConflictingWorkspaceCorpus(fixture);
    for (const name of ENV_NAMES) prior.set(name, process.env[name]);
    process.env['APPDATA'] = join(fixture.root, 'empty-appdata');
    process.env['USERPROFILE'] = join(fixture.root, 'empty-home');
    process.env['HOME'] = join(fixture.root, 'empty-home');
    process.env['CURSOR_DATA_PATH'] = fixture.workspaceStorage;
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      const value = prior.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fixture.cleanup();
  });

  it('completes within a bounded time and yields a valid archive', async () => {
    const started = Date.now();
    const outputPath = join(fixture.root, 'roundtrip.zip');
    const created = await createBackup({ outputPath });
    expect(created.success, created.error).toBe(true);
    expect(created.manifest.stats.sessionCount).toBe(2);
    expect(existsSync(outputPath)).toBe(true);

    const validation = await validateBackup(outputPath);
    expect(validation.status).toBe('valid');

    const restored = await restoreBackup({ backupPath: outputPath, force: true });
    expect(restored.success, restored.error).toBe(true);
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 30_000);
});
