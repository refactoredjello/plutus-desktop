# Plutus — Multi-Agent Build Plan

How Plutus is built with one orchestrating Opus session managing a small set of subagents in Claude Code. The desktop port (Waves 0 to 6 of docs/DESKTOP_PLAN.md) runs on this model; the original build is kept below as history.

## Shape: hub and spoke

```
                    ┌──────────────────────────────┐
                    │  Orchestrator (main session) │
                    │  plans, owns contracts,      │
                    │  reviews, merges             │
                    └──────┬─────────┬─────────┬───┘
            brief + branch │         │         │  report back
                 ┌─────────▼──┐ ┌────▼──────┐ ┌▼────────────┐
                 │ server-    │ │ desktop-  │ │ frontend-   │
                 │ engineer   │ │ engineer  │ │ engineer    │
                 │ (worktree) │ │ (worktree)│ │ (worktree)  │
                 └────────────┘ └───────────┘ └─────────────┘
```

- **The orchestrator never writes feature code.** It writes briefs, owns shared contracts (`server/src/db/schema.ts`, migrations, Zod schemas, `server/src/app.ts`, root config), reviews diffs, runs the full suite, and merges.
- **Subagents never talk to each other.** All coordination goes through the orchestrator. Contracts are fixed before parallel work starts, so peers have nothing to negotiate.
- **Each subagent works in its own git worktree and branch** (Agent tool with `isolation: "worktree"`), so parallel agents cannot overwrite each other's files.
- **At most five subagents run at once.** Review bandwidth, not agent capacity, is the bottleneck. Each agent also starts cold and re-reads the project.
- **Follow-ups reuse the same agent** via SendMessage, which keeps its context, instead of spawning a fresh one.

## Where the code lives

The repository is `~/dev/plutus-desktop`, a local git repository with no remote until the owner asks for one. Keep it out of cloud-synced folders: git internals and `node_modules` behave badly there, worse with several agents writing to worktrees at once. Worktrees live under `.claude/worktrees/`.

## Agent roster

Role definitions live in `.claude/agents/`. Review uses the built-in `/code-review` skill rather than a custom reviewer agent.

| Role | Works in | Use for |
|---|---|---|
| `server-engineer` | `server/` | services, routes, providers, scripts, and their Vitest tests |
| `frontend-engineer` | `web/` | pages and components against the generated client and MSW |
| `desktop-engineer` | `desktop/` | the Electron shell and packaging |
| `docs-writer` | docs and READMEs | making every doc describe the repository as it is |
| `parity-engineer` | (retired) | the port's parity harness and data export; the harness was deleted at the cutover (brief 5A) |

`AGENTS.md` at the repository root carries the principles, setup, and conventions into every agent (`CLAUDE.md` imports it for Claude Code).

## The orchestrator's loop for every brief

1. Write the brief: requirement IDs, files owned, done-when check, and what not to touch.
2. Spawn the agent in the background in a worktree.
3. When it reports, read the diff, check the branch log (a failing-test commit before each implementation commit), and run `/code-review` on the branch.
4. Send fixes back to the same agent via SendMessage until clean.
5. Merge with `git merge --no-ff`, run `make check`, regenerate the API client if schemas changed (`make openapi`).
6. Log anything that changed a requirement in the decisions table in REQUIREMENTS.md.

## Rules that keep parallel work safe

- **Schema and migration changes go through the orchestrator only.** An agent that needs one asks in its report.
- **File ownership is explicit in every brief.** Two agents never own the same file in the same wave.
- **Shared registration points are pre-written**, such as route registration in `server/src/app.ts` and routes in the React router.
- **No real secrets in any agent's environment.** Fixtures and fake providers only. The owner adds real keys in the app's Settings.
- **Merges happen one at a time**, each followed by a green `make check`.
- **Bugs on docs/PORT_BUG_BACKLOG.md are fixed only with the owner's go-ahead.**

## History: the original build (2026-10-03)

The first version was a Python (FastAPI, Postgres, Docker Compose) app built by `backend-engineer` and `frontend-engineer` subagents in `~/dev/Plutus`. Its waves are kept for the record; the code they describe left this repository at the desktop cutover (tag `wave-4`, brief 5A).

### Build waves

Parallel work is only safe once the shared contracts exist. Wave 0 builds them serially, then later waves fan out.

#### Wave 0: contracts (orchestrator, serial) — built 2026-10-03, awaiting your review

The orchestrator does this itself or with one agent, then reviews it with you before anything runs in parallel.

- Phase 0 scaffold: compose, FastAPI health, Vite app, lint and test tooling, CI.
- **The entire data model as one initial Alembic migration.** ARCHITECTURE.md already specifies every table, so doing it up front removes the main source of parallel merge conflicts.
- **Every router stubbed with its Pydantic request and response schemas**, returning 501. This produces the full OpenAPI spec.
- Generated TypeScript client from that spec, plus MSW set up so pages can be built against mocks. Each frontend brief adds the mock handlers its pages need.
- Test fixtures: a recorded-style SimpleFIN JSON file with fake data, a FakeLLMProvider, a golden file of messy bank descriptions.
- CLAUDE.md and the two agent definitions above.

**Checkpoint with you:** review the schema and API shape. Changing them later is the expensive kind of change.

#### Wave 1: data in (three agents in parallel) — merged 2026-10-03

| Agent | Brief | Requirements | Owns |
|---|---|---|---|
| backend-engineer A | SimpleFIN provider, sync service, scheduler, setup-token exchange, encrypted settings | R1 | `providers/bank/`, `services/sync.py`, `scheduler.py`, sync and settings routers |
| backend-engineer B | Taxonomy seed, scrub and normalize, LLM providers, categorization pipeline, rules, transfer detection | R2, R3 | `providers/llm/`, `services/scrub.py`, `services/categorize.py`, `services/transfers.py`, transactions and categories routers |
| frontend-engineer C | App shell and navigation, Settings page, Transactions page with inline edits | R1.3, R2 UI | `web/src/pages/Settings*`, `web/src/pages/Transactions*`, layout |

**Checkpoint with you:** paste your real SimpleFIN token into your local `.env` and run a real sync. Agents never see the real token.

#### Wave 2: insight (three agents in parallel) — merged 2026-10-03

| Agent | Brief | Requirements | Owns |
|---|---|---|---|
| backend-engineer A (resumed) | Reports, recurring detection, projection | R4, R6, R7 | `services/recurring.py`, `services/projection.py`, reports, recurring and projection routers |
| backend-engineer B (resumed) | Manual entries, goals, savings suggestions | R5, R8 | `services/suggestions.py`, manual-entries, goals and suggestions routers |
| frontend-engineer C (resumed) | Overview charts, Recurring, Manual entries, Goals pages; a rules list with delete in Settings | R4 to R8 UI, R2.3 | remaining `web/src/pages/*`, `src/features/settings/RulesCard.tsx` |

Resuming the Wave 1 agents with SendMessage keeps what they learned about the codebase.

**Checkpoint with you:** a full click-through of the app on your real data. This is the moment to cut or reshape UI.

#### Wave 3: harden and ship (orchestrator plus one agent, serial)

- Auth: password login, session cookie, route protection, login page (R9).
- Production compose profile, Caddy, JSON logs, backup script, deploy README.
- An end-to-end test from sync through categorization to the Overview numbers.

