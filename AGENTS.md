# AGENTS.md

Context for AI coding agents working on Plutus. Humans start with README.md.

**Keep this file current.** When a change makes anything here wrong or adds something an agent must know (a command, a convention, an ownership rule, a hard-won gotcha), update this file in the same change. Keep edits minimal: change or add the one line that matters, don't restate what the code or docs already say, and delete lines that stop being true.

## What Plutus is

A single-user, self-hosted personal finance app. SimpleFIN pulls bank data; an LLM categorizes it from scrubbed merchant names only; the app shows spending, recurring charges, projections, goals, and what changed this month. Runs locally with Docker Compose; the same images are meant for a single remote host later.

Principles, in priority order:

1. Simple UI and simple implementations are always preferred.
2. Don't reinvent the wheel. Use established libraries, taxonomies, and processes.
3. A clean interface is paramount.

## Setup

```bash
cp .env.example .env    # then set SECRET_KEY; LLM_PROVIDER=fake is fine for development
make up                 # Postgres, migrations, API on :8000, web on :5173
make demo-data          # optional fake data; make demo-clear removes it
cd api && uv sync && cd .. && npm ci   # host tooling: Python, then every npm workspace from the root lockfile
make check              # lint, types, and tests for api/, web/, and server/
```

Never use real credentials or real bank data in code, tests, mocks, or commits. Fixtures in `api/tests/fixtures` are fake.

## Commands

| Command | Use |
|---|---|
| `make check` | Everything CI runs. Must pass before a change is done. |
| `make openapi` | After any change to `server/src/schemas` or routes: regenerates `web/src/api/openapi.json` from the TypeScript server, then `schema.d.ts`. A test fails if they're stale. `server/test/contract.test.ts` also checks the spec against FastAPI's, frozen in `server/test/fixtures/fastapi-openapi.json`. |
| `make parity-self` / `make parity` | Parity harness (`tools/parity`): Python against itself (must be zero differences), then Python against the TypeScript server on demo data; writes `tools/parity/report.md`. Needs the compose Postgres; not part of `make check`. |
| `make import-check` | Postgres export (`python -m app.export_json`) to SQLite import (`server/scripts/import-json.ts`) on demo data in a throwaway `plutus_export` database; counts, secrets, runtime config, and the monthly report must match. See docs/MIGRATING_DATA.md. |
| `npm run demo -- load` / `-- clear` (in `server/`) | Fake demo data in the TypeScript server's database through the real sync pipeline (same 295 transactions as `make demo-data`). |
| `make revision m="..."` | New Alembic migration (autogenerate), then review it. |
| `make help` | The rest. |

## Layout

- `api/app/models` SQLAlchemy tables; `schemas` Pydantic request/response models; `routers` thin HTTP layer; `services` business logic; `providers` SimpleFIN and LLM adapters.
- `api/app/services/aggregates.py` is the single definition of income, expenses, transfers, money movement, essentiality buckets, and "usual" (recent active months). Build every report on it; never re-derive these rules.
- `server/` is the TypeScript port (Hono, Drizzle, better-sqlite3), laid out per docs/DESKTOP_PLAN.md 4.3. `server/test/setup.ts` gives each test its own in-memory SQLite via `makeDb()`.
- `server/src/services/config.ts` is the runtime config: knobs live in `app_settings`, seeded once from env; read them with `runtimeConfig()`/`llmSettings()`, never `process.env`.
- `desktop/` is the Electron shell: it runs `plutus-server/dist` in-process (build server first), testable parts in `desktop/src/lib/`. `npm run smoke` in desktop/ opens the real window on a throwaway data dir and checks the SPA reaches `/api/health` through the cookie guard; `smoke:dist` does the same for the packaged app.
- `tools/parity/` compares the Python and TypeScript apps endpoint by endpoint (`make parity`).
- `web/src/api` is generated; never edit it. `src/pages` one file per route; `src/features/<area>` components and queries; `src/mocks` MSW handlers for tests.
- `docs/` requirements (with a decisions log and known limitations), architecture, plans, and PRDs.

