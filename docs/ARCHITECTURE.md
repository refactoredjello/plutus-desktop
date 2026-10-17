# Plutus — Architecture

Companion to REQUIREMENTS.md. Describes how v1 is built. Principles from the requirements apply: simplest thing that works, reuse established tools, clean interface.

## System overview

Three containers, one network, orchestrated by Docker Compose:

```
┌──────────┐     ┌──────────────────────────┐     ┌────────────┐
│  web     │────▶│  api                     │────▶│  db        │
│  React   │     │  FastAPI + APScheduler   │     │  Postgres  │
│  (Vite)  │     │  one process             │     │  16        │
└──────────┘     └───────────┬──────────────┘     └────────────┘
                             │ outbound HTTPS only
                   ┌─────────┴──────────┐
                   ▼                    ▼
            SimpleFIN Bridge      LLM provider
            (bank data)           (Claude API or local Ollama)
```

- **web**: React SPA. In development, the Vite dev server with proxy to `api`. In production, a static build served by nginx inside the same image, or served by the API itself. Choose the former; it is standard.
- **api**: FastAPI app. Also hosts the scheduler. Stateless aside from the scheduler's in-memory job table, which is rebuilt from config on start.
- **db**: Postgres 16 with a named volume. A second database, `plutus_test`, is created on first start for tests. Only stateful component.

No Redis, no broker, no separate worker. If a sync ever needs to outlive a request, APScheduler runs it in a thread; the UI polls the sync-run row for status.

## Backend

Python 3.14, managed with uv. Package layout, one module per concern:

```
api/
  app/
    main.py            FastAPI app factory, routers, scheduler startup
    config.py          pydantic-settings; all config from env
    db.py              SQLAlchemy 2 engine/session
    models/            SQLAlchemy models (one file per aggregate)
    schemas/           Pydantic request/response models
    routers/           accounts, transactions, categories, sync, manual_entries,
                       recurring, projection, goals, auth, health
    providers/
      bank/base.py     BankProvider protocol
      bank/simplefin.py
      llm/base.py      LLMProvider protocol
      llm/claude.py
      llm/ollama.py
    services/
      sync.py          orchestrates a sync run
      categorize.py    rules → cache → LLM pipeline
      scrub.py         PII scrubbing + merchant normalization
      transfers.py     internal transfer matching
      recurring.py     recurrence detection
      projection.py    month-end and 3-month outlook
      suggestions.py   aggregates → LLM → stored suggestions
      auth.py          password verify, session cookie
    scheduler.py       APScheduler setup: sync every 6h
  alembic/             migrations
  tests/
```

Key libraries: FastAPI, Pydantic v2, SQLAlchemy 2, Alembic, psycopg 3, pydantic-settings, httpx, APScheduler, structlog, anthropic SDK, argon2-cffi (password hashing), cryptography (Fernet for the SimpleFIN access URL at rest).

### Backend conventions

These apply to all backend code. Agents follow them without asking.

| Area | Convention |
|---|---|
| Tooling | uv for dependencies and lockfile. ruff for lint and format. mypy in strict mode. pytest. pre-commit runs ruff and mypy. |
| Sync vs async | Plain `def` endpoints with sync SQLAlchemy and psycopg 3. FastAPI runs them in a threadpool. One user does not need async, and sync avoids lazy-load and session-lifetime pitfalls. httpx is used in sync mode. |
| Models | SQLAlchemy 2 typed models (`Mapped[...]`, `mapped_column`) for tables. Pydantic v2 models for every request and response. The two are never mixed; SQLModel is not used. Response schemas set `from_attributes=True`. |
| Schema naming | `XCreate`, `XUpdate` (all fields optional, used for PATCH), `XRead`. List endpoints return `Page[XRead]` with `items`, `total`, `limit`, `offset`. |
| Money | `Decimal` everywhere, `NUMERIC(14,2)` in Postgres, serialized as a JSON string so no float rounding reaches the browser. Never `float`. |
| Time | `timestamptz` stored in UTC. Transaction posting dates are plain `date`. |
| Dependency injection | `Annotated` aliases such as `DbSession = Annotated[Session, Depends(get_db)]` and `CurrentUser`. One session per request, committed by the service layer, not the router. |
| Layers | Routers handle HTTP only: parse, call one service function, return a schema. Business logic lives in `services/`. Services never import FastAPI. |
| App lifecycle | `lifespan` context manager starts and stops the scheduler. No `on_event`. |
| Config | One `Settings` class via pydantic-settings, loaded once and injected. Secrets typed as `SecretStr` so they never print. |
| Errors | Domain errors are plain exceptions in services, mapped to HTTP responses by one exception handler. Error bodies follow RFC 9457 problem details. |
| OpenAPI | Every route has a `response_model`, a tag, and a stable operation ID derived from tag and function name. The TypeScript client is generated from this spec with openapi-typescript and called through openapi-fetch. |
| Logging | structlog. Pretty console in development, JSON in production. A request ID middleware adds the ID to every log line. |
| Testing | pytest against a real Postgres from compose, never SQLite. Each test runs inside a transaction that is rolled back. `TestClient` for routes. Fake providers for SimpleFIN and the LLM. |
| Docker | Multi-stage build with uv, slim base image, non-root user, healthcheck on `/health`. |
| Pagination | `limit` and `offset` query parameters. Cursor pagination is not needed at this scale. |


