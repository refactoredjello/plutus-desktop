# Plutus

A private personal finance app for one person. Plutus pulls balances and transactions from your banks through [SimpleFIN Bridge](https://bridge.simplefin.org), categorizes them with an LLM without sending identifying data, and shows where your money goes, what repeats, where the month is heading, and what changed.

It is a desktop app (Electron) that keeps everything in one SQLite file on your machine. The same server also runs headless, without Electron, serving the web app on a port.

Plutus is a personal project, built for its author's own use and published as is. It is not a hosted service: there is no Plutus account to sign up for and no Plutus server. You bring your own SimpleFIN Bridge subscription and, if you use Claude, your own Anthropic API key. It runs on macOS only.

## What it does

- **Sync.** Read-only bank access through SimpleFIN, every 6 hours while the app is open or on demand, within SimpleFIN's 24-requests-a-day budget. The access link is encrypted at rest.
- **Categorize.** Plaid's personal finance categories plus your own custom ones. Your rules come first, then cached results, then Claude (or a local Ollama model) for merchants it hasn't seen. Each transaction is also marked essential, flexible, or discretionary.
- **Review.** A queue of transactions with no category or a low-confidence guess, with one-click "looks right", inline recategorizing, and rules made from any transaction. Transactions can carry private notes.
- **Understand.** An Overview dashboard, a Month view compared with your recent average, spending breakdowns by category and essentiality, and a "What changed" list of anything unusual this month.
- **Plan.** Recurring charge detection (including twice-a-month pay), planned income and expenses, a 3-month balance projection that skips expenses you mark as one-time, and savings goals with suggestions.

## Privacy

Nothing identifying leaves your machine.

- **To the LLM** go only scrubbed merchant names (no account numbers, reference numbers, dates, phone numbers, your name, or the other person in Zelle, Venmo, Cash App, Apple Cash, wire, or bank transfers), a coarse amount range, and the account type. Savings suggestions see category totals only.
- **Never sent:** balances, account names, raw bank descriptions, or your notes. Tests enforce this.
- **Known limitation:** a PayPal payment to a person (`PAYPAL *NAME`) can't be told apart from a merchant, so that name is not removed.
- **Fully local option:** choose Ollama as the LLM provider in Settings and nothing goes to any outside service except SimpleFIN.

## Install

You need:

- A Mac: Apple Silicon or Intel
- A [SimpleFIN Bridge](https://bridge.simplefin.org) account ($15 a year) for read-only bank access
- An [Anthropic API key](https://console.anthropic.com) for categorization, or [Ollama](https://ollama.com) to keep everything local

[First run](#first-run) says how to get the SimpleFIN token and the key.

1. From the [Releases page](https://github.com/refactoredjello/plutus-desktop/releases), download `Plutus-<version>-arm64.dmg` for Apple Silicon or `Plutus-<version>-x64.dmg` for Intel.
2. Open the dmg and drag Plutus to Applications.
3. Open Plutus. The app is not notarized by Apple, so macOS blocks the first open. Either open System Settings > Privacy & Security and click **Open Anyway** next to the message about Plutus, or run this once in Terminal:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Plutus.app
   ```

4. macOS asks to let Plutus use "Plutus Safe Storage" in your Keychain, where Plutus keeps the key that encrypts your SimpleFIN link and API key. Choose **Always Allow**.

Plutus opens on Settings. Your data lives in `~/Library/Application Support/Plutus/`.

**To update** a downloaded app: quit Plutus, download the newer dmg (or the `.zip`, which unzips to `Plutus.app`), and replace `/Applications/Plutus.app` with it. Your data stays where it is. Copy `plutus.sqlite` (and `plutus.sqlite-wal` and `plutus.sqlite-shm`, if present) out of the data folder first if you want a way back. The new version asks for the Keychain once more: choose **Always Allow** again. If you choose Deny, Plutus can't read the saved SimpleFIN link and API key, and you have to enter them again in Settings. Your financial data is not affected. From a checkout of this repository, `make update` does all of this for you (see [Updating](#updating)).

## Building from source

- [Node](https://nodejs.org) 24 or later, and GNU Make for the shortcuts below
- macOS for the desktop app (the headless server runs wherever Node does)

In a checkout of this repository, install every package from the root lockfile:

```bash
npm ci
```

## The desktop app

```bash
make dist
```

This builds the web app, the server, and the Electron shell and packages the app into `desktop/release/`: a dmg and a zip for Apple Silicon and for Intel, and the unpacked `mac-arm64/Plutus.app` and `mac/Plutus.app`. Open the dmg for your Mac, drag Plutus to Applications (or copy the `.app` there), and open it. Without a signing certificate the build is signed ad hoc, which runs on the Mac that built it. Data lives in `~/Library/Application Support/Plutus/plutus.sqlite` and the log in `logs/plutus.log` next to it; secrets are encrypted with the macOS Keychain. See [desktop/README.md](desktop/README.md) for signing, a second profile, and where things live.

`make dev` opens a development build instead, with its data in `Plutus Dev`, so it never touches the installed app's database.

### Updating

Releases are on the repository's GitHub Releases page (tag `v<version>`, a dmg and a zip for each architecture). Without a checkout, update by hand as described under [Install](#install). From a checkout, with the GitHub CLI logged in (`gh auth login`), run this from the repository root:

```bash
make update                  # quits Plutus, installs the latest release, reopens it; or: make update VERSION=0.2.0
make rollback                # back to the app the last update replaced
```

Both run `npm run update:app` in `desktop/` (which you can also run yourself after quitting Plutus).

The script copies your data to `~/Library/Application Support/Plutus/backups/manual-<time>/` and keeps the replaced app in `previous-app/` next to it before installing. By hand: quit Plutus, copy `plutus.sqlite` (and `-wal`, `-shm` if present) somewhere safe, replace `/Applications/Plutus.app` with the one from the release zip, and open it. Each new build asks once to use "Plutus Safe Storage" in the Keychain: choose Always Allow. Details, rollback with data, and releasing: [desktop/README.md](desktop/README.md#updating).

## The headless server

```bash
cp .env.example .env          # set PLUTUS_SECRET_KEY to a long random value
npm run build --workspace web && npm run build --workspace server
node --env-file=.env server/dist/main.js
```

Open http://127.0.0.1:8000. The database is `~/.plutus/plutus.sqlite` unless `PLUTUS_DATA_DIR` or `PLUTUS_DB_PATH` says otherwise; `.env.example` lists every variable. `PLUTUS_SECRET_KEY` encrypts the SimpleFIN link and the API key: changing it later means reconnecting your bank. There is no login: keep `HOST=127.0.0.1` and set `PLUTUS_API_GUARD=true`. The server answers only requests addressed to `127.0.0.1` or `localhost`; add other names to `PLUTUS_ALLOWED_HOSTS`. `make dev-server` runs the server from source with reload.

## First run

1. Open Settings. Choose the LLM provider (see below), and set the **owner name tokens**: the pieces of your name your bank prints, for example `JANE` and `DOE`, so they're scrubbed before categorization. Do this before the first sync, which caches categories from whichever provider is set.
2. Get a SimpleFIN setup token (see below). In Settings, paste the token and click Connect.
3. Click Sync now. The first sync fetches up to 180 days of history and takes a minute or two.
4. Work through the Review page to confirm or fix categories, and confirm detected items on the Recurring page.

**SimpleFIN setup token.** Create an account at [bridge.simplefin.org](https://bridge.simplefin.org), connect your banks there, then create a setup token for a new app. A setup token works only once: Plutus exchanges it for an access link, stores that link encrypted, and the token stops working. To reconnect later, create a new token. SimpleFIN Bridge is a third-party service, so it sees your bank data. Plutus only reads from it.

**LLM provider.** Plutus sends the LLM only the scrubbed data described under [Privacy](#privacy). Choose one of these:

- **Claude:** create an API key in the [Anthropic Console](https://console.anthropic.com) under API keys. API usage is billed to your Anthropic account, separately from any Claude.ai subscription. In Settings, choose Claude and paste the key. The model defaults to `claude-opus-5-5`, and the Model field takes any Claude model ID.
- **Ollama (fully local):** install [Ollama](https://ollama.com) and download a model with `ollama pull <model>`. In Settings, choose Ollama, set Model to that model's name, and leave the Ollama URL at `http://localhost:11434` unless you changed it.

Syncs then run every 6 hours while the app runs. SimpleFIN allows 24 requests a day; Settings shows how many are used, and Plutus refuses a sync that would exceed the budget.

## Try it without a bank

```bash
make demo-data      # into the headless server's database (PLUTUS_DATA_DIR, PLUTUS_DB_PATH)
make demo-clear
```

For the desktop app, load demo data into a separate profile with the app closed, then open that profile (both from the repository root):

```bash
PLUTUS_DB_PATH=/tmp/plutus-demo/plutus.sqlite make demo-data
cd desktop && npx electron . --data-dir /tmp/plutus-demo    # after make dev has built it once
```

Run `make demo-clear` before connecting a real account, so demo categories aren't reused.

## Development

| Command | What it does |
|---|---|
| `make check` | Lint, typecheck, and test web, server, and desktop (what CI runs) |
| `make openapi` | Regenerate the API spec and the TypeScript client after a schema change |
| `make dev` / `make smoke` | Open the desktop app from source / check it reaches the API on a throwaway data dir |
| `make dev-server` | Headless server on :8000 with reload |
| `make dist` | Package the desktop app (ad hoc signed unless a certificate is configured) |
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
docs/     Architecture, backlog, and the agent plan
```

Income, spending, and averages are defined once in `server/src/services/aggregates.ts`, so every page agrees. Only posted transactions count; pending ones show in the Transactions list but stay out of every total until they post. The frontend's API types are generated from the server's OpenAPI spec, and a test fails if they drift.

## Documentation

- [Architecture](docs/ARCHITECTURE.md): system design and conventions
- [Desktop app](desktop/README.md): building, signing, profiles, and where data and logs live
- [Backlog](docs/BACKLOG.md): open bugs and wanted changes
- [Agent plan](docs/AGENT_PLAN.md): the multi-agent workflow

## Status

Personal project, refined over time.

## License

[MIT](LICENSE).
