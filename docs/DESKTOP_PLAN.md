# Plutus — Desktop Port Plan (TypeScript + Electron)

How to turn Plutus from a Docker Compose web app into a desktop app with a TypeScript backend, executed by one orchestrating session and a roster of Opus subagents working in parallel. Companion to REQUIREMENTS.md, ARCHITECTURE.md, and AGENT_PLAN.md. Written 2026-10-17.

Read sections 1 to 4 first. Section 5 holds the fixed decisions every agent works under, including the test-driven and git rules. Section 6 is the orchestrator's runbook. Section 8 holds the briefs, one per agent.

**Where the work happens.** In a separate, fresh repository at `~/dev/plutus-desktop` holding a copy of the Plutus tree, with its own history starting at the port. `~/dev/Plutus` is not touched during the port. The new repository has no remote until the owner reviews the finished port. See section 5.14.

---

## 1. Decision summary

**What we are building.** One Electron app. Inside it, a Node process runs a TypeScript HTTP server on a random loopback port, serves the existing React build, and talks to a SQLite file in the user's data directory. The server is a plain HTTP server, so it can also run headless on a VPS later.

**What changes.**

| Today | After |
|---|---|
| Python 3.14, FastAPI, SQLAlchemy, Alembic | TypeScript, Hono, Drizzle, drizzle-kit |
| Postgres 16 in Docker | SQLite file via better-sqlite3 |
| `NUMERIC(14,2)` and `Decimal` | integer cents in the database, `"123.45"` strings on the wire (unchanged wire format) |
| APScheduler | in-process timer in the server, same cadence logic |
| Secrets in `.env` plus Fernet | Electron `safeStorage` for the SimpleFIN access URL and API key; app settings table holds the rest |
| Auth stubs (R9) | removed: the OS login is the auth |
| Docker Compose, nginx, CI with Postgres | `npm` workspaces, electron-builder, CI with Node only |
| `web/` React app | unchanged, except a new config card on Settings |

**What does not change.** Every `/api` path, method, request and response shape. The generated client in `web/src/api` is regenerated from the new server and must produce no changes the frontend has to react to, other than the additions this plan names. The finance rules, scrubbing rules, prompts, and thresholds are ported exactly; the Python app is the oracle until a parity harness says the two agree.

**Repository.** `~/dev/plutus-desktop` is a fresh `git init` holding a copy of every file tracked in `~/dev/Plutus` plus the plan files, so the React app, the Python oracle, and the docs come along. Its history starts at the port; the old history stays in `~/dev/Plutus` for archaeology. `api/` stays in the new repository as the oracle until Wave 5 deletes it. Postgres for the oracle comes from the existing compose stack, started from either checkout: both define the compose project `plutus`, so they share one database server.

**Requirements changes to record** in the REQUIREMENTS.md decisions log at Wave 0: Portability now means "a desktop app, with the server still deployable headless"; R9 auth is dropped; R10.3 migrations run at app start, since there is no release step on a desktop.

**Assumption to confirm with the owner.** The untracked rule-builder and bug-fix backlog in `docs/HANDOFF_RULES_AND_BUGS.md` is not implemented in Python during the port. Its service-level changes land in TypeScript after cutover (section 9). Porting a moving target would break parity.

---

## 2. Orchestrator model

**Opus 5.5 orchestrates. Fable 5.1 reviews at two checkpoints.**

Reasoning: the orchestrator is the most expensive session in this plan because it is long-lived and reads every diff, every test run, and every report. Its work, given that the briefs below are already written, is dispatch, review, merge, and running the gates. That is Opus work. Fable's advantage is in the judgement calls, and those are concentrated in two places: the foundation contract (money, dates, schema, Zod contract) and the parity signoff. Run those two as separate, bounded Fable sessions:

- **Checkpoint A, end of Wave 0:** review `server/src/lib/money.ts`, `dates.ts`, `db/schema.ts`, the Zod schemas, and the contract test. Mistakes here propagate into every later brief.
- **Checkpoint B, end of Wave 4:** read the parity diff and the fix list, decide whether remaining differences are bugs in the port or bugs in the Python app, and approve cutover.

Rough token volume, for budgeting. Treat as order-of-magnitude.

| Session | Count | Volume each |
|---|---|---|
| Orchestrator (Opus) | 1, long-lived | several million input tokens over the project, mostly cached |
| Subagent runs (Opus) | 14 briefs plus fix follow-ups | one to three million input tokens each |
| Fable checkpoints | 2, bounded | a few hundred thousand each |

If the owner prefers Fable as orchestrator anyway, nothing else in this plan changes.

---

## 3. Roles

All subagents run on Opus. Each works in its own git worktree on a branch named `port/<brief-id>-<area>`, touches only the files its brief lists, and reports back. Role definitions live in `.claude/agents/`.

| Role | Agent file | Used by briefs | Owns |
|---|---|---|---|
| Orchestrator | the main session | all waves | `server/src/app.ts`, `server/src/db/schema.ts`, `server/src/db/migrations/`, `server/src/schemas/`, root `package.json`, `Makefile`, CI, merges, gates |
| server-engineer | `.claude/agents/server-engineer.md` | 0A, 0B, 1A to 1E, 2A to 2C, 3A, 3B | files under `server/` named in each brief |
| desktop-engineer | `.claude/agents/desktop-engineer.md` | 1F, 5B | `desktop/` |
| parity-engineer | `.claude/agents/parity-engineer.md` | 1G, 2D, 4A | `tools/parity/`, `api/app/export_json.py`, `server/scripts/import-json.ts`, and the one-line `PLUTUS_TODAY` change in `api/app/services/schedule.py` |
| frontend-engineer | `.claude/agents/frontend-engineer.md` (existing, model bumped to opus) | 2E, 5C | `web/` |
| backend-engineer | `.claude/agents/backend-engineer.md` (existing) | none; the Python code is frozen during the port | |
| docs-writer | `.claude/agents/docs-writer.md` | 6A | `README.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/agents/*.md`, `docs/`, and every package and tool README |

Brief ids by role:

| Id | Brief | Role |
|---|---|---|
| 0A | Server foundation | server-engineer |
| 0B | API contract: Zod schemas, route stubs, OpenAPI parity | server-engineer |
| 1A | Scrub and merchant keys | server-engineer |
| 1B | Schedule and recurring detection | server-engineer |
| 1C | Aggregates, reports, accounts | server-engineer |
| 1D | Providers: SimpleFIN, Claude, Ollama, fake | server-engineer |
| 1E | App settings, secrets, config endpoints | server-engineer |
| 1F | Electron shell | desktop-engineer |
| 1G | Parity harness | parity-engineer |
| 2A | Transfers, categorization, rules, transactions | server-engineer |
| 2B | Projection, manual entries, goals, suggestions | server-engineer |
| 2C | Health, categories list, remaining small routes | folded into 2A and 2B; see briefs |
| 2D | Postgres export and SQLite import | parity-engineer |
| 2E | Settings config card | frontend-engineer |
| 3A | Sync, scheduler, demo loader | server-engineer |
| 3B | What changed | server-engineer |
| 4A | Parity run and fix list | parity-engineer, fixes by the owning agents |
| 5A | Cutover: remove Python, Docker, Postgres; docs; CI | server-engineer |
| 5B | Packaging and signing | desktop-engineer |
| 5C | Frontend cleanup after cutover | frontend-engineer |
| 6A | Documentation pass: README, agent docs, architecture, every README | docs-writer |

