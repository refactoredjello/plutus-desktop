# AGENTS.md

Context for AI coding agents working on Plutus. Humans start with README.md.

**Keep this file current.** When a change makes anything here wrong or adds something an agent must know (a command, a convention, an ownership rule, a hard-won gotcha), update this file in the same change. Keep edits minimal: change or add the one line that matters, don't restate what the code or docs already say, and delete lines that stop being true.

## What Plutus is

A single-user personal finance app. SimpleFIN pulls bank data; an LLM categorizes it from scrubbed merchant names only; the app shows spending, recurring charges, projections, goals, and what changed this month. It is an Electron desktop app over one SQLite file; the same TypeScript server also runs headless.

Principles, in priority order:

1. Simple UI and simple implementations are always preferred.
2. Don't reinvent the wheel. Use established libraries, taxonomies, and processes.
3. A clean interface is paramount.

## Setup

```bash
npm ci                  # every workspace (web, server, desktop) from the root lockfile; Node 24+
make check              # lint, types, and tests for web/, server/, and desktop/
```

Never use real credentials or real bank data in code, tests, mocks, or commits. Fixtures in `server/test/fixtures` are fake.

## Commands

| Command | Use |
|---|---|
| `make check` | Everything CI runs (`npm run check` at the root). Must pass before a change is done. |
| `make openapi` | After any change to `server/src/schemas` or routes: regenerates `web/src/api/openapi.json` from the server, then `schema.d.ts`. A test fails if they're stale. |
| `make dev` / `make smoke` / `make dist` | The desktop app from source / its smoke check on a throwaway data dir / a macOS package in `desktop/release/` (ad hoc signed without a certificate; `desktop/README.md` has signing). |
| `make dev-server` | Headless server from source on :8000 with reload, serving `web/dist`. |
| `npm run demo -- load` / `-- clear` (in `server/`) | Fake demo data (295 transactions) through the real sync pipeline into `PLUTUS_DB_PATH` or `PLUTUS_DATA_DIR/plutus.sqlite`; `make demo-data` / `make demo-clear` do the same. |
| `make help` | The rest. |

## Layout

- `server/` is the backend (Hono, Zod, Drizzle, better-sqlite3): `src/routes` thin HTTP layer, `src/schemas` Zod request/response schemas (the OpenAPI source), `src/services` business logic, `src/providers` SimpleFIN and LLM adapters, `src/db` schema and migrations. `docs/ARCHITECTURE.md` has the full layout.
- `server/src/services/aggregates.ts` is the single definition of income, expenses, transfers, money movement, essentiality buckets, and "usual" (recent active months). Build every report on it; never re-derive these rules.
- `server/src/services/config.ts` is the runtime config: knobs live in `app_settings`, seeded once from env; read them with `runtimeConfig()`/`llmSettings()`, never `process.env`.
- `desktop/` is the Electron shell: it runs `plutus-server/dist` in-process (build server first), testable parts in `desktop/src/lib/`. `npm run smoke` in desktop/ opens the real window on a throwaway data dir and checks the SPA reaches `/api/health` through the cookie guard; `smoke:dist` does the same for the packaged app.
- `web/src/api` is generated; never edit it. `src/pages` one file per route; `src/features/<area>` components and queries; `src/mocks` MSW handlers for tests.
- `npm run dev` in `web/` proxies `/api` to `127.0.0.1:8000`, where `npm run dev` in `server/` listens (override with `VITE_API_PROXY`); `npm run dev:mock` needs no server.
- `docs/` requirements (with a decisions log and known limitations), architecture, plans, and PRDs.

## Working on the desktop app

- Most features touch only `server/` and `web/`: build and check them as a web app (server tests, MSW frontend tests, `npm run dev` in `server/` opened in a browser). Use the real window only for shell work or a final check.
- Dev runs (`npm run dev` in `desktop/`, or `npx electron .` after a build) keep data in `~/Library/Application Support/Plutus Dev/plutus.sqlite`, separate from the installed app's (`.../Plutus`). Prefer `--data-dir <tmp>` (its own database, `logs/plutus.log`, and single-instance lock) and never open the installed app's folder. Load demo data with the app closed: `PLUTUS_DB_PATH=<data dir>/plutus.sqlite npm run demo -- load` in `server/`.
- The smoke check runs in CI on every push (`smoke:dist` on the packaged app, macOS job); agents don't run them locally, since each run opens a window on the owner's screen.
- Any script that launches Electron needs a hard timeout and must kill the process group: wrap it in `node scripts/with-timeout.mjs <seconds> ...` as `smoke` and `smoke:dist` do.
- Releases: `npm run version:bump -- patch|minor|major` in `desktop/` (commits the version), then tag `v<version>` on main and push the tag; `.github/workflows/release.yml` builds, verifies, and publishes the GitHub Release. The owner installs with `make update` (quits Plutus, runs `npm run update:app` = `desktop/scripts/update.sh`: data copy, rollback zip, verified swap; reopens it) or `make rollback`.
- Debug the real window with `npx electron . --remote-debugging-port=9222` in `desktop/`. A human attaches Chrome DevTools from `chrome://inspect`; an agent reads `http://127.0.0.1:9222/json/list`, opens the page's `webSocketDebuggerUrl` with Node's built-in `WebSocket`, and sends DevTools Protocol commands (`Runtime.evaluate`, `Page.captureScreenshot`, `Network.enable`). Code run in the page passes the cookie guard, so `fetch('/api/...')` works there; the same origin opened in another browser answers 401. Dev builds and demo data only, since any local program can drive an open port; quit the app when done.
- `PLUTUS_DEVTOOLS=1 npx electron .` opens the DevTools panel with the window, for a human at the screen. Dev builds only: the packaged app ignores it (`src/lib/devtools.ts`).

