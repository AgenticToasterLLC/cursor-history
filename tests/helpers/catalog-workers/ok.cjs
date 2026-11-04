const { parentPort, workerData } = require('node:worker_threads');
parentPort.postMessage({ type: 'done', jobId: workerData.request.jobId, snapshotId: 1, rowCount: 0, buildMs: 1 });