---

## 4. High-level overview

### 4.1 Waves

```
Wave 0   0A foundation ──▶ 0B contract            (0B overlaps Wave 1)
                 │
Wave 1   1A scrub   1B schedule+recurring   1C aggregates+reports   1D providers   1E settings
         1F electron shell                  1G parity harness        (all parallel)
                 │
Wave 2   2A categorize+transactions   2B planning   2D pg export/import   2E settings card
                 │
Wave 3   3A sync+scheduler+demo   3B what changed
                 │
Wave 4   4A parity run ──▶ fix briefs to owning agents ──▶ Fable checkpoint B
                 │
Wave 5   5A cutover   5B packaging   5C frontend cleanup
                 │
Wave 6   6A documentation pass
```

Parallelism: up to five agents in Wave 1, four in Wave 2, two in Wave 3, three in Wave 5, one in Wave 6. The orchestrator merges a wave in dependency order and runs the gate before starting the next.

Rough duration with agents: Wave 0 two days, Waves 1 to 3 one to two days each, Wave 4 one to three days depending on the diff, Wave 5 one to two days, Wave 6 under a day. Call it two to three weeks of calendar time at a steady pace.

### 4.2 The three things that make this a port, not a rewrite

1. **The contract is frozen.** `web/src/api/openapi.json` describes every endpoint. Brief 0B builds Zod schemas and 501 stubs for all of them before any service is ported, and a test proves the new spec covers the old one.
2. **The tests are the spec.** 209 pytest tests pin down the finance rules. Every brief ports its Python tests alongside its code. A ported module is done when its ported tests pass, not when it "looks right".
3. **The Python app is the oracle.** The parity harness loads the same fake data into both apps, fixes "today", calls every endpoint on both, and diffs the JSON. Cutover waits for an empty diff or an explained one.

### 4.3 Repository shape at the end

```
plutus/
  package.json            npm workspaces: web, server, desktop; root scripts
  Makefile                check, openapi, demo-data, dev, dist
  web/                    React SPA, unchanged
  server/                 TypeScript backend
    src/
      app.ts              createApp({ db, secrets, config }) → Hono app; routes registered here
      main.ts             headless entry: serves web/dist and /api on a port
      config.ts           runtime config (data dir, today override, env defaults)
      db/
        schema.ts         Drizzle tables, one file
        migrations/       drizzle-kit SQL migrations, plus the category seed
        index.ts          openDb(path), migrate(db)
      lib/
        money.ts          Cents, parse/format, half-even division, median
        dates.ts          PlainDate helpers, today()
        errors.ts         DomainError family, problem+json
        log.ts            pino
      schemas/            Zod schemas, one file per domain, component names match Pydantic
      routes/             one file per router, thin: parse, call one service, return schema
      services/           ported business logic, one file per Python module
      providers/
        bank/             types.ts, simplefin.ts
        llm/              types.ts, prompts.ts, claude.ts, ollama.ts, fake.ts, index.ts
      scheduler.ts        periodic sync
      secrets.ts          SecretStore interface and KeySecretStore
    scripts/
      export-openapi.ts   writes web/src/api/openapi.json
      demo.ts             load | clear fake data
      import-json.ts      import a Postgres export
    test/
      setup.ts            in-memory SQLite per test, migrated and seeded
      factories.ts        ported from api/tests/factories.py
      fixtures/           copied from api/tests/fixtures
  desktop/
    src/main.ts           Electron main: open db, start server, open window
    src/preload.ts
    electron-builder.yml
  tools/parity/           harness, kept after cutover for future refactors against a saved baseline
  docs/
```

`api/`, `compose.yaml`, `compose.override.yaml`, `db/`, `web/Dockerfile`, `web/nginx.conf`, `api/Dockerfile`, and the stray root `pyproject.toml` are deleted in Wave 5.

---

## 5. Fixed decisions (the contract every agent works under)

The orchestrator does not reopen these. An agent that finds one of them unworkable stops and says so in its report.

### 5.1 Libraries

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node 24, ESM, TypeScript strict, same `typescript` major as `web/` | one toolchain |
| HTTP | Hono with `@hono/node-server` and `@hono/zod-openapi` | small, typed routes, OpenAPI from Zod keeps the contract-first flow |
| Validation | Zod 4 (fall back to the Zod major `@hono/zod-openapi` supports if 4 is not yet supported; 0A decides and records it) | one schema is both validator and OpenAPI source |
| Database | better-sqlite3 (synchronous), Drizzle ORM, drizzle-kit migrations | the paved road for Electron plus SQLite; synchronous DB access keeps services simple, like the Python app |
| LLM | `@anthropic-ai/sdk` with structured output parsing; Ollama via `fetch` | mirrors the Python providers |
| Logging | pino | structured, cheap |
| Tests | Vitest, `app.request()` for routes | matches `web/` |
| Lint | oxlint with the same config as `web/` | matches `web/` |
| Desktop | Electron, electron-builder | the paved road |

No other runtime dependencies without the orchestrator's approval. A dependency must replace code we would otherwise write.

### 5.2 Money

- The database stores money as `INTEGER` cents. Drizzle exposes a custom `money` column type that maps to a branded `Cents` type. Nothing outside `lib/money.ts` and the column type converts between cents and strings.
- On the wire money is a string with exactly two decimals and a leading `-` when negative, for example `"-15.49"`. This is what the Python app sends today. Zod schema: `z.string().regex(/^-?\d+\.\d{2}$/)` exported as `Money`.
- Arithmetic is integer arithmetic on cents. Never a floating-point `number` for a money value.
- Division rounds **half to even**, because Python's `Decimal.quantize` does. `money.ts` provides `divHalfEven(cents, n)`, `mulRatioHalfEven(cents, numerator, denominator)`, `median(cents[])` (Python `statistics.median` semantics: the mean of the two middle values, then half-even to cents), and `sum`.
- Percent thresholds such as `0.15` or `0.30` are compared by cross-multiplication on integers, never by multiplying by a float.
- Sums of cents stay well inside `Number.MAX_SAFE_INTEGER`; no BigInt.

### 5.3 Dates and times

- Transaction and planning dates are `PlainDate`, a branded string `YYYY-MM-DD`. The database stores them as `TEXT`. Comparisons are string comparisons, which sort correctly.
- Timestamps are UTC ISO 8601 strings in the database and on the wire. The server writes `new Date().toISOString()`. The frontend already parses with `new Date()`.
- `lib/dates.ts` is the one place "today" comes from: `today()` returns `PLUTUS_TODAY` when that environment variable is set, else the UTC date. Tests and the parity harness set it. This mirrors `services/schedule.today()` in Python.
- `services/schedule.ts` ports `add_months`, `nth_occurrence`, `next_after`, `occurrences`, and the semimonthly logic exactly, with tests.

