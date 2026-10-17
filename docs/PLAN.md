# Plutus — Implementation Plan

Phases are ordered so each one leaves a working, demoable app. Estimates assume one developer working with an AI pair. Keep every phase small; cut scope rather than extend a phase.

## Phase 0 — Scaffold (½ day) — DONE 2026-10-03
- Repo layout: `api/`, `web/`, `compose.yaml`, `compose.override.yaml`, `.env.example`, `docs/`.
- FastAPI app with `/health`; Postgres; Alembic initialized with an empty migration.
- React + Vite + TypeScript + Tailwind + shadcn/ui, one page that calls `/health`.
- Lint, type-check, test runners wired. CI runs them on push.
- **Done when:** `docker compose up` shows a page that reports API and DB healthy.

## Phase 1 — SimpleFIN sync (1–2 days) — DONE 2026-10-03
- Tables: `accounts`, `balance_snapshots`, `transactions`, `sync_runs`, `settings`.
- `BankProvider` protocol and `SimpleFINProvider`. Setup-token exchange endpoint; encrypted storage.
- `services/sync.py` with idempotent upsert, 5-day overlap, 90-day chunking, run bookkeeping.
- APScheduler job every `SYNC_INTERVAL_HOURS`; `POST /sync` for manual trigger.
- Settings page: paste token, Sync now, run history table. Accounts list with balances.
- Tests against a fixture of SimpleFIN JSON.
- **Done when:** real accounts and transactions appear after pasting a token, and a second sync adds zero duplicates.

## Phase 2 — Transactions and taxonomy (1 day) — DONE 2026-10-03
- Tables: `categories`, `categorizations`, `rules`. Seed Plaid Personal Finance Categories.
- Transactions page: filters, pagination, inline category and essentiality editing, "save as rule."
- Transfer detection and `is_transfer` exclusion.
- **Done when:** every transaction can be categorized by hand and transfers are excluded from totals.

## Phase 3 — LLM categorization (1–2 days) — DONE 2026-10-03
- `scrub.py` with golden tests. `merchant_classifications` cache.
- `LLMProvider` protocol, `ClaudeProvider`, `OllamaProvider`, `FakeProvider` for tests.
- Pipeline rules → cache → LLM, batched. Confidence surfaced in UI with a "needs review" filter.
- **Done when:** a fresh sync leaves fewer than 10% of transactions uncategorized, and the scrub tests prove no digit runs or owner-name tokens reach the provider.

## Phase 4 — Dashboard (1 day) — DONE 2026-10-03
- `/reports/monthly`, `/reports/by-category`, balance history endpoints.
- Overview page: income vs expenses (12 mo), spend by category with drill-down, balances over time, discretionary vs essential.
- Follow `dataviz` skill conventions for palette and chart form.
- **Done when:** the Overview answers "how did last month go" in one glance.

## Phase 5 — Manual entries and recurring detection (1 day) — DONE 2026-10-03
- Tables: `manual_entries`, `recurrences`. Detection service with tests on synthetic histories.
- Manual entries page. Recurring page with confirm/dismiss and annual cost.
- **Done when:** known subscriptions are detected and expected paychecks can be entered.

## Phase 6 — Projection (½–1 day) — DONE 2026-10-03
- `services/projection.py` with unit tests on the formula. `/projection` endpoint.
- Projection chart on Overview with actual solid, projected dashed, assumptions listed.
- **Done when:** month-end number is within reason and assumptions are legible.

## Phase 7 — Goals and suggestions (1 day) — DONE 2026-10-03
- Tables: `goals`, `suggestions`. On-track calculation from income minus expenses trend.
- `suggestions.py` building aggregates-only context; `suggest_savings` on both LLM providers.
- Goals page with Suggest button, keep/dismiss.
- **Done when:** a goal shows required vs actual monthly saving and produces grounded suggestions that cite discretionary categories.

## Phase 8 — Auth and remote readiness (½–1 day)
- Password login, session cookie, route protection, logout. Login page.
- Production compose profile with Caddy, JSON logs, backup script, `README` for deploying to a VPS.
- **Done when:** the app runs on a remote host over HTTPS with the same images.

## v2 backlog (not scheduled)
- Plaid provider via the existing interface (Trial plan, 10 Items).
- Passkeys (WebAuthn) as a second login method.
- Category budgets with monthly caps.
- Investment balances and holdings.
- Export to CSV.
- Notifications for failed syncs or off-track goals.

## Working agreements
- Each phase ends with a short demo and a line in `docs/CHANGELOG.md`.
- Any new third-party dependency must replace code we would otherwise write; it is not added for convenience.
- UI additions require removing or merging something if a page exceeds one primary action.
- Decisions that change requirements go into the decisions log in `REQUIREMENTS.md`, with the why.
