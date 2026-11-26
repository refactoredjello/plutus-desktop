# Plutus — Architecture

Describes how Plutus is built. The principles in AGENTS.md apply: simplest thing that works, reuse established tools, clean interface.

## System overview

One process, one SQLite file. The desktop app and the headless server run the same server code:

```
┌───────────────────────────── desktop (Electron) or headless (node) ─┐
│  window / browser ──▶  server (Hono, in-process)  ──▶  SQLite file  │
│  React SPA             /api routes, scheduler          better-sqlite3│
└─────────────────────────────────┬────────────────────────────────────┘
                                  │ outbound HTTPS only
                        ┌─────────┴──────────┐
                        ▼                    ▼
                 SimpleFIN Bridge      LLM provider
                 (bank data)           (Claude API or local Ollama)
```

- **server** (`server/`): a Hono app built by `createApp({ db, secrets, config, ... })`. It serves `/api` and the built SPA from `web/dist` (unknown non-`/api` paths fall back to `index.html`, with a Content-Security-Policy on the HTML), and runs the periodic sync scheduler. Migrations run when the database is opened.
- **desktop** (`desktop/`): the Electron shell. It opens the database in the OS app data folder, starts the server in-process on `127.0.0.1` with a random port, and shows the SPA in a window. Secrets are encrypted with Electron `safeStorage` (the macOS Keychain). Each launch makes a random token that the first HTML response sets as an `HttpOnly`, `SameSite=Strict` cookie; every `/api` request must carry it, so other local processes can't use the API.
- **headless** (`server/src/main.ts`): the same server on a configurable host and port, configured from the environment, secrets encrypted with AES-256-GCM keyed by `PLUTUS_SECRET_KEY`. The cookie guard is available behind `PLUTUS_API_GUARD` and off by default.
- **web** (`web/`): the React SPA. Its API client uses `location.origin`, so it works unchanged in both.

No Redis, no broker, no separate worker. A manual sync answers 202 and runs in the background of the same process; the UI polls the sync-run row for status.

## Server

TypeScript on Node 24 (ESM, strict). Layout, one module per concern:

```
server/
  src/
    app.ts             createApp(): routes, error handler, SPA, cookie guard
    main.ts            headless entry: open the database, serve on HOST:PORT
    config.ts          environment: data dir, secret key, today override, runtime defaults
    secrets.ts         SecretStore interface, KeySecretStore (AES-256-GCM)
    scheduler.ts       periodic sync: setTimeout chain with jitter, follows config changes
    db/
      schema.ts        Drizzle tables, one file
      index.ts         openDb(path): pragmas, guarded migrations, category seed
      safety.ts        schema guard, pre-migration backup and restore, post-migration checks
      migrations/      drizzle-kit SQL migrations; seed/categories.json (Plaid PFC v2)
    lib/
      money.ts         integer cents: parse, format, half-even division, median
      dates.ts         PlainDate helpers, today()
      errors.ts        DomainError family, problem+json
      log.ts           pino
    schemas/           Zod schemas, one file per domain; the OpenAPI source
    routes/            one file per router: parse, call one service, return the schema
    services/          business logic: sync, categorize, scrub, transfers, recurring,
                       schedule, aggregates, reports, changes, projection, goals,
                       suggestions, config, app_settings, ...
    providers/
      bank/            types.ts (BankProvider), simplefin.ts
      llm/             types.ts (LLMProvider), prompts.ts, claude.ts, ollama.ts, fake.ts
  scripts/
    export-openapi.ts  writes web/src/api/openapi.json
    demo.ts            load | clear fake demo data through the real sync pipeline
  test/                Vitest; setup.ts gives each test its own in-memory SQLite
```

Key libraries: Hono with `@hono/node-server` and `@hono/zod-openapi`, Zod 4, Drizzle ORM with better-sqlite3, pino, `@anthropic-ai/sdk`. Ollama is called with `fetch`.

### Server conventions

These apply to all server code. Agents follow them without asking.