### Provider interfaces

```python
class BankProvider(Protocol):
    def fetch(self, start: date, end: date) -> ProviderSnapshot: ...
    # ProviderSnapshot: list[ProviderAccount] each with balance, available,
    # balance_date, and list[ProviderTransaction] (external_id, posted,
    # amount, description, payee, memo, pending)

class LLMProvider(Protocol):
    def classify_merchants(self, items: list[MerchantInput]) -> list[MerchantClassification]: ...
    def suggest_savings(self, aggregates: SavingsContext) -> list[Suggestion]: ...
```

Both return plain dataclasses. Nothing provider-specific leaks past these boundaries. Adding Plaid later means one new file under `providers/bank/` plus a Link flow in the UI.

### SimpleFIN sync algorithm

1. Create a `sync_runs` row with status `running`.
2. Determine window: `start = last_successful_sync_start - 5 days` (or `SYNC_FIRST_HISTORY_DAYS`, default 180, on the first run), `end = now`. Requests are chunked to 45 days: SimpleFIN documents 90, but the live bridge warns above 45 and may cap there.
3. `GET {access_url}/accounts?start-date=…&end-date=…` with Basic Auth from the access URL.
4. For each account: upsert by `(provider, external_account_id)`. Insert a `balance_snapshots` row.
5. For each transaction: upsert by `(account_id, external_transaction_id)`. If an existing row was `pending` and is now posted, update in place. Rows absent from a window they previously appeared in are left alone in v1 (SimpleFIN does not report removals).
6. Run `transfers.match()` on new rows, then `categorize.run()` on uncategorized rows.
7. Mark the run `success` or `error` with counts and provider `errlist` messages. Never retry within the same run.

Request budget: one request per 45-day chunk per sync. A default first sync is 4 requests. Steady state is 1 request per sync, 4 scheduled syncs per day.

### Categorization pipeline

```
raw description
  → normalize   (uppercase, collapse whitespace, strip store numbers, strip "SQ *", "TST*", "PP*", etc.)
  → scrub       (remove digit runs ≥4, dates, phone numbers, "CHK #", "REF", names after "ZELLE TO/FROM", "VENMO")
  → key = normalized merchant string
  → rules       owner-defined, exact or prefix match on key → category + essentiality
  → cache       merchant_classifications table keyed by `key`
  → LLM         batch of unseen keys (up to ~50 per call) with amount bucket and account type
                → store in cache with confidence, source=llm
  → write categorization row on transaction (source, confidence, category_id, essentiality)
```

The LLM prompt includes the fixed taxonomy and the three essentiality labels and asks for JSON. Response is validated against the taxonomy; unknown labels fall back to `UNCATEGORIZED` with low confidence. Manual override on a transaction writes `source=manual`; "save as rule" also inserts a rules row and refreshes cache.

Privacy invariant, enforced in `scrub.py` with tests: the string sent to the LLM contains no digit run longer than 3 characters and none of the configured owner-name tokens.

### Transfer detection

For each new transaction, look for a transaction in a different owned account within ±5 days with amount equal and sign opposite. Mark both `is_transfer=true` and link them. Excluded from income/expense aggregates. Independently, `aggregates.MONEY_MOVEMENT` categories (credit card payments; account, savings, and investment transfers) are excluded even when unpaired, for example when a card's history starts later than the account paying it.

