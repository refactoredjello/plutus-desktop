# Parity harness

Compares the Python API (the oracle) with the TypeScript server on the same fake demo data.
Brief 1G in `docs/DESKTOP_PLAN.md`.

```bash
cd api && uv sync && cd ..   # the harness runs api/.venv/bin/python
npm ci
make parity-self             # Python vs Python: validates normalization, must report zero differences
make parity                  # Python vs TypeScript; writes tools/parity/report.md, exits 1 on any difference
make check-parity            # lint, typecheck, unit tests; starts no app (part of make check)
```

Options: `node_modules/.bin/tsx tools/parity/run.ts [--self-check] [--today=YYYY-MM-DD]`.
`PARITY_TODAY` sets the default date (2026-09-30, the end of the fixture);
`PARITY_PG_ADMIN_URL` the Postgres maintenance URL (default
`postgresql://plutus:plutus@localhost:5432/postgres`).

## What a run does

1. Drops and recreates the Postgres database `plutus_parity` (and `plutus_parity_self` for the
   self-check, dropped again at the end), migrates it, and runs `python -m app.demo load`. It
   refuses to touch any database whose name does not start with `plutus_parity`.
2. Runs `npm run demo -- load` in `server/` against a temp SQLite file, then starts the server
   with `node --import tsx server/src/main.ts`. A failing load or start is a reported
   difference, and the run carries on.
3. Both apps get `LLM_PROVIDER=fake`, `OWNER_NAME_TOKENS=["ALEX","SAMPLE"]`, the fixed
   `PLUTUS_TODAY`, the scheduler off, and a throwaway secret key, on free loopback ports.
4. Compares every GET in `endpoints.ts` (each GET in the contract or a documented skip), then
   runs the write steps in `writes.ts`, re-reading the affected GETs after each one. Each step
   picks its target from the app's own responses; different picks are a reported difference.
5. Compares the Python prompts (`dump_prompts.py`) with
   `server/src/providers/llm/prompts.ts`, byte for byte.
6. Writes `report.md` (gitignored): a summary per endpoint, setup and prompt checks, the
   status codes of every write step, the differences grouped by endpoint, what was not
   compared, and the normalization rules. The work directory with app logs is in the setup
   table.

## Normalization

Listed in every report (`ruleNotes()` in `endpoints.ts`); the code is `normalize.ts`. Anything
not covered here is a finding: classify it as a port bug, a Python bug, or an accepted
difference, and give it to the owning brief.

The summary lists the statuses Python answered per endpoint (which success and error paths
ran). `GET /api/settings/config` has no Python counterpart, so instead of a diff a setup check
compares the TypeScript answer with the env both apps got and Python's own
`/api/settings/llm` and `/api/sync/schedule` (`config_check.ts`).

## Electron request audit

```bash
npm run build:all --prefix desktop                    # web, server, desktop
node_modules/.bin/tsx tools/parity/visual/audit.ts    # or add --build; at most ~3 minutes
```

Opens the real desktop app (desktop/dist/main.js, unchanged: cookie guard, in-process server,
window) on fake demo data in a fresh temp data dir, visits every route in `web/src/app/router.tsx`
(by clicking its link where the page has one) plus one deep link loaded directly, and records
every request with its status and content type, console errors and warnings, failed or blocked
requests, and uncaught page errors. After the first page it seeds a goal, a planned item, and a
confirmed recurrence through the page's own fetch, and at the end checks that `/api/health`
from outside the page answers 401. Then every distinct `/api/` request (method, path template,
query keys) is matched against the harness cases; a request no case compares is a coverage gap.

`electron_main.mjs` is the Electron entry: it sets the app path and `appData` synchronously
before importing main.js, so userData is `<temp>/Plutus Dev` and never the developer's own data
dir, and it refuses to continue otherwise. Electron runs in its own process group, killed after
`AUDIT_TIMEOUT_MS` (default 180 s) or when the script exits. The browser clock and the server's
"today" are both the real date (no `PLUTUS_TODAY`).

Output in `tools/parity/visual/out/` (gitignored): `audit.md`, `audit.json`, `events.ndjson`,
`electron.log`, one PNG per route. Exit 1 on any problem or gap, 2 when Electron failed or timed
out. Accepted class: Chromium's cache-only probe for a web font (`net::ERR_CACHE_MISS`, then
the same font loads) is listed but not counted.

## Import check

`make import-check` (not part of `make check`) tests the Postgres export and SQLite import of
brief 2D end to end: it recreates `plutus_export`, loads the demo data, stores a fake
encrypted SimpleFIN URL, runs the write steps that fill the tables the demo leaves empty,
exports with `python -m app.export_json`, imports with `server/scripts/import-json.ts`, and
compares per-table row counts (Postgres, file, SQLite) and `GET /api/reports/monthly` between
the Python API and the TypeScript server on the imported file. `--all-gets` (run
`node_modules/.bin/tsx tools/parity/import_check.ts --all-gets`) also prints every parity GET
for information. The importer's unit tests are `import.test.ts`. An export file holds the
SimpleFIN access URL and the Anthropic API key in clear text (docs/MIGRATING_DATA.md); the
check only ever stores fake ones.

## Data

Fake demo data only (`api/tests/fixtures/simplefin_accounts.json`). Never point the harness at
a database or SQLite file holding real data: the report copies response bodies verbatim.
