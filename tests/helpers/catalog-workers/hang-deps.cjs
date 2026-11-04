// Like deps.cjs, but the direct read never completes (simulates a long synchronous build).
const base = require('./deps.cjs').catalogDeps;
exports.catalogDeps = { ...base, listSessionSummaries: () => new Promise(() => {}) };
setInterval(() => {}, 1000); // keep the worker alive while the read hangs