| Area | Convention |
|---|---|
| Tooling | npm workspaces from the root lockfile. oxlint, `tsc` strict, Vitest. `npm run check` in a package runs all three. |
| Sync vs async | better-sqlite3 is synchronous, and so are services that only touch the database. Services that call a provider are `async`. Never `await` inside an open transaction. |
| Schemas | Zod schemas in `src/schemas` are both validator and OpenAPI source. Component names: `XCreate`, `XUpdate` (all optional, for PATCH), `XRead`. Request bodies forbid unknown keys. |
| Money | `INTEGER` cents in the database, a branded `Cents` type in code, a two-decimal string on the wire (`Money`); requests take `MoneyInput` (a number or a decimal string). Arithmetic on integers; division rounds half to even (`lib/money.ts`). Never a float for money. |
| Dates and time | Transaction and planning dates are `PlainDate` strings `YYYY-MM-DD`, compared as strings. Timestamps are UTC ISO 8601. "Today" comes from `lib/dates.today()`, which honours `PLUTUS_TODAY` so tests can pin it. |
| Layers | Routes handle HTTP only: parse, call one service function, return the schema. Business logic lives in `services/`. Services never import Hono. `services/aggregates.ts` is the single definition of income, expenses, transfers, money movement, essentiality buckets, and recent active months. Only posted transactions count: pending rows are in no total, list, or count until a sync posts them; the Transactions list still shows them. |
| Config | Runtime knobs (LLM provider, model, API key, Ollama URL, owner name tokens, sync interval, first-sync history, scheduler) live in `app_settings`, seeded once from the environment; read them with `runtimeConfig()` / `llmSettings()` in `services/config.ts`, never `process.env`. The headless server applies set environment variables over them at every start; the desktop reads only the table. |
| Secrets | Through a `SecretStore`: `KeySecretStore` headless and in tests, `SafeStorageSecretStore` in the desktop. Encrypted settings keep `is_encrypted`. |
| Errors | Domain errors are classes in `lib/errors.ts`, rendered by one handler as RFC 9457 problem details. Validation failures are 422 problem+json with a `detail` naming the failing fields. |
| OpenAPI | Every route has a response schema (or is 204), a tag, and a stable operation ID. `make openapi` writes the spec and regenerates the TypeScript client (openapi-typescript, called through openapi-fetch); a test fails if either is stale. |
| Database | Foreign keys on, WAL. Migrations generated by drizzle-kit and reviewed by hand; never edit an applied migration. See "Migrations and backups". |
| Logging | pino, JSON lines on stdout; the desktop also appends them to `<data dir>/logs/plutus.log`. |
| Testing | Vitest. `makeDb()` returns a fresh migrated and seeded in-memory database per test; `makeApp()` builds the app over it, and route tests call `app.request('/api/...')`. Fake providers for SimpleFIN and the LLM; the fake LLM records every call so tests assert exactly what would have been sent. |
| Pagination | `limit` and `offset` query parameters. |

### Migrations and backups

`openDb` (`db/index.ts`, helpers in `db/safety.ts`) runs drizzle's migrator at every start, which applies all pending migrations in one transaction. Around it:

1. **Schema guard.** If the newest applied migration (`max(created_at)` in `__drizzle_migrations`) is newer than the newest one in the bundled `meta/_journal.json`, the app is older than its data: `openDb` throws `DatabaseOpenError('too_new')` and changes nothing.
2. **Backup.** Only for a database file that already has tables and has pending migrations: check free space (twice the database plus WAL, plus 16 MB), then `VACUUM INTO <backup dir>/plutus-<UTC timestamp>-before-<next migration tag>.sqlite` and verify the copy with `PRAGMA integrity_check`. The backup dir is an `openDb` option, defaulting to `backups/` beside the database. VACUUM INTO, not better-sqlite3's `backup()`: it is synchronous and copies a consistent snapshot through the open connection, including rows still in the `-wal` file (tested). If space is short or the copy fails or does not verify, it throws `'backup_failed'` and does not migrate. After a verified backup, only the newest 5 `plutus-*-before-*.sqlite` files are kept.
3. **Migrate with foreign keys off.** `PRAGMA foreign_keys = OFF` is set outside any transaction before `migrate()` (inside one SQLite ignores it), so drizzle-kit's table rebuild (`__new_x`, drop, rename) doesn't cascade into child tables. `PRAGMA legacy_alter_table = OFF` is set with it, so the rename rewrites references in other tables, views, and triggers instead of leaving them dangling. A migration that throws rolls back: `'migration_failed'`, data unchanged. A new database file (no tables before this open) that fails here or at step 4 is deleted with its `-wal`/`-shm` instead (`'migration_failed'`), so the next start retries.
4. **Checks.** After migrating, `integrity_check` and `foreign_key_check`. On a problem, the connection closes, the database and its `-wal`/`-shm` move to `<backup dir>/failed-<UTC timestamp>.sqlite*`, the backup is copied over the database, and it throws `'restored'` naming the backup.
5. Then `foreign_keys = ON`, the category seed, and (file databases only) `app_settings.last_app_version` = the `appVersion` option (default the server package version; the desktop passes `app.getVersion()`, so releases differ), which the guard's message names.

