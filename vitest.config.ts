import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Fixture-only defaults: migrations on synthetic data must neither probe the developer's
    // running Cursor nor write safety copies into the real per-user cache directory.
    env: {
      CURSOR_HISTORY_SKIP_RUNNING_CHECK: '1',
      CURSOR_HISTORY_SAFETY_DIR: join(tmpdir(), 'cursor-history-test-safety'),
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
