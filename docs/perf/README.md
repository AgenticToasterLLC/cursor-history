# Performance harness

Scripts live in `scripts/perf/`. All large artifacts go to `%LOCALAPPDATA%/cursor-history-perf/`
(override with `CURSOR_HISTORY_PERF_DIR`) and are never committed. Reports contain counts, sizes,
timings and query plans only - no message text, titles, paths or ids.

Build first: `npm run build` (the bench runs against `dist/lib/index.js`).

## Synthetic corpus

```sh
npm run perf:corpus -- small  --force   # CI smoke, seconds
npm run perf:corpus -- medium --force   # ~20 workspaces, 5k composers, 150k bubbles (~730 MB, ~70 s)
npm run perf:corpus -- large  --force   # 150 workspaces, 50k composers, 1.2M bubbles (several GB)
```

Options: `--seed N` (default 1, output is deterministic), `--out DIR`, `--schema real|fixture`,
and `--workspaces/--composers/--bubbles` overrides. The corpus has 1-4 KB bubbles with ~1% over 64 KB
(overflow chains), case-collision UUID pairs, composers without `createdAt`/`lastUpdatedAt`, composers
with no workspace, and unrelated keys. `tests/perf/corpus-smoke.test.ts` generates `small` into
`os.tmpdir()` and checks `listSessionSummaries` returns every composer.

## Real-data snapshot (read-only)

```sh
npm run perf:snapshot
```

Opens the real `%APPDATA%/Cursor/User/**/state.vscdb` files `readonly` and copies them with SQLite's
online backup API (single step, so one consistent read snapshot and original page layout). If the
backup keeps restarting it falls back to `VACUUM INTO` and records that in the manifest. Requires
free space of at least 2.5x the source size. Output: `<perf>/snapshot/User/...` plus
`snapshot-manifest.json`. Nothing under `%APPDATA%/Cursor` or `~/.cursor` is ever written.
The source sha256 is provenance only (the source is live and its WAL is not in the main file).

## Benchmark

```sh
npm run bench -- --corpus medium --iterations 5
npm run bench -- --root "%LOCALAPPDATA%/cursor-history-perf/snapshot" --scenarios list-global --iterations 1 --timeout-min 30
```

Scenarios: `list-global` (limit 20), `list-workspace`, `list-unknown-workspace`, `get-session`,
`search`. Each scenario runs in a fresh child process with `CURSOR_STORE_ROOT` pointed at an empty
temp dir (so the real `~/.cursor` is never read); iteration 1 is cold, the rest warm. Reports
p50/p95/max, peak RSS and (if `config.diagnostics` exists in the built types) accepts
`--diagnostics-config '<json>'`. JSON results go to `<perf>/results/`.

## Query-plan profiling

```sh
npm run perf:explain -- --corpus medium --cap-sec 120
npm run perf:explain -- --cap-sec 300                       # snapshot (default target)
npm run perf:explain -- --driver node:sqlite --only plans,prefix,points,workspaces
```

Sections (`--only`): `schema`, `scans`, `plans`, `prefix`, `points`, `workspaces`. Each full-key-space
iteration uses pages of 256 and stops at `--cap-sec` (recorded as `capped`).

Gotcha when writing probes: an unqualified `ORDER BY rowid` next to `CAST(rowid AS TEXT) AS rowId`
resolves to the alias and sorts rows as text. The library qualifies it (`cursorDiskKV.rowid`).

The measured results are in `baseline-0.19.0.md`.