### Recurring detection

Group transactions by merchant key and account. For groups with ≥3 occurrences, compute intervals between dates. If median interval is near 7, 14, 30/31, or 365 days with low variance and amounts within 15%, propose a recurrence. Owner confirms or dismisses. Confirmed recurrences have `next_expected_date` advanced on each matching sync.

### Projection

For a target month:
```
projected_end = current_total_balance
              + Σ confirmed recurring income/expenses due before month end
              + Σ unfulfilled manual entries due before month end
              + (daily_nonrecurring_income − daily_nonrecurring_expense) × remaining_days
```
The daily non-recurring averages cover the trailing 90 days (or less when history is shorter) of non-transfer income and expenses from merchants that are not confirmed recurring. Unconfirmed paychecks and bills are therefore still projected through the averages, and move to their exact amounts and dates once confirmed. Applied per month for the 3-month outlook. Assumptions are returned alongside numbers so the UI can print them.

### Savings suggestions

Build a `SavingsContext`: per-category monthly totals for the last 6 months, discretionary and flexible recurring charges (category, amount, cadence; merchant name replaced by category label), goal target, deadline, and current gap. Send to `LLMProvider.suggest_savings`. Store each returned suggestion with `status=open`. Owner sets `kept` or `dismissed`. Dismissed ones are passed back as exclusions on the next call.

### Auth

`APP_PASSWORD_HASH` (argon2) in env. `POST /auth/login` verifies and sets an HttpOnly, Secure, SameSite=Lax session cookie signed with `SECRET_KEY`. Middleware requires the cookie on everything except `/health` and `/auth/*`. Sessions table is not needed; the cookie is a signed, expiring token. Passkeys later: add a `credentials` table and WebAuthn endpoints; the session cookie stays the same.

## Data model

| Table | Key columns |
|---|---|
| `accounts` | id, provider, external_id, name, type (checking/savings/credit/other), institution_name, currency, is_active |
| `balance_snapshots` | account_id, balance, available, as_of |
| `transactions` | id, account_id, external_id, posted_at, amount (negative = outflow), raw_description, payee, memo, pending, merchant_key, is_transfer, transfer_pair_id |
| `categories` | id, primary, detailed, label, is_hidden, is_custom |
| `categorizations` | transaction_id (unique), category_id, essentiality, source, confidence, updated_at |
| `merchant_classifications` | merchant_key (unique), category_id, essentiality, confidence, source |
| `rules` | id, match_type (exact/prefix), pattern, category_id, essentiality |
| `manual_entries` | id, amount, description, category_id, due_date, recurrence, fulfilled_transaction_id |
| `recurrences` | id, merchant_key, account_id, amount, cadence, next_expected_date, status (proposed/confirmed/dismissed), essentiality |
| `goals` | id, name, target_amount, target_date, start_balance_snapshot |
| `suggestions` | id, goal_id, text, estimated_monthly_saving, status, created_at |
| `sync_runs` | id, provider, started_at, finished_at, status, added, updated, error_text |
| `settings` | key, value_encrypted (SimpleFIN access URL lives here) |

Amounts are `NUMERIC(14,2)`. Timestamps are `timestamptz`.

## API surface

All routes live under `/api`, so the browser, the Vite dev proxy, and nginx in production all use the same paths. The authoritative contract is the generated spec at `web/src/api/openapi.json`; this list is a summary.

```
GET  /api/health
POST /api/auth/login        POST /api/auth/logout        GET /api/auth/session
GET  /api/accounts
POST /api/sync              GET  /api/sync/runs          GET /api/sync/runs/{id}
GET  /api/settings/simplefin   POST /api/settings/simplefin   DELETE /api/settings/simplefin
GET  /api/settings/llm
GET  /api/transactions      PATCH /api/transactions/{id}
GET  /api/categories        POST /api/categories         PATCH /api/categories/{id}
GET  /api/rules             DELETE /api/rules/{id}
GET  /api/reports/monthly   GET /api/reports/by-category?month=   GET /api/reports/balances
GET  /api/projection?months=3
GET  /api/recurring         PATCH /api/recurring/{id}
GET  /api/manual-entries    POST /api/manual-entries     PATCH /api/manual-entries/{id}   DELETE …
GET  /api/goals             POST /api/goals              GET /api/goals/{id}   PATCH /api/goals/{id}
GET  /api/goals/{id}/suggestions   POST /api/goals/{id}/suggestions   PATCH /api/suggestions/{id}
```

