import { createHash } from 'node:crypto';

import type { CatalogScopeKey } from './contract.js';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) out[key] = canonicalize(source[key]);
    }
    return out;
  }
  return value;
}

/** sha256 hex of the canonical (recursively sorted-key) JSON of a scope key. */
export function digestScopeKey(key: CatalogScopeKey): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(key)))
    .digest('hex');
}