### 5.4 Database schema

- One `schema.ts` with one Drizzle table per Python model: accounts, balance_snapshots, transactions, categorizations, categories, rules, merchant_classifications, manual_entries, recurrences, goals, suggestions, sync_runs, app_settings, change_dismissals. Column names, table names, uniqueness constraints, indexes, and `ON DELETE` behaviour match the Python models, so the Postgres export in 2D imports without renaming.
- Enums stay `TEXT` columns validated in code, as the Python app stores them as VARCHAR.
- `created_at` and `updated_at` default to `CURRENT_TIMESTAMP` formatted as ISO UTC; Drizzle `$onUpdate` sets `updated_at`.
- Foreign keys are enforced: `PRAGMA foreign_keys = ON` on every connection. `PRAGMA journal_mode = WAL`.
- The Plaid category seed from `api/alembic/versions/0002_seed_categories.py` becomes `server/src/db/migrations/seed/categories.json` and is applied by the migration runner after the schema migration. A test asserts the seed row count equals the count in the Python migration.
- Migrations run at app start, inside the server's `openDb`. There is no separate release step on a desktop.

### 5.5 Errors

- `lib/errors.ts` ports `DomainError`, `NotFoundError`, `ConflictError`, `ProviderError`, and `NotImplementedYetError` with the same status codes and titles.
- One Hono `onError` handler renders every `DomainError` as `application/problem+json` with `type`, `title`, `status`, `detail`, and `instance`, identical to the Python handler. Zod validation failures render as status 422 with the same shape and a `detail` string listing the issues.

### 5.6 Services and routes

- Services are plain functions taking `db` first, then `settings` or `secrets` when needed, exactly like the Python signatures. Services that call a provider are `async`; everything else is synchronous.
- Routes are thin: parse with the Zod schema, call one service function, return the schema's output. Route files never contain business logic. `app.ts` registers every route file and is orchestrator-owned; stubs are pre-registered in 0B so feature briefs never edit it.
- Services never import Hono.
- `services/aggregates.ts` is the single definition of income, expenses, transfers, money movement, essentiality buckets, and recent active months. Every report builds on it. Drizzle's `sql` template is fine for the CASE expressions; the rule is one definition, not one style.

### 5.7 Secrets and config

- `secrets.ts` defines `SecretStore { encrypt(plain: string): string; decrypt(blob: string): string }`. `KeySecretStore` derives an AES-256-GCM key from `PLUTUS_SECRET_KEY` with SHA-256 and is used by the headless server, tests, and the parity harness. The desktop provides `SafeStorageSecretStore` over Electron's `safeStorage`.
- `app_settings` rows keep `is_encrypted`; encrypted values are the store's blob.
- Runtime knobs that lived in `.env` move into `app_settings` with a new contract (brief 0B): LLM provider, model, API key, Ollama URL, owner name tokens, sync interval, first-sync history days, scheduler enabled. Environment variables seed these on first run and the headless server may still override them, but the desktop reads only the table.

### 5.8 Scheduler and background work

- `scheduler.ts` ports `first_run_at` and the interval job with a `setTimeout` chain and jitter. No scheduling library.
- Manual sync: the route creates the run row, responds 202, and starts the run without awaiting it, matching FastAPI's `BackgroundTasks`.

### 5.9 Serving the SPA

- The server serves `web/dist` statically with an `index.html` fallback for unknown non-`/api` paths, mirroring `web/nginx.conf`. The frontend's client uses `location.origin`, so it works unchanged.
- The desktop binds `127.0.0.1` on port 0. The first HTML response sets an `HttpOnly`, `SameSite=Strict` cookie holding a per-launch random token, and every `/api` request must carry it. The frontend already sends `credentials: 'include'`. This stops other local processes from using the API. The headless server has the same guard behind a flag, off by default.

### 5.10 Privacy rules (unchanged, enforced by tests)

- Only `services/scrub.ts` and `services/suggestions.ts` may build LLM input. Never send balances, account names, raw descriptions, notes, or names.
- Rules may match raw descriptions because rules never leave the machine.
- The fake LLM provider records every call so tests can assert exactly what would have been sent. The ported privacy tests from `test_categorize.py` and `test_changes.py` must pass.
- Prompts in `providers/llm/prompts.ts` are byte-identical to the Python prompts. The parity harness compares them.

### 5.11 Testing

- `test/setup.ts` exports `makeDb()` returning a fresh in-memory SQLite database, migrated and seeded. Each test gets its own; no rollback trickery.
- `test/factories.ts` ports `api/tests/factories.py` and `simplefin_helpers.py`.
- Fixtures are copied, not moved, from `api/tests/fixtures` until cutover.
- Route tests use `createApp(...)` with a fake provider and call `app.request('/api/...')`.
- `make check` runs lint, typecheck, and tests for `server/` and `web/`, and for `api/` until Wave 5 removes it. Main stays green at every merge.

### 5.12 Conventions carried over

- Contract first: change `server/src/schemas`, run `make openapi`, then build the frontend against the generated types and MSW mocks.
- Commits end with a `Co-Authored-By` line for the model that wrote them.
- Never real credentials or real bank data anywhere.
- Each brief ends with a report: what was built, files changed, test results, open questions.

### 5.13 Test-driven development (every brief)

- **Tests first, always.** A brief that ports a Python module starts by porting that module's tests. Run them and confirm they fail because the module does not exist or throws. Paste the failing run's summary in the report. Only then port the implementation until the tests pass.
- **Red commit, then green commit.** The ported tests are committed on their own before any implementation: `test(<area>): port <python test file>`. The implementation follows in its own commit: `<area>: port <python module>`. A refactor, if any, is a third commit. The orchestrator checks every branch log for this order and rejects a branch whose implementation commit has no preceding test commit.
- **New code gets a test first too.** Modules with no Python counterpart (`lib/money.ts`, `lib/dates.ts`, `secrets.ts`, the config service, the scheduler timer, the cookie guard, the harness normalizer, the importer) get tests written from this plan's wording before the code. Same red and green commits.
- **No implementation without a failing test it makes pass.** Glue with nothing to assert (a `package.json`, a `tsconfig`, route registration in `app.ts`) is exempt and says so in its commit message.
- **Electron.** The testable parts of the shell (server start options, the cookie guard, the secret store wrapper, path resolution) live in `desktop/src/lib/` and are unit-tested with Vitest. Window and lifecycle code is verified by launching the app, and the report says what was seen.
- **Parity harness.** Its normalizer and differ have unit tests on hand-written response pairs before the harness runs against either app.
- A test that passes before the implementation exists is wrong, not done. Fix the test.

### 5.14 Git: stages, branches, no remote

