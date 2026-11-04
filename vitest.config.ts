import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Fixture-only defaults: tests on synthetic data must not probe the developer's running
    // Cursor (the guard ignores this flag for the platform-default Cursor directories) and must
    // not write safety copies or catalog sidecars into the real per-user cache directory.
    env: {
      CURSOR_HISTORY_SKIP_RUNNING_CHECK: '1',
      CURSOR_HISTORY_SAFETY_DIR: join(tmpdir(), 'cursor-history-test-safety'),
      CURSOR_HISTORY_RESTORE_SAFETY_DIR: join(tmpdir(), 'cursor-history-vitest-restore-safety'),
      CURSOR_HISTORY_INDEX_PATH: join(tmpdir(), 'cursor-history-vitest-catalog', 'catalog-v2.sqlite'),
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
