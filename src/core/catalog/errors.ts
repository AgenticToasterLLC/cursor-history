/** Stable error code for an unusable catalog sidecar. */
export const CATALOG_UNAVAILABLE_CODE = 'CATALOG_UNAVAILABLE' as const;

/**
 * The sidecar catalog cannot be opened, created or recovered. The message is
 * content-free (no paths, no session data); callers fall back to a direct read.
 */
export class CatalogUnavailableError extends Error {
  override readonly name = 'CatalogUnavailableError';
  readonly code = CATALOG_UNAVAILABLE_CODE;

  constructor(message = 'Catalog sidecar is unavailable') {
    super(message);
    if (Error.captureStackTrace) Error.captureStackTrace(this, CatalogUnavailableError);
  }
}