## Conventions

- Backend: sync SQLAlchemy and endpoints; `Annotated` dependencies; routers call one service function; services never import FastAPI; money is `Decimal` (JSON string); timestamps UTC. "Today" comes from `services/schedule.today()` so tests can patch it.
- Request money fields use `MoneyInput` (number or decimal string, parsed to cents, as Pydantic accepted); responses use `Money` (two-decimal string).
- Contract first: change schemas, run `make openapi`, then build frontend against the generated types and MSW mocks.
- Frontend: TanStack Query for server state, shadcn/ui components (base-nova, on Base UI), Recharts. Use the generated client in `src/api/client.ts`; never hand-write fetch calls.
- Migrations are reviewed by hand. Never edit an applied migration.
- Commits end with a `Co-Authored-By` line for the model that wrote them.

## Privacy rules (enforced by tests)

- Only `services/scrub.py` (merchant keys) and `services/suggestions.py` (category aggregates) may build LLM input. Never send balances, account names, raw descriptions, notes, or names.
- Rules may match raw descriptions (`contains`) because rules never leave the machine.
- New features must not call an LLM unless the requirements say so; add a test that proves it.

## Testing

- Backend tests run against real Postgres (database `plutus_test`), each test rolled back. Parallel work in separate git worktrees should use its own database via `TEST_DATABASE_URL=postgresql+psycopg://plutus:plutus@localhost:5432/<name>`.
- Don't run an unmerged branch's migrations against the shared dev database `plutus`; main's migration step would then fail on an unknown revision. Use a copy.
- Frontend tests use Vitest, Testing Library, and MSW via `renderAt(path)` in `src/test/render.tsx`.

## Gotchas that cost time

- FastAPI 0.14x wraps included routers: `app.routes` has no `APIRoute`s. Walk `app.main.ROUTERS` instead.
- SimpleFIN: request at most 45 days per call (the live bridge warns above that) and at most 24 requests a day; runs record `requests` and the guard sums them.
- Two checkouts (or a worktree) share the compose project `plutus`, but `docker compose up db` from a second path recreates the shared db container (the init.sql bind mount differs). `make test-api` skips it when :5432 answers; don't run it by hand.
- `make up` can't build the web image in this repo (web has no lockfile of its own since the root workspace); run the Docker app from `~/dev/Plutus`.
- Docker Compose expands `$` in `.env`: quote values containing `$` (the argon2 hash) in single quotes.
- Bank merchant names vary (e.g. `SEAMLESS` vs `SEAMLSS`); prefer prefix or contains rules, and check variants in the data before writing one.
- Detection needs three occurrences; yearly charges must be marked recurring by hand (`POST /api/recurring`).
- Agent file writes can turn `\uXXXX` escapes in source into literal characters (a literal U+2028 broke a regex class). Keep sources ASCII: `LC_ALL=C grep -nP '[^\x00-\x7F]' <file>` finds strays.
- Python `re` is Unicode-aware where JS `RegExp` is not (`\b`, `\d`, `\s`, `.`); `services/scrub.ts` shows the rewrites.
- In zsh, unquoted variables don't word-split; loop over query results with Python or `${=var}`.

## Multi-agent work

An orchestrator session owns schemas, migrations, `app/main.py`, and merges; subagents implement briefs in their own worktree and branch, touching only files they own. Role definitions live in `.claude/agents/`. See `docs/AGENT_PLAN.md`.

Suspected Python bugs found during the port go in `docs/PORT_BUG_BACKLOG.md`; port them as they are and never fix one without the owner's go-ahead.

The desktop port (TypeScript server plus Electron, SQLite instead of Postgres) is planned in `docs/DESKTOP_PLAN.md`. While it runs, Python code under `api/` is frozen except the two changes that plan names, and new server work goes in `server/`.
