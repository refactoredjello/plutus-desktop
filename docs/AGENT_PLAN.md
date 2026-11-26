# Plutus — Multi-Agent Build Plan

How Plutus is built with one orchestrating Opus session managing a small set of subagents in Claude Code.

## Shape: hub and spoke

```
                    ┌──────────────────────────────┐
                    │  Orchestrator (main session) │
                    │  plans, owns contracts,      │
                    │  reviews, opens PRs          │
                    └──────┬─────────┬─────────┬───┘
            brief + branch │         │         │  report back
                 ┌─────────▼──┐ ┌────▼──────┐ ┌▼────────────┐
                 │ server-    │ │ desktop-  │ │ frontend-   │
                 │ engineer   │ │ engineer  │ │ engineer    │
                 │ (worktree) │ │ (worktree)│ │ (worktree)  │
                 └────────────┘ └───────────┘ └─────────────┘
```

- **The orchestrator never writes feature code.** It writes briefs, owns shared contracts (`server/src/db/schema.ts`, migrations, Zod schemas, `server/src/app.ts`, root config), reviews diffs, runs the full suite, and opens the pull request; the owner merges it into `main`.
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

`AGENTS.md` at the repository root carries the principles, setup, and conventions into every agent (`CLAUDE.md` imports it for Claude Code).

## The orchestrator's loop for every brief

1. Write the brief: requirement IDs, files owned, done-when check, and what not to touch.
2. Spawn the agent in the background in a worktree.
3. When it reports, read the diff, check the branch log (a failing-test commit before each implementation commit), and run `/code-review` on the branch.
4. Send fixes back to the same agent via SendMessage until clean.
5. Merge into the orchestrator's branch (never `main`) with `git merge --no-ff`, run `make check`, regenerate the API client if schemas changed (`make openapi`), then push and open a pull request against `main`.
6. Log anything that changed a requirement in the decisions table in REQUIREMENTS.md.

## Rules that keep parallel work safe

- **Schema and migration changes go through the orchestrator only.** An agent that needs one asks in its report.
- **File ownership is explicit in every brief.** Two agents never own the same file in the same wave.
- **Shared registration points are pre-written**, such as route registration in `server/src/app.ts` and routes in the React router.
- **No real secrets in any agent's environment.** Fixtures and fake providers only. The owner adds real keys in the app's Settings.
- **Merges into the orchestrator's branch happen one at a time**, each followed by a green `make check`.
- **Items on docs/BACKLOG.md are fixed only with the owner's go-ahead.**