- `~/dev/plutus-desktop` is created once: `git init`, then every file tracked in `~/dev/Plutus` is copied in (never `.env`, virtualenvs, `node_modules`, or build output), plus the plan files that were still uncommitted there (this document, `.claude/agents/*.md`, the AGENTS.md pointer, `docs/HANDOFF_RULES_AND_BUGS.md`). The first commit is the first stage: `Plutus tree and desktop port plan`.
- **No remote, no push, no PRs** until the owner says the port is ready for review. Review happens on the local repository.
- `main` is the integration branch. Nobody commits to it directly except the orchestrator's merges, root config, schema, and docs commits.
- Each brief is a branch `port/<id>-<area>` in its own worktree. The orchestrator merges with `git merge --no-ff` and a message naming the brief, for example `Merge port/1a-scrub: brief 1A, scrub and merchant keys`. The merge commit is the stage marker for that brief.
- Each wave gate ends with a tag on `main`: `wave-0`, `wave-1`, and so on, placed after `make check` passes. Fable checkpoints review at a tag.
- Commit granularity on a branch: red and green commits per module, as in 5.13. Never one commit per brief; never one commit per wave.
- Messages: `<area>: <what>` in the imperative, with a body naming the Python file ported and anything rewritten. Every commit ends with the `Co-Authored-By` line.
- History on `main` is never rewritten. Worktrees are removed after merge; branches are kept until the wave tag, then deleted.
- The owner's review at the end: `git log --first-parent main` reads as the list of stages; `git log --oneline wave-N..wave-N+1` reads as a wave.

---

## 6. Orchestrator runbook

### 6.1 Setup (once)

Stage 0 is done before the orchestrator session starts, by whoever creates the repository (section 5.14): `git init`, copy the tree and the plan files, first commit.

The orchestrator then, in `~/dev/plutus-desktop`:

1. Confirms the assumption in section 1 with the owner. Records the three decisions in the REQUIREMENTS.md decisions log. Commits: `docs: record desktop decisions`.
2. Creates the root `package.json` with workspaces `web`, `server`, `desktop` and a `check` script. Leaves `web/package-lock.json` in place until 0A moves to a root lockfile. Commits: `build: npm workspaces (no tests: glue)`.
3. Checks that Postgres is reachable on `localhost:5432` for the oracle (`docker compose up -d db` from either checkout) and that `make check` passes in the new repository as it did in `~/dev/Plutus`.
4. Starts brief 0A. While it runs, writes nothing else into `server/`.

### 6.2 Per wave

1. Start every brief in the wave, each in its own worktree, with the brief text from section 6 and the brief id in the branch name. Use the Agent tool with `isolation: "worktree"` or `start_session` per the app's conventions; never share a worktree between two writers.
2. When a report arrives, read the diff, run `make check` in the worktree, and run the brief's "done when" checks yourself. A report is a claim, not proof. Read the branch log: every implementation commit must follow a test commit for the same module (section 5.13), and the report must show the red run.
3. Follow-ups go to the same agent via `SendMessage`, which keeps its context. Do not spawn a fresh agent for a fix to its own work.
4. Merge in dependency order inside the wave with `git merge --no-ff` (section 5.14). After each merge, run `make check` on main.
5. Run the wave gate (section 7), tag `wave-N`, and only then start the next wave.
6. Keep AGENTS.md current as the repo changes shape. By Wave 5 it describes the TypeScript app only; Wave 6 makes a final pass over every doc.

### 6.3 Rules

- The orchestrator writes no feature code. It writes `app.ts` route registration, `schema.ts`, migrations, Zod schemas (through brief 0B, which it reviews line by line), and root config.
- Python code is frozen except the two changes brief 1G names.
- An agent that needs a schema or migration change stops and asks. The orchestrator makes the change, regenerates, and tells the agent to continue.
- At most five agents at once. Review bandwidth is the limit.
- Every merge keeps `web/` typecheck and tests green against the regenerated client.
- Nothing is pushed anywhere. No remote exists until the owner's review.

---

## 7. Wave gates

| After | Gate |
|---|---|
| Wave 0 | Tag `wave-0`. `make check` green with the server package included. OpenAPI contract test passes. Regenerated `schema.d.ts` leaves `web` typecheck and tests green. Fable checkpoint A done. |
| Wave 1 | Every Wave 1 module's ported tests pass. The Electron shell opens the SPA against the stubbed server and shows the health card. The parity harness passes a Python-versus-Python self-check. |
| Wave 2 | Transactions, categories, rules, projection, manual entries, goals, and suggestions routes return real data in tests. Settings config card works against MSW. Postgres export of the demo database imports into SQLite with equal row counts. |
| Wave 3 | `npm run demo` in `server/` loads the fixture through the real pipeline. All ported tests pass. Every route stub is gone. |
| Wave 4 | Parity diff is empty, or every remaining difference is listed with a reason and accepted at Fable checkpoint B. The Electron audit is clean: every page loads with no console errors or failed requests, and every request the pages send is compared by the harness. |
| Wave 5 | No Python, Docker, or Postgres in the repo. CI green on Node only. An unsigned macOS build launches, syncs demo data, and survives a restart with its data. Docs and AGENTS.md describe the new shape. The owner's real data imports and the SimpleFIN connection survives. |
| Wave 6 | Tag `wave-6`. Every doc listed in brief 6A describes the repo as it is at `wave-5`: each command in README.md, AGENTS.md, and the package READMEs was run as written and works; no doc mentions Python, Docker, Postgres, FastAPI, or `api/` except as history (the decisions log, `PLAN.md`, `AGENT_PLAN.md` history notes, `DESKTOP_PLAN.md`, `PORT_BUG_BACKLOG.md`, `HANDOFF_RULES_AND_BUGS.md`); every relative link resolves; the agent role files match the final layout and ownership. `make check` stays green. The owner reviews the finished port after this tag. |

---

## 8. Briefs

Every brief starts with: "Read AGENTS.md and docs/DESKTOP_PLAN.md sections 5 and 6. You own only the files listed. Port the named Python files and their tests exactly; do not improve behaviour. Tests first: port the tests, show them failing, commit them, then implement (section 5.13). Commit per module on your branch, never on main, never push (section 5.14). Run `npm run check` in `server/` (or your package) before reporting. Report what you built, files changed, the red run and the green run, and open questions."

### 0A — Server foundation (server-engineer)

Wave 0. Depends on nothing. Everything else depends on this.

Owns: `package.json` (root workspaces, with the orchestrator), `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`, `server/.oxlintrc.json`, `server/src/app.ts` (initial), `server/src/main.ts`, `server/src/config.ts`, `server/src/db/*`, `server/src/lib/*`, `server/src/secrets.ts`, `server/src/providers/bank/types.ts`, `server/src/providers/llm/types.ts`, `server/src/routes/health.ts`, `server/src/schemas/common.ts`, `server/src/schemas/health.ts`, `server/scripts/export-openapi.ts`, `server/test/setup.ts`, `server/test/factories.ts`, `server/test/fixtures/*`, `Makefile` additions.

