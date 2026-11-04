import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { defaultCatalogPath, isInsideCursorDataDir } from '../../../src/core/catalog/paths.js';
import { CATALOG_SCHEMA_VERSION } from '../../../src/core/catalog/contract.js';
import { digestScopeKey } from '../../../src/core/catalog/scope-key.js';

describe('catalog paths', () => {
  it('honors CURSOR_HISTORY_INDEX_PATH', () => {
    const p = join(homedir(), 'x', 'idx.sqlite');
    expect(defaultCatalogPath({ CURSOR_HISTORY_INDEX_PATH: p })).toBe(resolve(p));
  });

  it('uses a platform cache dir by default', () => {
    const p = defaultCatalogPath({
      LOCALAPPDATA: join(homedir(), 'AppData', 'Local'),
      XDG_CACHE_HOME: join(homedir(), 'xdg'),
    });
    expect(p).toMatch(
      new RegExp(`cursor-history[\\\\/]catalog-v${CATALOG_SCHEMA_VERSION}\\.sqlite$`, 'u')
    );
  });

  it('refuses paths inside Cursor data dirs', () => {
    expect(() =>
      defaultCatalogPath({ CURSOR_HISTORY_INDEX_PATH: join(homedir(), '.cursor', 'a.sqlite') })
    ).toThrow(/Cursor/u);
    expect(
      isInsideCursorDataDir(join(homedir(), 'AppData', 'Roaming', 'Cursor', 'User', 'x'))
    ).toBe(true);
    expect(isInsideCursorDataDir(join(homedir(), 'cache', 'x'))).toBe(false);
  });

  it('digests scope keys independent of key order', () => {
    const a = { a: 1, b: { y: 1, x: 2 } } as never;
    const b = { b: { x: 2, y: 1 }, a: 1 } as never;
    expect(digestScopeKey(a)).toBe(digestScopeKey(b));
    expect(digestScopeKey(a)).toMatch(/^[0-9a-f]{64}$/u);
  });
});
