// Child-process driver for crash / two-process catalog tests.
// argv[2] = JSON {config, delayMs, mode, depsModule}. IPC protocol:
//   child -> parent {type:'ready'}; parent -> child {type:'go'};
//   child -> parent {type:'started', result};
//   mode 'kill': SIGKILL self shortly after the build started (worker is mid-build);
//   mode 'wait': wait for the build, then {type:'done', response}.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const { config, delayMs, mode, depsModule } = JSON.parse(process.argv[2]);
process.env.CH_E2E_BUILD_DELAY_MS = String(delayMs ?? 0);
const dist = (p) => pathToFileURL(join(process.cwd(), 'dist', p)).href;
const read = await import(dist('core/catalog/read.js'));
const refresh = await import(dist('core/catalog/refresh.js'));
const { getCatalogDeps } = await import(dist('core/catalog/catalog-deps.js'));

const deps = await getCatalogDeps();
const scope = read.resolveCatalogScope(config, deps);
process.send({ type: 'ready' });
await new Promise((resolve) => process.on('message', (m) => m?.type === 'go' && resolve()));

const result = refresh.requestCatalogRefresh(
  { scopeKey: scope.scopeKey, readConfig: scope.readConfig, storePath: scope.storePath },
  { testDepsModule: depsModule, force: true }
);
process.send({ type: 'started', result });
if (mode === 'kill') {
  await new Promise((r) => setTimeout(r, 1200));
  process.kill(process.pid, 'SIGKILL');
}
const response = await refresh.waitForCatalogBuild(scope.digest, 60_000);
process.send({ type: 'done', response: response ? response.type : null }, () => process.exit(0));
