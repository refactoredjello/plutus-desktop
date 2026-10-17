# Plutus — Multi-Agent Build Plan

How to build the app described in REQUIREMENTS.md, ARCHITECTURE.md, and PLAN.md with one orchestrating Opus 5.5 session managing a small set of Sonnet 5.5 subagents in Claude Code.

## Shape: hub and spoke

```
                    ┌──────────────────────────────┐
                    │  Orchestrator (main session) │
                    │  plans, owns contracts,      │
                    │  reviews, merges             │
                    └──────┬─────────┬─────────┬───┘
            brief + branch │         │         │  report back
                 ┌─────────▼──┐ ┌────▼──────┐ ┌▼────────────┐
                 │ backend-   │ │ backend-  │ │ frontend-   │
                 │ engineer   │ │ engineer  │ │ engineer    │
                 │ (worktree) │ │ (worktree)│ │ (worktree)  │
                 └────────────┘ └───────────┘ └─────────────┘
```

- **The orchestrator never writes feature code.** It writes briefs, owns shared contracts, reviews diffs, runs the full test suite, and merges.
- **Subagents never talk to each other.** All coordination goes through the orchestrator. Contracts are fixed before parallel work starts, so peers have nothing to negotiate.
- **Each subagent works in its own git worktree** (Agent tool with `isolation: "worktree"`), so parallel agents cannot overwrite each other's files.
- **At most three subagents run at once.** Review bandwidth, not agent capacity, is the bottleneck. Each agent also starts cold and re-reads the project.
- **Follow-ups reuse the same agent** via SendMessage, which keeps its context, instead of spawning a fresh one.

## Prerequisite: where the code lives

The planning docs live in Google Drive. The code repository should not.

Git internals, tens of thousands of `node_modules` files, and Docker bind mounts all behave badly on a cloud-synced File Provider folder. Expect slow syncs, conflicted copies, and possible `.git` corruption, which is worse with several agents writing to worktrees at once.

Recommended setup:
- Create the repo at `~/dev/Plutus` with a private GitHub remote for backup.
- Copy these docs into the repo's `docs/` at Wave 0. From then on the repo copy is the source of truth.
- Run the orchestrator session from the repo folder.

## Agent roster

Two custom agent types, defined in the repo under `.claude/agents/`. Review uses the built-in `/code-review` skill rather than a custom reviewer agent.

`.claude/agents/backend-engineer.md`
```markdown
---
name: backend-engineer
description: Implements FastAPI services, SQLAlchemy models, provider adapters, and their tests for Plutus. Use for any work under api/.
model: sonnet
tools: Read, Edit, Write, Bash, Grep, Glob
---
You implement one brief at a time in the api/ package.

Before starting, read AGENTS.md and the requirement IDs named in your brief.
- Touch only the files your brief says you own. If you need a change elsewhere,
  including a new migration or a schema change, stop and ask in your report.
- Never edit alembic/versions/, app/main.py, or app/models/. The orchestrator owns them.
- Replace `raise NotImplementedYetError` stubs in your routers; keep their signatures.
- Use FakeLLMProvider and the SimpleFIN fixture. Never use real credentials.
- Run `uv run ruff check .`, `uv run mypy app`, and `uv run pytest` in api/ before reporting. All must pass.
- Report: what you built, files changed, test results, open questions.
```

`.claude/agents/frontend-engineer.md`
```markdown
---
name: frontend-engineer
description: Implements React pages and components for Plutus against the generated API client. Use for any work under web/.
model: sonnet
tools: Read, Edit, Write, Bash, Grep, Glob
---
You implement one brief at a time in the web/ package.

Before starting, read AGENTS.md and the requirement IDs named in your brief.
- Use the generated API client in src/api/client.ts and MSW mocks. Never hand-write fetch calls.
- Never edit src/api/openapi.json or src/api/schema.d.ts. They are generated from the backend.
- Use shadcn/ui components and Recharts. Load the dataviz skill before any chart.
- One primary action per page. If a page gets crowded, say so in your report.
- Run `npm run typecheck`, `npm run lint`, and `npm test` in web/ before reporting. All must pass.
- Report: what you built, files changed, screenshots if possible, open questions.
```

`AGENTS.md` at the repo root carries the principles, setup, and conventions into every agent (`CLAUDE.md` imports it for Claude Code). It began as this `CLAUDE.md`:
```markdown
# Plutus

Plutus is a single-user personal finance app.

Principles, in priority order:
1. Simple UI and simple implementations are always preferred.
2. Don't reinvent the wheel. Use established libraries, taxonomies, and processes.
3. A clean interface is paramount.

Source of truth: docs/REQUIREMENTS.md, docs/ARCHITECTURE.md, docs/PLAN.md.
Privacy invariant: nothing reaches an LLM except output of services/scrub.py
or services/suggestions.py. Both have tests that enforce this.
Commands: `make up`, `make check`, `make openapi` (after any schema change). Run `make help` for the rest.
```

## Build waves

Parallel work is only safe once the shared contracts exist. Wave 0 builds them serially, then later waves fan out.