## Frontend

React 19, TypeScript 6, Vite 8. Libraries: TanStack Query (server state), React Router, shadcn/ui on Tailwind 4 (components), Recharts (charts), openapi-fetch with types generated by openapi-typescript (API calls). Lint with oxlint, the Vite template default. Test with Vitest, Testing Library, and MSW. No global state library and no runtime schema validation, because types come straight from the API spec.

Pages, in navigation order:

1. **Overview** — current-month summary, income vs expenses (12 mo), balances over time, projection chart.
2. **Transactions** — table with filters and inline category/essentiality editing.
3. **Recurring** — detected and confirmed recurrences with annual cost.
4. **Goals** — goal card with on-track indicator, suggestions list, Suggest button.
5. **Planned** — manual expected income and expenses: simple form and list.
6. **Settings** — SimpleFIN token, sync now, sync history, category management, LLM provider status.

Design rules: one primary action per page, muted palette with a single accent, numbers right-aligned in tabular figures, charts follow the `dataviz` skill conventions when implemented.

## Configuration (environment)

```
DATABASE_URL=postgresql+psycopg://…
SECRET_KEY=…                      session signing + Fernet key derivation
APP_PASSWORD_HASH=…               argon2 hash
LLM_PROVIDER=claude|ollama
ANTHROPIC_API_KEY=…               when claude
LLM_MODEL=claude-haiku-4-5
OLLAMA_BASE_URL=http://ollama:11434   when ollama
SYNC_INTERVAL_HOURS=6
OWNER_NAME_TOKENS=…               comma-separated names to scrub
LOG_LEVEL=info
```

`.env.example` committed; `.env` ignored. Same image for local and remote; only env differs.

## Twelve-factor mapping

| Factor | How |
|---|---|
| Codebase | One repo, `api/`, `web/`, `compose.yaml` |
| Dependencies | `pyproject.toml` + lockfile (uv), `package-lock.json` |
| Config | Env only, see above |
| Backing services | Postgres, SimpleFIN, LLM all addressed by URL |
| Build/release/run | Images built in CI; `alembic upgrade head` as release step; `compose up` to run |
| Processes | API stateless; scheduler state is config-derived |
| Port binding | API on 8000, web on 80 inside containers |
| Concurrency | Scale not needed; uvicorn workers=1 |
| Disposability | Fast start, graceful shutdown stops scheduler |
| Dev/prod parity | Same compose file with an override for dev (Vite, bind mounts) |
| Logs | stdout, JSON in prod |
| Admin processes | `alembic`, a `seed-categories` CLI, run via `docker compose run api …` |

## Security and privacy

- SimpleFIN access URL encrypted with Fernet at rest; decrypted only in `providers/bank/simplefin.py`.
- LLM payloads are built exclusively by `scrub.py` and `suggestions.py`; both have tests asserting no PII patterns.
- Outbound network from `api` is limited to SimpleFIN and the LLM endpoint. Document this; enforce with firewall rules at remote deployment.
- Cookies HttpOnly + Secure. HTTPS terminated by a reverse proxy (Caddy) on the remote host.
- No secrets in logs; `config.py` redacts on repr.

## Testing

- Unit: scrub/normalize (golden file of real-looking descriptions → expected keys), transfer matching, recurrence detection, projection math.
- Integration: sync against a recorded SimpleFIN fixture JSON; categorization with a fake LLM provider.
- Frontend: component tests for the transactions table edit flow; otherwise rely on TypeScript and zod.
- CI: lint (ruff, oxlint), type-check (mypy, tsc), tests, generated-client freshness, image builds.

## Deployment

**Local**: `docker compose up`. `compose.override.yaml` mounts source and runs Vite + uvicorn `--reload`.

**Remote (later)**: single VPS, Docker Compose, Caddy for TLS, Postgres volume backed up nightly with `pg_dump` to object storage. Same images, different `.env`. Consider Tailscale instead of a public domain if the owner is the only client.