## Conventions

- Server: routes parse, call one service function, and return a schema; services never import Hono. Money is integer cents through `lib/money.ts` (division rounds half to even), never a float; dates are `PlainDate` strings through `lib/dates.ts`; timestamps UTC ISO strings. "Today" comes from `lib/dates.today()` (`PLUTUS_TODAY` pins it in tests).
- Request money fields use `MoneyInput` (number or decimal string, parsed to cents); responses use `Money` (two-decimal string).
- Contract first: change schemas, run `make openapi`, then build frontend against the generated types and MSW mocks.
- Frontend: TanStack Query for server state, shadcn/ui components (base-nova, on Base UI), Recharts. Use the generated client in `src/api/client.ts`; never hand-write fetch calls.
- A mutation that changes categorizations, rules, or recurring charges calls `invalidateDerived` (`web/src/app/invalidate.ts`) so reports, projection, and goals refetch too.
- Migrations are drizzle-kit SQL in `server/src/db/migrations`, reviewed by hand. Never edit an applied migration. Table rebuilds (drizzle-kit's `__new_<table>` copy, drop, rename) are safe: `openDb` migrates with foreign keys off, then runs `foreign_key_check` and `integrity_check` and restores the backup on a failure. Before migrating a database with data it writes a verified copy to `<data dir>/backups/` and keeps the newest 5; a database migrated by a newer app refuses to open (docs/ARCHITECTURE.md, "Migrations and backups").
- Tests first: a failing-test commit, then the implementation commit.
- Commits end with a `Co-Authored-By` line for the model that wrote them.
- Every change goes on a new branch cut from `origin/main` and reaches `main` only through a pull request; never commit on `main`. The owner merges: agents never merge into `main` or enable auto-merge. An agent that opens a PR reports its URL and check status.

## Privacy rules (enforced by tests)

- Only `services/scrub.ts` (merchant keys) and `services/suggestions.ts` (category aggregates) may build LLM input. Never send balances, account names, raw descriptions, notes, or names.
- Rules may match raw descriptions (`contains`) because rules never leave the machine.
- New features must not call an LLM unless the requirements say so; add a test that proves it.

## Testing

- Server tests use Vitest; `server/test/setup.ts` gives each test its own migrated, seeded in-memory SQLite via `makeDb()`, and `makeApp()` an app over it for `app.request('/api/...')`. Fake SimpleFIN and LLM providers only.
- Frontend tests use Vitest, Testing Library, and MSW via `renderAt(path)` in `src/test/render.tsx`.
- Desktop: unit tests for `desktop/src/lib`; window code is checked by the smoke checks in CI.

## Gotchas that cost time

- SimpleFIN: request at most 45 days per call (the live bridge warns above that) and at most 24 requests a day; runs record `requests` and the guard sums them.
- Bank merchant names vary (e.g. `SEAMLESS` vs `SEAMLSS`); prefer prefix or contains rules, and check variants in the data before writing one.
- Detection needs three occurrences; yearly charges must be marked recurring by hand (`POST /api/recurring`).
- Agent file writes can turn `\uXXXX` escapes in source into literal characters (a literal U+2028 broke a regex class). Keep sources ASCII: `LC_ALL=C grep -nP '[^\x00-\x7F]' <file>` finds strays.
- JS `RegExp` word boundaries and classes (`\b`, `\d`, `\w`) are ASCII-only; `services/scrub.ts` spells out the Unicode-aware patterns bank text needs, and the scrub golden test catches a regression.
- The server sets a strict Content-Security-Policy on the SPA's HTML (`server/src/app.ts`): no outside scripts, styles, fonts, or connections, in the window or headless.
- In zsh, unquoted variables don't word-split; loop over query results with a script or `${=var}`.

## Multi-agent work

An orchestrator session owns `server/src/db/schema.ts`, migrations, Zod schemas, `server/src/app.ts`, root config, and merging subagent branches into its own branch for the PR; subagents implement briefs in their own worktree and branch, touching only files they own. Role definitions live in `.claude/agents/`. See `docs/AGENT_PLAN.md`.

Open bugs and wanted changes are listed in `docs/BACKLOG.md`; never fix one without the owner's go-ahead.