On shutdown, the desktop and the headless server close through `closeDb` (`db/index.ts`): `wal_checkpoint(TRUNCATE)` and `optimize`, then close, so after a normal quit `plutus.sqlite` holds everything and its `-wal` is empty or gone. It ignores a null or closed handle, and a pragma failure (read-only or in-memory) still closes.

Every `DatabaseOpenError` closes the connection first, so neither the headless server nor the desktop starts on data that failed these steps; the desktop shows a plain native dialog per case (`desktop/src/lib/startup.ts`) and quits.

### Provider interfaces

```ts
interface BankProvider {
  readonly name: string
  readonly requestsMade?: number   // for the daily request budget
  fetch(start: PlainDate, end: PlainDate): Promise<ProviderSnapshot>
}

interface LLMProvider {
  readonly name: string
  classifyMerchants(items: readonly MerchantInput[]): Promise<MerchantClassification[]>
  suggestSavings(context: SavingsContext): Promise<SavingsSuggestion[]>
}
```

Both return plain objects. Nothing provider-specific leaks past these boundaries. Adding Plaid later means one new file under `providers/bank/` plus a Link flow in the UI.

### SimpleFIN sync algorithm

1. Create a `sync_runs` row with status `running`.
2. Determine window: `start = last_successful_sync_start - 5 days` (or the first-sync history, default 180 days, on the first run), `end = now`. When a pending row is older than that start, the window starts at the oldest pending row instead, but never earlier than 44 days before today (`pendingReachStart` in `services/pending.ts`), so a bank that keeps a charge pending longer than the overlap is still checked again without costing a second request. Requests are chunked to 45 days: SimpleFIN documents 90, but the live bridge warns above 45 and may cap there.
3. `GET {access_url}/accounts?start-date=…&end-date=…` with Basic Auth from the access URL.
4. For each account: upsert by `(provider, external_id)`. Insert a `balance_snapshots` row.
5. For each transaction: upsert by `(account_id, external_id)`. If an existing row was `pending` and is now posted, update in place. Rows absent from a window they previously appeared in are left alone (SimpleFIN does not report removals), except stale pending rows: on a run without provider errors, a pending row in the window that the bank did not return is dropped. If exactly one row this run inserted is its posted twin (same account and amount, dated within 7 days, and no other pending row claims it), the pending row's manual categorization, note, and one-time flag move to the twin first, never over a manual value already there. A pending row older than the window is past the reach: it is dropped only for an unambiguous posted twin among all posted rows, otherwise it stays pending and joins the review queue ("Pending for over 44 days", `review_reason`), where the owner marks it posted (`POST /api/transactions/{id}/mark-posted`) or removes it (`DELETE /api/transactions/{id}`, pending rows only). A row marked posted stays posted unless the bank returns its external id as pending again; then the bank wins.
6. Run transfer matching on new rows, then categorization on uncategorized rows.
7. Mark the run `success` or `error` with counts and provider `errlist` messages. Never retry within the same run.

Request budget: one request per 45-day chunk per sync, at most 24 in a rolling day. A default first sync is 4 requests. Steady state is 1 request per sync, 4 scheduled syncs per day; reaching back for an old pending row keeps it at 1.

### Categorization pipeline

