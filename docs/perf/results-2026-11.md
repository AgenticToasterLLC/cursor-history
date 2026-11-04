# Measured results: performance, catalog and search work (2026-11-04)

## Environment

| Item | Value |
| --- | --- |
| Corpus | Read-only online-backup snapshot of a real Cursor install, page-identical to the source |
| Global `state.vscdb` | 7.26 GB, 424k `cursorDiskKV` rows (682 `composerData:`, 165k `bubbleId:`) |
| Workspaces | 106 |
| Sessions | 507 |
| Machine | i7-8650U, 17 GB RAM, NVMe SSD |
| Runtime | Windows 10, Node 24.22.2, SQLite 3.53 (both drivers) |

How the measurements were taken:

- MCP numbers come from driving the built `cursor-history-mcp` server over real stdio, as Claude Code does. The Store root was empty, the sidecar was throwaway and per-user directories were sandboxed.
- Reports are content-free.
- Timings are wall-clock on a laptop that was also running other work, so expect about ±20% noise.

## Spec section 9 acceptance table

| Scenario | Target | Measured | Status |
| --- | --- | --- | --- |
| MCP startup and tool discovery | < 2 s, no history scan at init | 220 ms, all 11 tools | Met |
| Warm `list`, first page (20) | p95 < 1 s | p50 24 ms, p95 29 ms (20 calls, catalog `ready`) | Met |
| Warm workspace-scoped `list` | p95 < 1 s | p50 24 ms, p95 30 ms | Met |
| Unknown or ambiguous workspace lookup | p95 < 1 s | unknown: p95 58 ms with suggestions; known-empty: 22 ms (`empty`) | Met |
| Warm full-text search, 10 results | p95 < 3 s | see below | Partly met |
| Direct UUID `show` | p95 < 3 s, ordinary sessions | p50 2.55 s, p95 2.61 s (bounded output) | Met |
| Cold first `list` response | < 2 s to an honest response | 2.8 s, but complete (direct read) while the catalog builds | Not met (0.8 s over); never claims false completeness |
| Background index construction | completes without blocking MCP calls | catalog: 2.8 s; with search index: about 95–120 s | Met (runs in a worker thread) |
| Repeated unchanged query | no global source re-enumeration | 20 warm lists served from the sidecar after a stat-only fingerprint | Met |
| Claude Code compatibility | all tools discoverable and callable | no root `oneOf`/`anyOf`/`allOf`/`not`; `tools/list` contract test | Met (confirm with a live Claude Code session) |
| Large history retrieval | no silent truncation or false completeness | show, search and export disclose truncation, continuation and coverage; stale catalogs say `complete: false` | Met |
| Write safety (read and index never write sources) | sources unchanged | DB and `-wal` byte- and mtime-identical after a two-server soak (see note) | Met |

### Search detail

Warm, indexed, `limit` 10. Each cell is a p50; "exh" means the `recent` result was exhaustive.

| Query | Matching sessions | `relevance` (complete ranking) | `recent` (newest first, stops early) |
| --- | --- | --- | --- |
| `ECONNRESET` | 5 | 2.7 s | 2.8 s (exh) |
| `useEffect` | 6 | 4.0 s | 4.0 s (exh) |
| `TypeError` | 48 | 9.1 s | 5.9 s |
| `migration` | 185 | 25.8 s | 4.1 s |
| `function` | 402 | 28.6 s | 3.0 s |

For comparison, the 0.19 direct scan took 30–83 s per query and failed outright on this history when any session had divergent replicas.

Two costs remain:

1. A fixed floor of about 2.7 s per verified search: the core listing that hydration depends on.
2. The cost of hydrating the candidate sessions that are actually verified.

Removing the floor by seeding the read context from the snapshot was evaluated and rejected. Hydration depends on private replica bindings that only a full listing creates, so seeding could select a different replica than the direct path would.

### Version-to-version

| Scenario | 0.18.0 | 0.19.0 | Now |
| --- | --- | --- | --- |
| Scoped `list -n 5` (known-empty workspace) | 1,181 s | ~2 s | 0.7 s cold / 24 ms warm |
| Unscoped `list -n 5` | timed out at 25 min | 9.3 s | 2.8 s cold / 24 ms warm |
| `show` by UUID | n/a | 9.5 s | 2.6 s |

## Notes and caveats

- **`-shm` files:** a two-server soak (63 interleaved list, search, show, status and refresh calls during catalog and index builds) had 0 errors. Afterwards every database and `-wal` file was byte- and mtime-identical. Only SQLite `-shm` files changed. `-shm` is the WAL shared-memory index, which any reader of a WAL database updates, including Cursor itself. It contains no data, and avoiding it would need `immutable=1`, which is unsafe while Cursor may be writing.
- **Queueing under load:** SQLite reads are synchronous. Within one MCP server process, a call can wait behind another call's direct scan. In the soak, `status` peaked at 53 s while a cold search scanned. This only matters before the catalog and index are warm.
- **Sizes:** the sidecar is about 2 MB with summaries only, and about 430 MB with the search index. The search index is opt-in, and deleting the sidecar file removes all of it.
- **Freshness:** the catalog is invalidated wholesale on any fingerprinted source change. On Windows, an in-place same-size SQLite update changes mtime, and a 2 s settle window guards against same-tick rewrites. While Cursor is actively writing, results are reported `stale` until a rebuild completes.
