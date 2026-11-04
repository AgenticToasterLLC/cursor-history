/**
 * worker_thread entry: builds one catalog snapshot. Receives an IndexerRequest via
 * workerData.request (or a first message) and posts IndexerResponse messages.
 */
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import type { IndexerRequest, IndexerResponse } from './contract.js';
import { buildCatalogSnapshot } from './builder.js';
import { importAbsolute, type CatalogDeps } from './deps.js';

interface WorkerInput {
  request?: IndexerRequest;
  /** Test hook: absolute path of a module exporting `catalogDeps` (Partial<CatalogDeps>). */
  testDepsModule?: string;
}

async function run(port: MessagePort, request: IndexerRequest, testDepsModule?: string) {
  const post = (m: IndexerResponse) => port.postMessage(m);
  let deps: Partial<CatalogDeps> | undefined;
  try {
    if (testDepsModule) {
      deps = (await importAbsolute(testDepsModule))['catalogDeps'] as Partial<CatalogDeps>;
    }
    const result = await buildCatalogSnapshot(request, {
      deps,
      onProgress: (phase) => post({ type: 'progress', jobId: request.jobId, phase }),
    });
    post(result);
  } catch {
    post({
      type: 'failed',
      jobId: request.jobId,
      code: 'WORKER_FAILED',
      message: 'Catalog build failed (WORKER_FAILED).',
    });
  }
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  const input = (workerData ?? {}) as WorkerInput;
  if (input.request) {
    void run(port, input.request, input.testDepsModule);
  } else {
    port.once('message', (m: IndexerRequest) => void run(port, m, input.testDepsModule));
  }
}