```
raw description
  → normalize   (uppercase, collapse whitespace, strip store numbers, strip "SQ *", "TST*", "PP*", etc.)
  → scrub       (remove digit runs ≥4, dates, phone numbers, "CHK #", "REF", names after "ZELLE TO/FROM", "VENMO")
  → key = normalized merchant string
  → rules       owner-defined, exact, prefix, or contains match → category + essentiality
  → cache       merchant_classifications table keyed by `key`
  → LLM         batch of unseen keys (up to ~50 per call) with amount bucket and account type
                → store in cache with confidence, source=llm
  → write categorization row on transaction (source, confidence, category_id, essentiality)
```

The LLM prompt includes the fixed taxonomy and the three essentiality labels and asks for structured output. The response is validated against the taxonomy; unknown labels fall back to `UNCATEGORIZED` with low confidence. A manual override on a transaction writes `source=manual`; "save as rule" also inserts a rules row and refreshes the cache. Editing a rule (`PATCH /api/rules/{id}`) removes the old version's manual cache rows as deleting it would, then saves and applies the new version as creating it would; transactions it no longer matches keep their category.

Privacy invariant, enforced in `services/scrub.ts` with tests: the string sent to the LLM contains no digit run longer than 3 characters and none of the configured owner-name tokens.

### Transfer detection

For each transaction new (or newly posted) in a sync, look for a posted transaction in a different owned account within ±5 days with amount equal and sign opposite, and pair them only with a transfer signal: a payment word in either side's description or payee (TRANSFER, XFER, PAYMENT, PYMT, AUTOPAY, ONLINE PMT, THANK YOU, ACH, ZELLE), checking or savings against credit or loan, or checking or savings on both sides. Two cards never pair without a payment word. Paired rows get `is_transfer=true` and are linked, and are excluded from income/expense aggregates. `POST /api/transactions/{id}/unpair` clears a wrong pair on both rows (and the transfer category pairing gave them); since a sync only pairs rows new to it, an unpaired pair stays unpaired. Independently, the money-movement categories in `aggregates.ts` (credit card payments; account, savings, and investment transfers) are excluded even when unpaired, for example when a card's history starts later than the account paying it.

### Recurring detection

Group transactions by merchant key and account. For groups with ≥3 occurrences, compute intervals between dates. If the median interval is near 7, 14, 30/31, or 365 days (or twice a month) with low variance and amounts within 15%, propose a recurrence. The owner confirms or dismisses. Confirmed recurrences have `next_expected_date` advanced on each matching sync.

### Projection

For a target month:
```
projected_end = current_total_balance
              + Σ confirmed recurring income/expenses due before month end
              + Σ unfulfilled manual entries due before month end
              + (daily_nonrecurring_income − daily_nonrecurring_expense) × remaining_days
```
The daily non-recurring averages cover the trailing 90 days (or less when history is shorter) of posted, non-transfer income and expenses from merchants that are not confirmed recurring. Unconfirmed paychecks and bills are therefore still projected through the averages, and move to their exact amounts and dates once confirmed. Applied per month for the 3-month outlook. Assumptions are returned alongside numbers so the UI can print them.

### Savings suggestions

Build a `SavingsContext`: per-category monthly totals for the last 6 months, discretionary and flexible recurring charges (category, amount, cadence; merchant name replaced by category label), goal target, deadline, and current gap. Send to `LLMProvider.suggestSavings`. Store each returned suggestion with `status=open`. The owner sets `kept` or `dismissed`. Dismissed ones are passed back as exclusions on the next call.

## Data model

| Table | Key columns |
|---|---|
| `accounts` | id, provider, external_id, name, type (checking/savings/credit/other), institution_name, currency, is_active |
| `balance_snapshots` | account_id, balance, available, as_of |
| `transactions` | id, account_id, external_id, posted_on, transacted_at, amount (negative = outflow), raw_description, payee, memo, pending, merchant_key, is_transfer, transfer_pair_id, note, one_time |
| `categories` | id, primary, detailed, label, is_hidden, is_custom |
| `categorizations` | transaction_id (unique), category_id, essentiality, source, confidence, updated_at |
| `merchant_classifications` | merchant_key (unique), category_id, essentiality, confidence, source |
| `rules` | id, match_type (exact/prefix/contains), pattern, category_id, essentiality |
| `manual_entries` | id, amount, description, category_id, due_date, recurrence, fulfilled_transaction_id |
| `recurrences` | id, merchant_key, account_id, amount, cadence, next_expected_date, status (proposed/confirmed/dismissed), essentiality |
| `goals` | id, name, target_amount, target_date, starting_amount, is_active |
| `suggestions` | id, goal_id, text, estimated_monthly_saving, status, created_at |
| `sync_runs` | id, provider, trigger, started_at, finished_at, status, added, updated, requests, error_text |
| `app_settings` | key, value, is_encrypted (the SimpleFIN access URL, the API key, and the runtime config) |
| `change_dismissals` | key, signal, dismissed_at ("What changed" items the owner dismissed) |

