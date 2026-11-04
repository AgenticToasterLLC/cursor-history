import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Fixture restores must not depend on a developer's running Cursor. The guard ignores this
    // flag for any database inside the platform-default Cursor directories.
    env: {
      CURSOR_HISTORY_SKIP_RUNNING_CHECK: '1',
      // Restore safety copies from fixture restores stay in the temp dir, not the user cache.
      CURSOR_HISTORY_RESTORE_SAFETY_DIR: join(tmpdir(), 'cursor-history-vitest-restore-safety'),
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts'],
      thresholds: {
        'src/core/**.ts': {
          statements: 80,
        },
        'src/lib/**.ts': {
          statements: 70,
        },
        'src/cli/**.ts': {
          statements: 50,
        },
      },
    },
  },
});
