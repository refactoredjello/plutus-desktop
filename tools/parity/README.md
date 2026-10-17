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

## Data

Fake demo data only (`api/tests/fixtures/simplefin_accounts.json`). Never point the harness at
a database or SQLite file holding real data: the report copies response bodies verbatim.
