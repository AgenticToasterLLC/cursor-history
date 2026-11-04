// Test-only worker deps: REAL fingerprint/store/read, but the build sleeps after
// the fingerprint (i.e. mid-build) so tests can kill the worker or process
// deterministically. Delay comes from CH_E2E_BUILD_DELAY_MS (inherited by workers).
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const distRoot = join(process.cwd(), 'dist');
const fp = await import(pathToFileURL(join(distRoot, 'core', 'catalog', 'fingerprint.js')).href);
const delay = Number(process.env.CH_E2E_BUILD_DELAY_MS ?? '15000');

export const catalogDeps = {
  computeSourceFingerprint: async (inputs) => {
    const result = await fp.computeSourceFingerprint(inputs);
    await new Promise((r) => setTimeout(r, delay));
    return result;
  },
};