Port from: `api/app/models/*.py`, `api/alembic/versions/*.py`, `api/app/config.py`, `api/app/db.py`, `api/app/errors.py`, `api/app/logging.py`, `api/app/routers/health.py`, `api/app/schemas/common.py`, `api/app/providers/bank/base.py`, `api/app/providers/llm/base.py`, `api/app/services/app_settings.py` (encryption half only), `api/tests/conftest.py`, `api/tests/factories.py`, `api/tests/simplefin_helpers.py`, `api/tests/test_health.py`.

Tasks:
1. Scaffold `server/` per section 4.3 and 5.1. Scripts: `dev` (tsx watch), `build` (tsc to `dist/`), `test`, `lint`, `typecheck`, `check`, `openapi`, `demo`. Root `npm run check` runs all workspaces.
2. `db/schema.ts` with all fourteen tables per section 5.4; `drizzle.config.ts`; the initial migration; the category seed extracted from the Python migration; `openDb(path)` that applies pragmas, runs migrations, and seeds.
3. `lib/money.ts`, `lib/dates.ts`, `lib/errors.ts`, `lib/log.ts` per sections 5.2, 5.3, 5.5. Unit tests for money (parse, format, half-even cases including ties, median of even and odd lists) and dates (`add_months` clamping, month bounds).
4. `secrets.ts` with the interface and `KeySecretStore`. Round-trip and wrong-key tests.
5. `config.ts`: data directory, database path, `PLUTUS_SECRET_KEY`, `PLUTUS_TODAY`, env defaults for the knobs in section 5.7, `ENVIRONMENT`.
6. `providers/bank/types.ts` and `providers/llm/types.ts`: the dataclasses as TypeScript types and the two provider interfaces.
7. `app.ts`: `createApp({ db, secrets, config })` returning a Hono app with the error handler, request-id middleware, `/api/health`, and the SPA static handler per section 5.9 (guard flag off). `main.ts` headless entry.
8. `schemas/common.ts` with `Money`, `PlainDate`, `Page<T>` whose OpenAPI component name is `Page_<Name>_` to match FastAPI's naming; `schemas/health.ts` named `HealthRead`.
9. `scripts/export-openapi.ts` writing `web/src/api/openapi.json`; Makefile `openapi` target updated to run it and then `npm run gen:api` in `web/`. Do not run it against the committed spec yet; 0B does.
10. `test/setup.ts`, `test/factories.ts`, fixtures copied, `test_health` ported.
11. Add `check-server` to `make check`.

Done when: `npm run check` passes in `server/`; `make check` passes at the root with the Python and web suites untouched; `npm run dev` serves `web/dist` and `/api/health` on a port; the seed test proves the category count matches the Python migration.

### 0B — API contract (server-engineer, reviewed line by line by the orchestrator)

Wave 0, after 0A merges. Runs alongside Wave 1.

Owns: `server/src/schemas/*` (except common and health), `server/src/routes/*` as 501 stubs, `server/src/app.ts` route registration (hand back to the orchestrator in the report), `server/test/contract.test.ts`.

Port from: every file in `api/app/schemas/`, every router in `api/app/routers/` for paths, methods, status codes, query parameters, and operation ids; `api/tests/test_contract.py`.

Endpoints to stub, all under `/api`:

```
GET    /health
GET    /accounts
POST   /sync                         202
GET    /sync/schedule
GET    /sync/runs?limit
GET    /sync/runs/{run_id}
GET    /settings/simplefin
POST   /settings/simplefin
DELETE /settings/simplefin           204
GET    /settings/llm
GET    /settings/config              new, see below
PUT    /settings/config              new, see below
GET    /transactions                 Page[TransactionRead]; query: q, start, end, account_id[],
                                     category_id[], essentiality, uncategorized, needs_review,
                                     include_transfers, limit (1..500, default 50), offset
PATCH  /transactions/{transaction_id}
GET    /categories
POST   /categories                   201
PATCH  /categories/{category_id}
GET    /rules
DELETE /rules/{rule_id}              204
GET    /reports/changes
POST   /reports/changes/dismiss      204
DELETE /reports/changes/dismissals   204
GET    /reports/monthly?...
GET    /reports/month/{month}
GET    /reports/by-category?...
GET    /reports/balances?...
GET    /projection
GET    /recurring?...
POST   /recurring                    201
PATCH  /recurring/{recurring_id}
GET    /manual-entries
POST   /manual-entries               201
PATCH  /manual-entries/{entry_id}
DELETE /manual-entries/{entry_id}    204
GET    /goals
POST   /goals                        201
GET    /goals/{goal_id}
PATCH  /goals/{goal_id}
GET    /goals/{goal_id}/suggestions
POST   /goals/{goal_id}/suggestions  201, returns list[SuggestionRead]
PATCH  /suggestions/{suggestion_id}
```

`/auth/*` is not ported.

New contract, `schemas/settings.ts`:

```
ConfigRead   { llm_provider: 'claude'|'ollama'|'fake', llm_model: string, anthropic_api_key_set: boolean,
               ollama_base_url: string, owner_name_tokens: string[], sync_interval_hours: int,
               sync_first_history_days: int, scheduler_enabled: boolean }
ConfigUpdate { every field optional; anthropic_api_key?: string | null, null clears it }
```