Money is `INTEGER` cents. Dates are `YYYY-MM-DD` text; timestamps are UTC ISO 8601 text. `server/src/db/schema.ts` is authoritative.

## API surface

All routes live under `/api`. The authoritative contract is the generated spec at `web/src/api/openapi.json`; this list is a summary.

```
GET  /api/health
GET  /api/accounts
POST /api/sync              GET  /api/sync/runs          GET /api/sync/runs/{id}     GET /api/sync/schedule
POST /api/recalculate       (header Refresh: re-apply rules, categorize from the cache, detect recurring; no bank, no LLM)
GET  /api/settings/simplefin   POST /api/settings/simplefin   DELETE /api/settings/simplefin
GET  /api/settings/llm      GET  /api/settings/config    PUT /api/settings/config
GET  /api/transactions      PATCH /api/transactions/{id}   POST /api/transactions/{id}/unpair
GET  /api/transactions/{id}/rule   (the rule categorization picks for it, or null, plus defaults for a new one)
POST /api/transactions/{id}/mark-posted   DELETE /api/transactions/{id}   (pending rows only; 409 otherwise)
GET  /api/transactions/summary   (the list's filters: count, pending count, and posted money out and in for every matching row; pending rows are in neither sum)
GET  /api/categories        POST /api/categories         PATCH /api/categories/{id}
GET  /api/rules             POST /api/rules              PATCH /api/rules/{id}       DELETE /api/rules/{id}
POST /api/rules/preview     (how many transactions a rule would match, and how many of them are manual; saves nothing)
GET  /api/reports/monthly   GET /api/reports/month/{month}   GET /api/reports/by-category?month=
GET  /api/reports/balances  GET /api/reports/changes     POST /api/reports/changes/dismiss
DELETE /api/reports/changes/dismissals
GET  /api/projection?months=3
GET  /api/recurring         POST /api/recurring          PATCH /api/recurring/{id}   (each charge's name is its latest matching payee, else the merchant key)
GET  /api/manual-entries    POST /api/manual-entries     PATCH /api/manual-entries/{id}   DELETE …
GET  /api/goals             POST /api/goals              GET /api/goals/{id}   PATCH /api/goals/{id}
GET  /api/goals/{id}/suggestions   POST /api/goals/{id}/suggestions   PATCH /api/suggestions/{id}
```

## Frontend

React 19, TypeScript 6, Vite 8. Libraries: TanStack Query (server state), React Router, shadcn/ui on Tailwind 4 (components), Recharts (charts), openapi-fetch with types generated by openapi-typescript (API calls). Lint with oxlint. Test with Vitest, Testing Library, and MSW. No global state library and no runtime schema validation, because types come straight from the API spec.

Pages, in navigation order:

1. **Overview** — "What changed" (each line marked by its kind and linked to its target), current-month summary with the difference from last month (uncoloured, since the month is in progress), income vs expenses (12 mo), balances over time, projection chart.
2. **Month** — one month against the three complete months before it: each tile shows the difference from the average, coloured by whether it is good for that metric once the month is complete; a month in progress shows a thin day bar. Its Income and Largest rows open the transaction panel.
3. **Transactions** — a one-line summary of the whole filtered set (count, posted spent and in, pending count), then the table, its header kept in view, with filters and inline category/essentiality editing; a row click opens the transaction panel, and after a category change the row offers "Make this a rule".
4. **Review** — uncategorized and low-confidence transactions to confirm or fix, and pending charges past the sync's reach.
5. **Recurring** — detected and confirmed recurrences by name (the merchant key under it), with how far away the next charge is (overdue in amber) and annual cost.
6. **Goals** — goal card with percentage complete, a progress bar coloured by on-track status, suggestions list, Suggest button.
7. **Planned** — manual expected income and expenses: simple form and list.
8. **Settings** — SimpleFIN token, sync now, sync history, runtime config (LLM provider, model, key, owner name tokens, sync settings), category management, rules (create, edit, delete), and the app version at the foot (`GET /api/health` reports the desktop release, or the server package version headless).

