// Test-only deps module for real worker threads: the "store" writes published snapshots to JSON files.
const fs = require('node:fs');
const crypto = require('node:crypto');
exports.catalogDeps = {
  digestScopeKey: (k) => crypto.createHash('sha256').update(JSON.stringify(k)).digest('hex'),
  computeSourceFingerprint: async () => ({ files: [], listingsDigest: 'l', digest: 'd' }),
  openCatalogStore: (opts) => ({
    path: opts.path,
    publishSnapshot(header, rows) {
      const list = Array.from(rows);
      fs.writeFileSync(opts.path, JSON.stringify({ header, rows: list }));
      return 7;
    },
    close() {},
  }),
};
