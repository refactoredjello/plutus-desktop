# Plutus

A private, self-hosted personal finance app for one person. Plutus pulls balances and transactions from your banks through [SimpleFIN Bridge](https://bridge.simplefin.org), categorizes them with an LLM without sending identifying data, and shows where your money goes, what repeats, where the month is heading, and what changed.

It runs on your own machine with Docker Compose. Your data stays in your own Postgres database.

## What it does

- **Sync.** Read-only bank access through SimpleFIN, every 6 hours or on demand, within SimpleFIN's 24-requests-a-day budget. The access link is encrypted at rest.
- **Categorize.** Plaid's personal finance categories plus your own custom ones. Your rules come first, then cached results, then Claude (or a local Ollama model) for merchants it hasn't seen. Each transaction is also marked essential, flexible, or discretionary.
- **Review.** A queue of transactions with no category or a low-confidence guess, with one-click "looks right", inline recategorizing, and "apply to all from this merchant" rules. Transactions can carry private notes.
- **Understand.** An Overview dashboard, a Month view compared with your recent average, spending breakdowns by category and essentiality, and a "What changed" list of anything unusual this month.
- **Plan.** Recurring charge detection (including twice-a-month pay), planned income and expenses, a 3-month balance projection that skips expenses you mark as one-time, and savings goals with suggestions.

## Privacy

Nothing identifying leaves your machine.

- **To the LLM** go only scrubbed merchant names (no account numbers, reference numbers, dates, phone numbers, your name, or the other person in Zelle, Venmo, Cash App, Apple Cash, wire, or bank transfers), a coarse amount range, and the account type. Savings suggestions see category totals only.
- **Never sent:** balances, account names, raw bank descriptions, or your notes. Tests enforce this.
- **Known limitation:** a PayPal payment to a person (`PAYPAL *NAME`) can't be told apart from a merchant, so that name is not removed.
- **Fully local option:** set `LLM_PROVIDER=ollama` and nothing goes to any outside service except SimpleFIN.

## Setup

### 1. Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (runs Postgres, the API, and the web app)
- A [SimpleFIN Bridge](https://bridge.simplefin.org) account ($15 a year) for read-only bank access
- An [Anthropic API key](https://console.anthropic.com) for categorization, or [Ollama](https://ollama.com) to keep everything local
- For development outside Docker: [uv](https://docs.astral.sh/uv/), Node 24+, and GNU Make

### 2. Get the code and create your config

```bash
git clone git@github.com:refactoredjello/plutus-desktop.git
```

```bash
cd plutus && cp .env.example .env
```

### 3. Fill in `.env` before the first sync

Order matters here: the first sync encrypts your bank link with `SECRET_KEY` and caches categories from whichever LLM is configured.

1. `SECRET_KEY`: a long random value. Generate one with `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`. Changing it later means reconnecting your bank.
2. `LLM_PROVIDER=claude` and `ANTHROPIC_API_KEY=...`, or `LLM_PROVIDER=ollama` with `OLLAMA_BASE_URL`. Leave `fake` only while exploring with demo data.
3. `OWNER_NAME_TOKENS`: the pieces of your name your bank prints, for example `["JANE","DOE"]`, so they're scrubbed before categorization.
4. Optional: `APP_PASSWORD_HASH` from `make password-hash`. Keep the single quotes around it; the hash contains `$` signs that Docker Compose would otherwise expand.

### 4. Start Plutus

```bash
make up
```

This builds the images, applies database migrations, and starts everything. Open http://plutus.localhost:5173. The API docs are at http://localhost:8000/api/docs.

### 5. Connect your bank

1. In SimpleFIN Bridge, connect your banks and create a setup token.
2. In Plutus, open Settings, paste the token, and click Connect.
3. Click Sync now. The first sync fetches up to 180 days of history and takes a minute or two.
4. Work through the Review page to confirm or fix categories, and confirm detected items on the Recurring page.

Syncs then run every 6 hours. SimpleFIN allows 24 requests a day; Settings shows how many are used, and Plutus refuses a sync that would exceed the budget.

### Try it without a bank

```bash
make demo-data
```

Run `make demo-clear` before connecting a real account, so demo categories aren't reused.

### Optional: a nicer local address

To use http://plutus.local:5173, add both hosts entries once. The IPv6 entry avoids a five-second Bonjour delay on macOS.

```bash
echo "127.0.0.1 plutus.local" | sudo tee -a /etc/hosts
```

```bash
echo "::1 plutus.local" | sudo tee -a /etc/hosts
```

### Development setup

For running checks and tests on your machine instead of inside Docker:

```bash
cd api && uv sync && cd ../web && npm ci && cd ..
```

```bash
make check
```

Backend tests need the Compose Postgres running (`make check` starts it) and use the `plutus_test` database, created on first start.

### Troubleshooting

| Symptom | Fix |
|---|---|
| `make up` prints `The "argon2id" variable is not set` | Wrap `APP_PASSWORD_HASH` in single quotes in `.env` |
| A sync says the daily request budget is reached | Wait; the budget is a rolling 24 hours of SimpleFIN requests |
| SimpleFIN warns about a date range over 45 days | Update Plutus; current versions request 45-day chunks |
| plutus.local is slow to load | Add the `::1 plutus.local` hosts entry |
| Categories look wrong right after the first sync | Check `LLM_PROVIDER` wasn't `fake`; recategorize with "apply to all" to create rules |

## Configuration

All configuration comes from environment variables; see `.env.example`.

| Variable | Purpose |
|---|---|
| `SECRET_KEY` | Signs sessions and encrypts the SimpleFIN access link |
| `APP_PASSWORD_HASH` | Login password hash (`make password-hash`; keep the single quotes) |
| `LLM_PROVIDER`, `LLM_MODEL` | `claude`, `ollama`, or `fake`; default model `claude-haiku-4-5` |
| `ANTHROPIC_API_KEY`, `OLLAMA_BASE_URL` | Credentials or endpoint for the chosen provider |
| `OWNER_NAME_TOKENS` | Name fragments to scrub before anything reaches an LLM |
| `SYNC_INTERVAL_HOURS`, `SYNC_FIRST_HISTORY_DAYS` | Sync cadence and how far back the first sync reaches |

## Commands

Run `make help` for the full list.

| Command | What it does |
|---|---|
| `make up` / `make down` | Start or stop the stack |
| `make check` | Lint, type-check, and test backend and frontend |
| `make openapi` | Regenerate the API spec and TypeScript client after a schema change |
| `make migrate` | Apply database migrations |
| `make demo-data` / `make demo-clear` | Load or remove fake demo data |
| `make password-hash` | Print a hash for `APP_PASSWORD_HASH` |

## How it's built

| Layer | Stack |
|---|---|
| Backend | Python 3.14, FastAPI, Pydantic v2, SQLAlchemy 2, Alembic, APScheduler, uv |
| Frontend | React 19, TypeScript, Vite, TanStack Query, shadcn/ui, Tailwind 4, Recharts |
| Data | Postgres 16 |
| Runtime | Docker Compose, twelve-factor configuration |

```
api/    FastAPI app: models, schemas, routers, services, providers, tests
web/    React app: pages, features, generated API client, mocks, tests
db/     Postgres init (creates the test database)
docs/   Requirements, architecture, plans, and PRDs
```

Income, spending, and averages are defined once in `api/app/services/aggregates.py`, so every page agrees. The frontend's API types are generated from the backend's OpenAPI spec, and a test fails if they drift.

## Documentation

- [Requirements](docs/REQUIREMENTS.md): what Plutus does, the decisions log, and known limitations
- [Architecture](docs/ARCHITECTURE.md): system design and backend conventions
- [Plan](docs/PLAN.md) and [Agent plan](docs/AGENT_PLAN.md): how it's built, including the multi-agent workflow

## Status

Personal project, refined over time. Login and the production deployment setup (HTTPS, backups) are the next planned work.
