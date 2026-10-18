# Plutus

A private personal finance app for one person. Plutus pulls balances and transactions from your banks through [SimpleFIN Bridge](https://bridge.simplefin.org), categorizes them with an LLM without sending identifying data, and shows where your money goes, what repeats, where the month is heading, and what changed.

It is a desktop app (Electron) that keeps everything in one SQLite file on your machine. The same server also runs headless, without Electron, serving the web app on a port.

## What it does

- **Sync.** Read-only bank access through SimpleFIN, every 6 hours while the app is open or on demand, within SimpleFIN's 24-requests-a-day budget. The access link is encrypted at rest.
- **Categorize.** Plaid's personal finance categories plus your own custom ones. Your rules come first, then cached results, then Claude (or a local Ollama model) for merchants it hasn't seen. Each transaction is also marked essential, flexible, or discretionary.
- **Review.** A queue of transactions with no category or a low-confidence guess, with one-click "looks right", inline recategorizing, and "apply to all from this merchant" rules. Transactions can carry private notes.
- **Understand.** An Overview dashboard, a Month view compared with your recent average, spending breakdowns by category and essentiality, and a "What changed" list of anything unusual this month.
- **Plan.** Recurring charge detection (including twice-a-month pay), planned income and expenses, a 3-month balance projection that skips expenses you mark as one-time, and savings goals with suggestions.

## Privacy

Nothing identifying leaves your machine.

- **To the LLM** go only scrubbed merchant names (no account numbers, reference numbers, dates, phone numbers, your name, or the other person in Zelle, Venmo, Cash App, Apple Cash, wire, or bank transfers), a coarse amount range, and the account type. Savings suggestions see category totals only.
- **Never sent:** balances, account names, raw bank descriptions, or your notes. Tests enforce this.
- **Known limitation:** a PayPal payment to a person (`PAYPAL *NAME`) can't be told apart from a merchant, so that name is not removed.
- **Fully local option:** choose Ollama as the LLM provider in Settings and nothing goes to any outside service except SimpleFIN.

## Prerequisites

- [Node](https://nodejs.org) 24 or later, and GNU Make for the shortcuts below
- A [SimpleFIN Bridge](https://bridge.simplefin.org) account ($15 a year) for read-only bank access
- An [Anthropic API key](https://console.anthropic.com) for categorization, or [Ollama](https://ollama.com) to keep everything local

```bash
git clone git@github.com:refactoredjello/plutus-desktop.git
cd plutus && npm ci
```

## The desktop app

```bash
make dist
```

This builds the web app, the server, and the Electron shell and packages an unsigned app into `desktop/release/` (`mac-arm64/Plutus.app` on Apple Silicon, `mac/Plutus.app` on Intel). Copy it to Applications and open it. Data lives in `~/Library/Application Support/Plutus/plutus.sqlite`; secrets are encrypted with the macOS Keychain. See [desktop/README.md](desktop/README.md) for signing and where things live.

`make dev` opens a development build instead, with its data in `Plutus Dev`, so it never touches the installed app's database.

## The headless server

```bash
cp .env.example .env          # set PLUTUS_SECRET_KEY to a long random value
npm run build --workspace web && npm run build --workspace server
node --env-file=.env server/dist/main.js
```

Open http://127.0.0.1:8000. The database is `~/.plutus/plutus.sqlite` unless `PLUTUS_DATA_DIR` or `PLUTUS_DB_PATH` says otherwise; `.env.example` lists every variable. `PLUTUS_SECRET_KEY` encrypts the SimpleFIN link and the API key: changing it later means reconnecting your bank. `make dev-server` runs the server from source with reload.

## First run

1. Open Settings. Choose the LLM provider (Claude with your API key, or Ollama), and set the **owner name tokens**: the pieces of your name your bank prints, for example `JANE` and `DOE`, so they're scrubbed before categorization. Do this before the first sync, which caches categories from whichever provider is set.
2. In SimpleFIN Bridge, connect your banks and create a setup token. In Settings, paste the token and click Connect.
3. Click Sync now. The first sync fetches up to 180 days of history and takes a minute or two.
4. Work through the Review page to confirm or fix categories, and confirm detected items on the Recurring page.

Syncs then run every 6 hours while the app runs. SimpleFIN allows 24 requests a day; Settings shows how many are used, and Plutus refuses a sync that would exceed the budget.

## Try it without a bank

```bash
make demo-data      # into the headless server's database (PLUTUS_DATA_DIR, PLUTUS_DB_PATH)
make demo-clear
```

Run `make demo-clear` before connecting a real account, so demo categories aren't reused.

## Development

| Command | What it does |
|---|---|
| `make check` | Lint, typecheck, and test web, server, and desktop (what CI runs) |
| `make openapi` | Regenerate the API spec and the TypeScript client after a schema change |
| `make dev` / `make smoke` | Open the desktop app from source / check it reaches the API on a throwaway data dir |
| `make dev-server` | Headless server on :8000 with reload |
| `make dist` | Package the unsigned desktop app |
| `make demo-data` / `make demo-clear` | Load or remove fake demo data |

Run `make help` for the full list.

## How it's built

| Layer | Stack |
|---|---|
| Server | TypeScript on Node 24, Hono, Zod, Drizzle ORM, better-sqlite3, pino |
| Frontend | React 19, TypeScript, Vite, TanStack Query, shadcn/ui, Tailwind 4, Recharts |
| Desktop | Electron, electron-builder |
| Data | SQLite, one file |

```
server/   HTTP API: routes, schemas, services, providers, migrations, tests
web/      React app: pages, features, generated API client, mocks, tests
desktop/  Electron shell that runs the server in-process
docs/     Requirements, architecture, plans, and PRDs
```

Income, spending, and averages are defined once in `server/src/services/aggregates.ts`, so every page agrees. The frontend's API types are generated from the server's OpenAPI spec, and a test fails if they drift.

## Documentation

- [Requirements](docs/REQUIREMENTS.md): what Plutus does, the decisions log, and known limitations
- [Architecture](docs/ARCHITECTURE.md): system design and conventions
- [Agent plan](docs/AGENT_PLAN.md): the multi-agent workflow

## Status

Personal project, refined over time.