Tasks:
1. One Zod schema per Pydantic model, same field names, same optionality, same component name via `.openapi('Name')`. Money fields use `Money`. Dates use `PlainDate`. Datetimes are ISO strings. Enums are literal unions with the same values.
2. One route file per Python router, each route wired with `@hono/zod-openapi` and raising `NotImplementedYetError`. Same path parameters, query parameters, status codes, and tags.
3. Register all route files in `app.ts`.
4. `contract.test.ts`: load the committed `web/src/api/openapi.json` (FastAPI's) and the generated one. Assert the set of `METHOD path` pairs is equal apart from `/auth/*` and the two new config routes; assert every component schema name in the old spec exists in the new one; for every response schema, assert required property names match. This is a structural check, not byte equality.
5. Run the export, regenerate `web/src/api/schema.d.ts`, and make `web` typecheck and tests pass. If a frontend test breaks because of a type difference, the schema is wrong, not the test; fix the schema. Exception: differences the plan introduces on purpose. List each in the report.
6. Replace `test_contract.py`'s staleness check with the same check in Vitest: the committed `openapi.json` equals the generated one.

Done when: the contract test passes; `web` is green against the regenerated client; every route answers 501 problem+json; the orchestrator has reviewed every schema file.

### 1A — Scrub and merchant keys (server-engineer)

Wave 1. Depends on 0A.

Owns: `server/src/services/scrub.ts`, `server/test/scrub.test.ts`.

Port from: `api/app/services/scrub.py`, `api/tests/test_scrub.py`, `api/tests/fixtures/scrub_golden.json`.

Tasks: port every regex and the ordering of passes exactly; port `merchant_key`, `amount_bucket`, `build_merchant_input`, and the constants; the golden test runs every fixture case and the two invariants (no digit run over three characters, no owner token). Python `re` and JavaScript `RegExp` differ on `\b` with Unicode and on inline flags; note any construct you had to rewrite and prove it with a test case.

Done when: the golden test and all ported scrub tests pass.

### 1B — Schedule and recurring detection (server-engineer)

Wave 1. Depends on 0A. Part 2 depends on 0B.

Owns: `server/src/services/schedule.ts`, `server/src/services/recurring.ts`, `server/src/routes/recurring.ts` (part 2), `server/test/schedule.test.ts`, `server/test/recurring.test.ts`.

Port from: `api/app/services/schedule.py`, `api/app/services/recurring.py`, `api/app/routers/recurring.py`, `api/tests/test_recurring.py`.

Tasks: port the date helpers including the semimonthly pairing and month-end clamping; port detection with the gap bands, the 75% fit rule, dominant direction, amount tolerance by cross-multiplication, median by `money.median`; port `annual_cost`, `update_recurring`, `create_recurring`, and the cadence-change handling as the Python does it today, bugs included (the backlog fixes come after cutover). Part 2: replace the recurring route stubs.

Done when: all ported tests pass; the route tests pass.

### 1C — Aggregates, reports, accounts (server-engineer)

Wave 1. Depends on 0A. Part 2 depends on 0B.

Owns: `server/src/services/aggregates.ts`, `server/src/services/reports.ts`, `server/src/services/accounts.ts`, `server/src/routes/reports.ts` and `routes/accounts.ts` (part 2), tests `aggregates.test.ts`, `reports.test.ts`, `month_detail.test.ts`.

Port from: `api/app/services/aggregates.py`, `api/app/services/reports.py`, `api/app/routers/reports.py`, `api/app/routers/accounts.py`, `api/tests/test_aggregates.py`, `api/tests/test_reports.py`, `api/tests/test_month_detail.py`.

Tasks: port the definitions in the module docstring verbatim as the file header; `INCOME_PRIMARIES` and `MONEY_MOVEMENT` unchanged; `to_char(..., 'YYYY-MM')` becomes `substr(posted_on, 1, 7)`; `extract('day')` becomes `cast(substr(posted_on, 9, 2) as integer)`; `DISTINCT ON (account_id) ... ORDER BY as_of DESC, id DESC` becomes a window function `row_number() over (partition by account_id order by as_of desc, id desc) = 1`; every quantize becomes half-even; `recent_active_months` and `monthly_totals` with `through_day` ported exactly. Part 2: replace the reports and accounts stubs.

Done when: all ported tests pass; the routes return real data in tests.

### 1D — Providers (server-engineer)

Wave 1. Depends on 0A.

Owns: `server/src/providers/bank/simplefin.ts`, `server/src/providers/llm/prompts.ts`, `claude.ts`, `ollama.ts`, `fake.ts`, `index.ts`, tests `simplefin.test.ts`, `llm_providers.test.ts`, `prompts.test.ts`.

Port from: `api/app/providers/bank/simplefin.py`, `api/app/providers/llm/*.py`, `api/tests/test_simplefin.py`, `api/tests/test_llm_providers.py`.

Tasks: SimpleFIN with 45-day chunking, request counting, no retries, setup-token claim, account-type inference, the pending transaction rule, and the access URL never logged; inject `fetch` so tests can stub it. Claude via `@anthropic-ai/sdk` with the system block carrying the cache breakpoint and a Zod output format; map every SDK error class to `ProviderError` with the same messages; handle `refusal`, `max_tokens`, and empty parsed output. Ollama over `fetch` with the JSON-schema `format` field and temperature 0. Fake provider with the same keyword table and call recording. `prompts.test.ts` loads the Python prompt text (read `api/app/providers/llm/prompts.py` at test time, or snapshot it into a fixture at port time; the parity harness checks the live text) and asserts byte equality.

Done when: all ported tests pass; the prompt equality test passes.

### 1E — App settings, secrets, config endpoints (server-engineer)

Wave 1. Depends on 0A. Part 2 depends on 0B and 1D.

Owns: `server/src/services/app_settings.ts`, `server/src/services/config.ts`, `server/src/routes/settings.ts` (part 2), tests.

Port from: `api/app/services/app_settings.py`, `api/app/routers/settings.py`, settings parts of `api/app/schemas/sync.py`.

Tasks: `get_setting`, `set_setting`, `delete_setting` over the `SecretStore`; a `config` service that reads the section 5.7 knobs from `app_settings` with env defaults seeded on first run, and exposes a typed `RuntimeConfig` the rest of the server uses instead of reading env; `GET/PUT /settings/config` and the existing `simplefin` and `llm` routes. The API key is write-only: never returned.

Done when: tests pass; the LLM factory from 1D takes its settings from this config service (coordinate through the orchestrator for the final wiring).

### 1F — Electron shell (desktop-engineer)

Wave 1. Depends on 0A.

Owns: `desktop/` entirely.

Tasks:
1. `desktop/package.json`, `tsconfig.json`, Electron main and preload, `electron-builder.yml`.
2. Main: `app.whenReady` → `SafeStorageSecretStore` → `openDb(path.join(app.getPath('userData'), 'plutus.sqlite'))` → `createApp(...)` → listen on `127.0.0.1:0` → `BrowserWindow.loadURL`. Serve `web/dist` from the packaged app path. Per-launch cookie guard per section 5.9.
3. Single-instance lock; graceful shutdown stops the scheduler and closes the database; `window.open` and navigation outside the loopback origin open in the system browser.
4. `npm run dev` in `desktop/` builds `web`, runs the server in-process, and opens the window. `npm run dist` produces an unsigned build.
5. better-sqlite3 rebuilt for Electron's Node ABI through electron-builder's `npmRebuild`; `asarUnpack` for the native module.
6. Document in `desktop/README.md` how to run and what signing needs.

Done when: `npm run dev` opens the window showing the SPA with the health card green against the stubbed server; `npm run dist` yields a launchable unsigned macOS app.

### 1G — Parity harness (parity-engineer)

Wave 1. Depends on 0A.

Owns: `tools/parity/*`, `api/app/services/schedule.py` (only: `today()` honours `PLUTUS_TODAY` when set), `api/app/config.py` not touched.

Tasks:
1. `tools/parity/run.ts`: starts the Python API against a throwaway Postgres database (`plutus_parity`, created like `plutus_test`) with `LLM_PROVIDER=fake`, `OWNER_NAME_TOKENS=["ALEX","SAMPLE"]`, `PLUTUS_TODAY=<fixed>`, and the TypeScript server against a temp SQLite file with the same settings. Loads the demo fixture into both (`python -m app.demo load` and `npm run demo -- load`). Calls every `GET` endpoint with a list of representative query strings, then runs a scripted write sequence (recategorize with save-as-rule, add a note, mark one-time, confirm a recurrence, create a manual entry, create a goal, generate suggestions, dismiss a change) on both, re-reads the affected `GET`s after each write, and diffs.
2. Normalization: parse and compare timestamps as instants rounded to the second; ignore `id` ordering differences only where the Python response is unordered (document each); money compared as strings.
3. Output: a markdown report of differences grouped by endpoint, written to `tools/parity/report.md` (gitignored), and a non-zero exit when any remain.
4. Prompt check: compare the Python prompt strings with the TypeScript ones.
5. Self-check mode: run Python against Python to validate normalization; it must report zero differences.

Done when: self-check passes; the harness runs end to end against the stubbed TypeScript server and reports every endpoint as differing (that is the expected Wave 1 result).

### 2A — Transfers, categorization, rules, transactions (server-engineer)

Wave 2. Depends on 1A, 1C, 1D, 1E.

Owns: `server/src/services/transfers.ts`, `categorize.ts`, `categories.ts`, `transactions.ts`, `server/src/routes/categories.ts`, `routes/transactions.ts`, tests `transfers.test.ts`, `categorize.test.ts`, `category_routes.test.ts`, `transaction_routes.test.ts`.

Port from: the same-named Python services and routers, `api/tests/test_transfers.py`, `test_categorize.py`, `test_category_routes.py`, `test_transaction_routes.py`.

Tasks: port `match_transfers` with the five-day window as it is today; port the pipeline order (transfers, rules exact/contains/prefix, cache, LLM in batches of 50, fallback category, failing LLM leaves rows uncategorized and never throws); port `_save_rule`, `_override_category`, `apply_rule`, `delete_rule` as they are, bugs included; port the transaction list filters, pagination, and `PATCH` fields including `note` and `one_time`; port the three privacy tests. Categories list and create and patch routes.

Done when: all ported tests pass, including `test_privacy_nothing_sensitive_reaches_the_provider` and `test_notes_never_reach_the_llm`.

### 2B — Projection, manual entries, goals, suggestions (server-engineer)

Wave 2. Depends on 1B, 1C, 1D.

Owns: `server/src/services/projection.ts`, `manual_entries.ts`, `goals.ts`, `suggestions.ts`, routes `projection.ts`, `manual_entries.ts`, `goals.ts`, tests.

Port from: the same-named Python services and routers, `api/tests/test_projection.py`, `test_manual_entries.py`, `test_goals.py`, `test_suggestions.py`.

Tasks: port the projection formula with the one-time exclusion, trailing averages with half-even division, assumption strings verbatim; manual entries with recurrence expansion through `schedule.occurrences`; goals with on-track math; suggestions building `SavingsContext` from aggregates only (the only other file allowed to build LLM input), dismissed suggestions excluded from re-proposal.

Done when: all ported tests pass.

### 2D — Postgres export and SQLite import (parity-engineer)

Wave 2. Depends on 0A.

Owns: `api/app/export_json.py`, `server/scripts/import-json.ts`, `tools/parity/import.test.ts`, `docs/MIGRATING_DATA.md`.

Tasks: a Python script that dumps every table to one JSON file, decrypting Fernet values with the current `SECRET_KEY` so the SimpleFIN access URL travels in the clear inside the file (the file is sensitive; the doc says to delete it after import); a TypeScript importer that inserts rows in foreign-key order, converts money to cents, re-encrypts secrets with the new store, and verifies row counts per table. Tested on the demo database only.

Done when: export of a demo-loaded Postgres and import into a fresh SQLite yield equal row counts for every table and an equal `/api/reports/monthly` response.

### 2E — Settings config card (frontend-engineer)

Wave 2. Depends on 0B (regenerated client).

Owns: `web/src/features/settings/ConfigCard.tsx` and its test, `web/src/mocks/settings.ts`, `web/src/pages/Settings.tsx` (adding the card only).

Tasks: a card on Settings for the `ConfigRead` fields: provider select, model, API key input that shows only "set" or "not set" and accepts a new value, Ollama URL, owner name tokens as chips, sync interval, first-sync history, scheduler toggle. Save with `PUT /api/settings/config`, invalidate the `settings` queries. MSW handlers. Keep one primary action on the page; if Settings gets crowded, say so.

Done when: `web` typecheck, lint, and tests pass with the new card covered.

### 3A — Sync, scheduler, demo loader (server-engineer)

Wave 3. Depends on 2A, 1B, 1D, 1E, and 3B's `prune` function signature (the orchestrator provides a stub if 3B is not merged yet).

Owns: `server/src/services/sync.ts`, `server/src/scheduler.ts`, `server/src/routes/sync.ts`, `server/scripts/demo.ts`, tests `sync.test.ts`, `sync_routes.test.ts`, `scheduler.test.ts`.

Port from: `api/app/services/sync.py`, `api/app/scheduler.py`, `api/app/routers/sync.py`, `api/app/demo.py`, `api/tests/test_sync.py`, `test_sync_routes.py`, `test_scheduler.py`.

Tasks: run bookkeeping, stale-run recovery, the daily request budget guard summing `requests`, five-day overlap, first-sync history, upsert of accounts and transactions, pending-to-posted updates, then transfers, categorization, recurring detection, and the changes prune, in that order; manual sync responding 202 and running detached; `first_run_at` and the timer with jitter; `nextRunAt()` for the schedule route; `demo load` and `demo clear` with provider name `demo`.

Done when: all ported tests pass; `npm run demo -- load` on a fresh database reports the same added count as `make demo-data` does on Postgres.

### 3B — What changed (server-engineer)

Wave 3. Depends on 1B, 1C, 2A, 2B.

Owns: `server/src/services/changes.ts`, `server/src/routes/changes.ts`, `server/test/changes.test.ts`.

Port from: `api/app/services/changes.py`, `api/app/routers/changes.py`, `api/tests/test_changes.py`, `docs/PRD_WHAT_CHANGED.md`.

Tasks: port every signal with its thresholds as module constants, the ordering, the seven-item cap, dismissal keys and retention, `money()` and `short_date()` formatting exactly (note the Unicode minus sign), the `href` builders, and `test_never_calls_an_llm`.

Done when: all ported tests pass.

### 4A — Parity run and fix list (parity-engineer, then owning agents)

Wave 4. Depends on everything above.

Tasks: run the harness; for each difference, classify it as port bug, Python bug, or accepted (timestamps, ordering); write the fix list grouped by owning brief. The orchestrator sends each group to the agent that owns the module via `SendMessage`. Re-run until the diff is empty or every remaining line is accepted. Then audit the Electron app with demo data: visit every page (and one deep link), record each request it sends, console errors, and failed or blocked requests, and take one screenshot per page for a sanity glance. Every request the pages send must match a harness case; add cases for any that don't. The frontend is the same code in both apps, so this checks the desktop shell and harness coverage rather than comparing screenshots of the two apps. Fable checkpoint B reads the final report.

Done when: the harness exits zero or the accepted list is approved; the Electron audit is clean.

### 5A — Cutover (server-engineer)

Wave 5. Depends on checkpoint B approval.

Owns: deletions and docs listed below, `Makefile`, `.github/workflows/ci.yml`, `.env.example`, `AGENTS.md`, `README.md`, `docs/ARCHITECTURE.md`, `docs/REQUIREMENTS.md` decisions log, `docs/AGENT_PLAN.md`, `.claude/agents/backend-engineer.md`.

Tasks: delete `api/`, `compose.yaml`, `compose.override.yaml`, `db/`, `web/Dockerfile`, `web/nginx.conf`, root `pyproject.toml`, and the Python bits of the Makefile; move fixtures to `server/test/fixtures` for good; CI runs `npm ci` and `npm run check` and builds the desktop app unsigned on macOS; rewrite README setup for the desktop app with the data migration steps from `docs/MIGRATING_DATA.md`; rewrite the architecture doc's overview, layout, and conventions tables for the TypeScript server; update AGENTS.md so every line is true (brief 6A makes the final documentation pass after Wave 5); delete `backend-engineer.md` and fold its rules into `server-engineer.md`; keep `tools/parity/` with a saved baseline of the final Python responses so future refactors can diff against it.

Done when: `make check` is green with no Python or Docker anywhere; the docs describe only what exists.

### 5B — Packaging and signing (desktop-engineer)

Wave 5. Depends on 5A.

Owns: `desktop/`.

Tasks: electron-builder targets for macOS (dmg and zip, arm64 and x64), Windows (nsis), Linux (AppImage); code signing and notarization wired to environment variables and documented, with unsigned builds still working when they are absent; app icon; first-launch experience: empty database, Settings opens first when SimpleFIN is not connected; data directory and log file locations documented; a `--data-dir` flag for a second profile.

Done when: a signed or unsigned macOS build installs, launches, imports the owner's export, syncs, and keeps its data across restarts.

### 5C — Frontend cleanup (frontend-engineer)

Wave 5. Depends on 5A.

Owns: `web/`.

Tasks: remove anything that only made sense in a browser deployment: the Vite proxy to `api`, `allowedHosts`, mock-mode docs that mention Docker; make the build output path the one `server` and `desktop` serve; keep `npm run dev:mock` working.

Done when: `web` is green and `desktop` dev and dist both serve the built app.

### 6A — Documentation pass (docs-writer)

Wave 6. Depends on 5A, 5B, and 5C, all merged and tagged `wave-5`.

Owns: `README.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/agents/*.md`, `docs/ARCHITECTURE.md`, `docs/REQUIREMENTS.md` (requirements text and the decisions log), `docs/AGENT_PLAN.md`, `docs/MIGRATING_DATA.md`, `docs/PRD_WHAT_CHANGED.md` (implementation references only), `desktop/README.md`, `tools/parity/README.md`, `server/test/fixtures/README.md`, and any other README in the repo. Code is out of scope: a doc that cannot be made true without a code change is reported, not fixed.

Tasks:
1. Read every doc above against the repo at `wave-5` and rewrite what is no longer true: setup, commands, layout, ownership, conventions, gotchas, testing, privacy rules, and the data migration steps. Keep each doc's purpose; cut lines that stopped being true rather than adding history.
2. README.md: what Plutus is, how to install and run the desktop app, how to run the headless server, how to migrate data from the old Docker app (pointing at `docs/MIGRATING_DATA.md`), and the development commands.
3. AGENTS.md and CLAUDE.md: the TypeScript server, the Electron shell, the web app, the parity harness, the commands that exist, the conventions that hold, and the gotchas that still cost time. Remove every Python, Docker, and Postgres line, and the "desktop port in progress" paragraph. Keep the pointer to `docs/PORT_BUG_BACKLOG.md` and its ask-the-owner-first rule.
4. `.claude/agents/*.md`: each role file matches the final layout and file ownership; `backend-engineer.md` is gone (5A); no role mentions Python, `api/`, Alembic, or pytest. Update `docs/AGENT_PLAN.md` to the same roles.
5. `docs/ARCHITECTURE.md` and `docs/REQUIREMENTS.md`: the architecture describes the desktop app and the headless server as built; requirements whose wording assumed Docker, Postgres, or FastAPI are reworded to the same intent. Add a decisions-log entry dated the day of the pass if the pass changes a requirement's wording.
6. Run every command the docs tell a reader to run, in a fresh worktree from `wave-5` (`npm ci`, `make check`, `npm run dev` and `npm run smoke` in `desktop/`, the headless server, the import steps against the demo data), and fix the docs where a command is wrong. Check every relative link.
7. Docs with nothing to assert: commit as `docs: <what> (no tests: docs)`, one commit per document or tightly related group.

Done when: the Wave 6 gate holds; the report lists every doc changed, every command run with its result, and any doc that could not be made true without a code change.

---

## 9. After cutover

- Bring `docs/PORT_BUG_BACKLOG.md` (Python bugs found during the port, ported as they are) to the owner and fix only what the owner approves. Never start these fixes unasked.
- Implement `docs/HANDOFF_RULES_AND_BUGS.md` in TypeScript: the rule builder, the stale-cache fix, the transfer false-positive fix, the cadence-change fix.
- Auto-update through electron-updater once builds are signed.
- A headless install guide for a VPS, since the server still runs without Electron.
- Delete `tools/parity/` once the first post-cutover refactor has used the baseline and nobody needs it anymore.

---

## 10. Risks and gotchas

- **Rounding.** Python's Decimal rounds half to even. Any division in the port that uses `Math.round` will drift on ties. Every average goes through `money.ts`.
- **Regex dialects.** Python `re` and JavaScript differ on `\b` near non-ASCII, on `(?i)` inline flags, and on possessive constructs. The scrub golden test is the safety net; add cases for anything rewritten.
- **SQLite has no `DISTINCT ON`, `to_char`, or `extract`.** Section 5.4 and brief 1C give the replacements. Dates as `YYYY-MM-DD` text make the month and day substrings exact.
- **SQLite integer affinity.** A money column declared `INTEGER` stores what it is given; the custom column type must refuse non-integers so a float never sneaks in.
- **better-sqlite3 is synchronous.** No `await` while a transaction is open. Provider calls happen outside transactions, as the Python app commits per step.
- **Electron and native modules.** better-sqlite3 must be rebuilt for Electron's ABI; `npmRebuild` and `asarUnpack` handle it, but the first `npm run dist` on a new machine is slow.
- **Timestamps.** Python emits microseconds, JavaScript milliseconds. The harness compares instants, the frontend parses with `Date`, nothing compares strings.
- **Port and cookie.** The loopback port changes each launch; the cookie is set per launch. A stale tab from a previous launch gets 401 and should reload.
- **Scheduler only runs while the app is open.** `first_run_at` runs an overdue sync about two minutes after launch, which is the designed behaviour.
- **The Python app is frozen.** The only Python edits during the port are the `PLUTUS_TODAY` hook and the export script. Anything else breaks parity.