### Wave 0: contracts (orchestrator, serial) — built 2026-10-03, awaiting your review

The orchestrator does this itself or with one agent, then reviews it with you before anything runs in parallel.

- Phase 0 scaffold: compose, FastAPI health, Vite app, lint and test tooling, CI.
- **The entire data model as one initial Alembic migration.** ARCHITECTURE.md already specifies every table, so doing it up front removes the main source of parallel merge conflicts.
- **Every router stubbed with its Pydantic request and response schemas**, returning 501. This produces the full OpenAPI spec.
- Generated TypeScript client from that spec, plus MSW set up so pages can be built against mocks. Each frontend brief adds the mock handlers its pages need.
- Test fixtures: a recorded-style SimpleFIN JSON file with fake data, a FakeLLMProvider, a golden file of messy bank descriptions.
- CLAUDE.md and the two agent definitions above.

**Checkpoint with you:** review the schema and API shape. Changing them later is the expensive kind of change.

### Wave 1: data in (three agents in parallel) — merged 2026-10-03

| Agent | Brief | Requirements | Owns |
|---|---|---|---|
| backend-engineer A | SimpleFIN provider, sync service, scheduler, setup-token exchange, encrypted settings | R1 | `providers/bank/`, `services/sync.py`, `scheduler.py`, sync and settings routers |
| backend-engineer B | Taxonomy seed, scrub and normalize, LLM providers, categorization pipeline, rules, transfer detection | R2, R3 | `providers/llm/`, `services/scrub.py`, `services/categorize.py`, `services/transfers.py`, transactions and categories routers |
| frontend-engineer C | App shell and navigation, Settings page, Transactions page with inline edits | R1.3, R2 UI | `web/src/pages/Settings*`, `web/src/pages/Transactions*`, layout |

**Checkpoint with you:** paste your real SimpleFIN token into your local `.env` and run a real sync. Agents never see the real token.

### Wave 2: insight (three agents in parallel) — merged 2026-10-03

| Agent | Brief | Requirements | Owns |
|---|---|---|---|
| backend-engineer A (resumed) | Reports, recurring detection, projection | R4, R6, R7 | `services/recurring.py`, `services/projection.py`, reports, recurring and projection routers |
| backend-engineer B (resumed) | Manual entries, goals, savings suggestions | R5, R8 | `services/suggestions.py`, manual-entries, goals and suggestions routers |
| frontend-engineer C (resumed) | Overview charts, Recurring, Manual entries, Goals pages; a rules list with delete in Settings | R4 to R8 UI, R2.3 | remaining `web/src/pages/*`, `src/features/settings/RulesCard.tsx` |

Resuming the Wave 1 agents with SendMessage keeps what they learned about the codebase.

**Checkpoint with you:** a full click-through of the app on your real data. This is the moment to cut or reshape UI.

### Wave 3: harden and ship (orchestrator plus one agent, serial)

- Auth: password login, session cookie, route protection, login page (R9).
- Production compose profile, Caddy, JSON logs, backup script, deploy README.
- An end-to-end test from sync through categorization to the Overview numbers.

## Running the orchestrator

Open the orchestrator session in the repo folder itself. Claude Code registers the custom agent types from `.claude/agents/` only for sessions started in that project. Wave 1 was launched from a session started elsewhere, so it used general-purpose agents pinned to Sonnet, each told to read its definition file first. The effect is the same, but the native types are cleaner.

Each agent gets its own worktree under `~/dev/Plutus-worktrees/` and, for backend agents, its own test database, so parallel test runs never touch each other's data.

## The orchestrator's loop for every brief

1. Write the brief: requirement IDs, files owned, done-when check, and what not to touch.
2. Spawn the agent in the background in a worktree.
3. When it reports, read the diff and run `/code-review` on the branch.
4. Send fixes back to the same agent via SendMessage until clean.
5. Rebase onto main, run the full suite, merge, regenerate the API client if schemas changed.
6. Log anything that changed a requirement in the decisions table.

## Rules that keep parallel work safe

- **Schema and migration changes go through the orchestrator only.** An agent that needs one asks in its report.
- **File ownership is explicit in every brief.** Two agents never own the same file in the same wave.
- **Shared registration points are pre-written in Wave 0**, such as router includes in `main.py` and routes in the React router.
- **No real secrets in any agent's environment.** Fixtures and fake providers only. You add real keys to your own `.env`.
- **Merges happen one at a time**, each followed by a green full suite.

## What you do

You are needed at four checkpoints: after Wave 0 for the contract review, after Wave 1 for the real sync, after Wave 2 for the click-through, and after Wave 3 for deployment. Between checkpoints the orchestrator runs on its own.

## Rough cost and time

Each wave is three agent-days of the single-developer estimate compressed into roughly one working session, plus review. Expect four to five sessions total. Subagents run on Sonnet 5.5 to keep cost down, while the orchestrator stays on Opus 5.5 for planning and review. If a subagent struggles with a hard brief, such as the categorization pipeline, the orchestrator can override that one spawn to Opus.