The **transaction panel** is one side sheet for every page (`web/src/app/TransactionPanelProvider.tsx`): a transaction's full details, its category and essentiality, and the rule that matches it, edited there, or a new one, with a live match count. Settings creates and edits rules with the same form in a dialog.

**Spending** (`/spending`) is a single-bucket essentiality breakdown reached from Overview and Month, not from the navigation.

Design rules: one primary action per page, muted palette with a single accent, numbers right-aligned in tabular figures, charts follow the `dataviz` skill conventions when implemented.

## Configuration

The desktop app reads its settings from the `app_settings` table only; the Settings page changes them. The headless server reads its process settings from the environment (`.env.example` lists them: `PLUTUS_SECRET_KEY`, `PLUTUS_DATA_DIR` / `PLUTUS_DB_PATH`, `PLUTUS_WEB_DIST`, `HOST`, `PORT`, `PLUTUS_ALLOWED_HOSTS`, `PLUTUS_API_GUARD`, `LOG_LEVEL`) and lets the runtime knobs (`LLM_PROVIDER`, `LLM_MODEL`, `ANTHROPIC_API_KEY`, `OLLAMA_BASE_URL`, `OWNER_NAME_TOKENS`, `SYNC_INTERVAL_HOURS`, `SYNC_FIRST_HISTORY_DAYS`, `SCHEDULER_ENABLED`) seed or override the table. `.env.example` is committed; `.env` is ignored.

## Security and privacy

- Secrets (the SimpleFIN access URL, the Anthropic API key) are encrypted at rest through the `SecretStore`: the macOS Keychain via `safeStorage` in the desktop, AES-256-GCM keyed by `PLUTUS_SECRET_KEY` headless. The desktop refuses to save a secret when OS encryption is unavailable.
- LLM payloads are built exclusively by `services/scrub.ts` and `services/suggestions.ts`; both have tests asserting no PII patterns.
- Outbound network is limited to SimpleFIN and the LLM endpoint.
- The desktop listens on loopback only, behind the per-launch cookie guard; links outside the app's origin open in the system browser.
- Every request must name this server in its `Host` header: `127.0.0.1`, `localhost`, `[::1]`, `HOST` when it is a name, or one of `PLUTUS_ALLOWED_HOSTS` (any port). Anything else gets a 403 before the guard runs, so a web page that rebinds its own domain to 127.0.0.1 (DNS rebinding) can neither read the API nor get the guard cookie.
- No secrets in logs.

## Testing

- Unit: scrub/normalize (golden file of descriptions → expected keys), transfer matching, recurrence detection, projection math, money and date helpers.
- Integration: sync against a recorded SimpleFIN fixture; categorization with the fake LLM provider; every route through `app.request`.
- Desktop: the testable parts in `desktop/src/lib` unit-tested; `npm run smoke` in `desktop/` opens the real window on a throwaway data dir and checks the SPA reaches `/api/health` through the cookie guard.
- Frontend: component tests with MSW.
- CI: on Linux, `npm ci`, `npm run check` (lint, typecheck, tests for web, server, desktop), and generated-client freshness; on macOS, an ad hoc signed desktop build (dmg and zip, arm64 and x64), `codesign --verify` on it, and `npm run smoke:dist` against the packaged app.

## Deployment

**Desktop**: macOS only. `make dist` packages the app with electron-builder into `desktop/release/`. With no signing identity configured the app is signed ad hoc; a Developer ID certificate and notarization come from environment variables (`desktop/README.md`). Data and the log file (`logs/plutus.log`) live in `~/Library/Application Support/Plutus`, or the folder given with `--data-dir`. The scheduler only runs while the app is open; an overdue sync runs about two minutes after launch.

**Headless (later)**: the same server on a single host behind a TLS reverse proxy, with the guard on and the SQLite file backed up.
