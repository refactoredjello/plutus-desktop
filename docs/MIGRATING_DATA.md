# Moving your data from the Docker app to the desktop app

The Docker app keeps everything in Postgres. The desktop app (and the headless TypeScript
server) keeps everything in one SQLite file. Moving over takes two steps: export from
Postgres to a JSON file, then import that file into a new SQLite database (from the desktop's
File menu, or with a command for the headless server).

> **The export file holds your SimpleFIN access URL and your Anthropic API key in clear
> text.** The URL is a password: anyone who has it can read your bank data. The key lets anyone
> spend on your Anthropic account. The file also holds every transaction, note, and balance. Keep it on your own machine, never commit, email, or upload it, and **delete it
> as soon as the import has succeeded** (step 5).

## What moves

Every table, row for row, with the same ids: accounts, balances, transactions, notes,
one-time marks, categorizations, your categories (including custom and hidden ones), rules,
cached merchant classifications, recurring charges, manual entries, goals, suggestions, sync
history, dismissed "What changed" items, and the SimpleFIN connection.

The settings that lived in the Docker app's `.env` move too: LLM provider, model, Anthropic
API key, Ollama URL, owner name tokens, sync interval, first-sync history, and whether the
scheduler runs. They land in the new app's settings, where the Settings page can change them;
the new app's own defaults never override them.

## 1. Stop syncing

Stop the Docker API so no sync writes while you export. The database keeps running:

```bash
cd ~/dev/Plutus
docker compose stop api
```

## 2. Export from the Docker app

The exporter (`python -m app.export_json`) is not in the Docker app: it was written during the
desktop port, and the Python code left this repository after tag `wave-4`. Check out that tag
next to this repository and run the exporter from there, against the Docker app's Postgres
(published on `localhost:5432`) with a copy of the Docker app's `.env`, so it decrypts the
SimpleFIN URL with the same `SECRET_KEY` and carries the same settings over. You need
[uv](https://docs.astral.sh/uv/).

```bash
git -C ~/dev/plutus-desktop worktree add ~/plutus-wave-4 wave-4
cd ~/plutus-wave-4/api
uv sync
cp ~/dev/Plutus/.env .env
DATABASE_URL=postgresql+psycopg://plutus:plutus@localhost:5432/plutus \
  uv run python -m app.export_json ~/plutus-export.json
```

`DATABASE_URL` on the command line wins over the one in `.env`, which names the compose host
`db`. If your `.env` sets a `POSTGRES_PASSWORD` other than `plutus`, put it in place of the
second `plutus` in the URL.

It prints a row count per table. Keep that output: step 4 prints the same table. The file is
created readable by you only, and the export refuses to overwrite an existing file. If it
says a setting "cannot be decrypted", the `SECRET_KEY` is not the one the URL was saved with:
check that the `.env` you copied is the Docker app's; don't work around it.

The copied `.env` holds your secrets too; step 5 removes the checkout with it.

## 3. Decide where the data goes

The import needs a database that holds nothing yet. It refuses anything else, so it can never
merge into or overwrite existing data.

- **Desktop app:** the database is `~/Library/Application Support/Plutus/plutus.sqlite`. A
  desktop that was opened but never synced or edited is fine: the default settings it wrote
  on first launch are replaced by yours. Anything more (a transaction, a rule, a SimpleFIN
  connection) and the import refuses; to start over, quit the app and move that folder aside.
  To try the import first without touching that folder, start the app with a second profile:
  `/Applications/Plutus.app/Contents/MacOS/Plutus --data-dir ~/plutus-import-test`.
- **Headless server:** the file is `PLUTUS_DB_PATH`, or `plutus.sqlite` in `PLUTUS_DATA_DIR`
  (default `~/.plutus`).

## 4. Import

**Desktop app.** Open Plutus (a new install opens on Settings), choose **File > Import from
Docker export...**, and pick `~/plutus-export.json`. The desktop encrypts the SimpleFIN URL
and the API key with its macOS Keychain key, so the connection carries over: when the import
finishes, the window reloads on the Overview with your data, and Settings shows SimpleFIN
connected. If macOS asks whether Plutus may use "Plutus Safe Storage", choose Always Allow.
The message after the import counts accounts, transactions, rules, and goals; compare them
with step 2's table. If the import is refused, the message says why and nothing was written.

**Headless server.** From the repository root, after `npm ci`:

```bash
PLUTUS_SECRET_KEY='<the key the new server will use>' \
  node_modules/.bin/tsx server/scripts/import-json.ts ~/plutus-export.json --db <path to plutus.sqlite>
```

`PLUTUS_SECRET_KEY` re-encrypts the SimpleFIN URL and the API key in the new database. It must
be the key the headless server runs with; pick a new long random value, not the Docker
`SECRET_KEY`. Without `--db`, the target is `PLUTUS_DB_PATH`, else
`PLUTUS_DATA_DIR/plutus.sqlite`. Don't use this command for the desktop's database: the
desktop cannot read secrets encrypted with `PLUTUS_SECRET_KEY` and would ask you to reconnect
SimpleFIN and enter the API key again.

Either way the import runs in one transaction: it either imports everything or writes
nothing. Before committing it checks that every table has exactly as many rows as the file.
The command prints a count table; compare it with the one from step 2.

## 5. Delete the export file and the wave-4 checkout

```bash
rm ~/plutus-export.json
git -C ~/dev/plutus-desktop worktree remove --force ~/plutus-wave-4
```

`--force` is needed because of the copied `.env`; the checkout is deleted with it. Also empty
the export from the trash if you moved it there, and delete any copy you made.

## 6. Check

Start the new app and compare a few pages with the Docker app: the dashboard, a month's
transactions, recurring charges, goals. Open Settings and check the LLM provider and the
**owner name tokens**. The owner name tokens decide how new transactions are cleaned up into
merchant names; if they differ from before, new transactions stop matching your rules, cached
categories, and recurring charges. If you used Ollama, check its URL too: the Docker `.env`
usually names `host.docker.internal`, which only resolves inside a container; outside one it
is `http://localhost:11434`.

The headless server applies any of these settings set in its environment (`LLM_PROVIDER`,
`OWNER_NAME_TOKENS`, and so on) at every start, over the imported values. Leave them unset
to keep what you imported.

Keep the Docker stack and its database volume until you are satisfied. Nothing in this process
changes them.

## Format notes

The file is JSON: `format` (`plutus-export`), `format_version` (2), `alembic_revision` (the
Python schema it came from; the importer reads `0006`), `exported_at`, `sequences` (the
highest id each table ever handed out, so the new database never reuses an id),
`runtime_config` (the `.env` settings, keyed like the Settings API, the API key in clear text
or null), and `tables` (every row, in an order where parents come before children). Money is a two-decimal string,
dates are `YYYY-MM-DD`, timestamps are ISO 8601 in UTC. The importer stores money as integer
cents and timestamps in the server's format (UTC, milliseconds, `Z`); microseconds are cut
to milliseconds.

`server/test/import-fixture.test.ts` imports a committed export of the fake demo data
(`server/test/fixtures/demo-export.json`) and checks the row counts, the monthly report, and
the secrets. `desktop/test/importer.test.ts` imports it with the desktop's secret store, and
`PLUTUS_SMOKE_IMPORT` (desktop/README.md) runs the menu's import in the real app.
