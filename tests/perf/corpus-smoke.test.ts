import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { listSessionSummaries } from '../../src/lib/index.js';

// @ts-expect-error - plain ESM script without type declarations
import { generateCorpus, PRESETS } from '../../scripts/perf/generate-corpus.mjs';

describe('perf corpus generator smoke', () => {
  let root: string;
  let storeRoot: string;
  let previousStoreRoot: string | undefined;
  let manifest: { composers: number; workspaces: number };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'cursor-history-perf-smoke-'));
    storeRoot = join(root, 'empty-store');
    previousStoreRoot = process.env['CURSOR_STORE_ROOT'];
    process.env['CURSOR_STORE_ROOT'] = storeRoot;
    manifest = await generateCorpus({
      scale: 'small',
      out: join(root, 'corpus'),
      seed: 7,
      ...PRESETS.small,
      schema: 'real',
      force: true,
    });
  });

  afterAll(() => {
    if (previousStoreRoot === undefined) delete process.env['CURSOR_STORE_ROOT'];
    else process.env['CURSOR_STORE_ROOT'] = previousStoreRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it('lists every generated composer from the small corpus', async () => {
    const result = await listSessionSummaries({
      dataPath: join(root, 'corpus', 'User', 'workspaceStorage'),
      limit: 1000,
    });
    expect(result.pagination.total).toBe(manifest.composers);
  }, 30_000);
});
