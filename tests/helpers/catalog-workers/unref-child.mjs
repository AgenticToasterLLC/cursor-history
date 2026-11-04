// Requests a refresh with a never-ending worker; the process must still exit promptly.
import { pathToFileURL } from 'node:url';
const [refreshPath, workerPath] = process.argv.slice(2);
const { requestCatalogRefresh } = await import(pathToFileURL(refreshPath).href);
const r = requestCatalogRefresh(
  { scopeKey: { k: 1 }, readConfig: {}, storePath: 'fake' },
  {
    deps: {
      createCatalogLock: () => ({ tryAcquire: () => ({ release() {} }) }),
      digestScopeKey: () => 'digest',
    },
    workerPath,
  }
);
console.log(JSON.stringify(r));
