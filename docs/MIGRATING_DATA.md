# Moving your data from the Docker app to the desktop app

The Docker app keeps everything in Postgres. The desktop app (and the headless TypeScript
server) keeps everything in one SQLite file. Moving over takes two commands: export from
Postgres to a JSON file, then import that file into a new SQLite database.

> **The export file holds your SimpleFIN access URL in clear text.** That URL is a password:
> anyone who has it can read your bank data. The file also holds every transaction, note, and
> balance. Keep it on your own machine, never commit, email, or upload it, and **delete it
> as soon as the import has succeeded** (step 5).

## What moves

Every table, row for row, with the same ids: accounts, balances, transactions, notes,
one-time marks, categorizations, your categories (including custom and hidden ones), rules,
cached merchant classifications, recurring charges, manual entries, goals, suggestions, sync
history, dismissed "What changed" items, and the SimpleFIN connection.

What does not move: settings that lived in the Docker app's `.env` (LLM provider, model,
Anthropic API key, Ollama URL, owner name tokens, sync interval, first-sync history). Set them
again in the new app's Settings page after the import (step 6).

## 1. Stop syncing

Stop the Docker API so no sync writes while you export. The database keeps running:

```bash
docker compose stop api
```

## 2. Export from the Docker app

Run the export in a one-off API container, so it uses the same `.env` and `SECRET_KEY` that
encrypted the SimpleFIN URL. The current directory is mounted at `/out`, so the file lands
here and nothing stays in the container:

```bash
docker compose run --rm --no-deps -v "$PWD:/out" api \
  python -m app.export_json /out/plutus-export.json
```

The container runs as uid 1000; on Linux, run this from a directory that user can write to.
It prints a row count per table. Keep that output: step 4 prints the same table. The file is
created readable by you only, and the export refuses to overwrite an existing file. If it
says a setting "cannot be decrypted", the container's `SECRET_KEY` is not the one the URL was
saved with: fix `.env`, don't work around it.

If you run the API from a checkout instead (`cd api && uv run ...`), set `DATABASE_URL` and
the same `SECRET_KEY` as the container uses before running `python -m app.export_json`.

## 3. Decide where the data goes

The import needs a database that holds nothing yet. It refuses anything else, so it can never
merge into or overwrite existing data.

- **Desktop app:** the file is `~/Library/Application Support/Plutus/plutus.sqlite` on macOS.
  Quit the app first. If you have opened it before but have nothing in it you want, move that
  folder aside; opening the app writes default settings, and the import then refuses the file.
- **Headless server:** the file is `PLUTUS_DB_PATH`, or `plutus.sqlite` in `PLUTUS_DATA_DIR`
  (default `~/.plutus`).

## 4. Import

From the repository root, after `npm ci`:

```bash
PLUTUS_SECRET_KEY='<the key the new server will use>' \
  node_modules/.bin/tsx server/scripts/import-json.ts plutus-export.json --db <path to plutus.sqlite>
```

`PLUTUS_SECRET_KEY` re-encrypts the SimpleFIN URL in the new database. It must be the key the
headless server runs with; pick a new long random value, not the Docker `SECRET_KEY`. Without
`--db`, the target is `PLUTUS_DB_PATH`, else `PLUTUS_DATA_DIR/plutus.sqlite`.

The import runs in one transaction: it either imports everything or writes nothing. Before
committing it checks that every table has exactly as many rows as the file. Compare its count
table with the one from step 2.

**Desktop app and the SimpleFIN connection.** The desktop encrypts secrets with the macOS
Keychain, not with `PLUTUS_SECRET_KEY`, so it cannot read a URL this command encrypted. All
your data imports, but the desktop will ask you to reconnect SimpleFIN. An import from inside
the desktop app that uses the Keychain is planned (brief 5B in `docs/DESKTOP_PLAN.md`); wait
for it if you want the connection to carry over.

## 5. Delete the export file

```bash
rm plutus-export.json
```

Also empty it from the trash if you moved it there, and delete any copy you made.

## 6. Check, then set your settings

Start the new app and compare a few pages with the Docker app: the dashboard, a month's
transactions, recurring charges, goals. Then open Settings and set the LLM provider, model,
API key, and **owner name tokens** you had in `.env`. The owner name tokens decide how new
transactions are cleaned up into merchant names; if they differ from before, new transactions
stop matching your rules, cached categories, and recurring charges.

Keep the Docker stack and its database volume until you are satisfied. Nothing in this process
changes them.

## Format notes

The file is JSON: `format` (`plutus-export`), `format_version` (1), `alembic_revision` (the
Python schema it came from; the importer reads `0006`), `exported_at`, `sequences` (the
highest id each table ever handed out, so the new database never reuses an id), and `tables`
(every row, in an order where parents come before children). Money is a two-decimal string,
dates are `YYYY-MM-DD`, timestamps are ISO 8601 in UTC. The importer stores money as integer
cents and timestamps in the server's format (UTC, milliseconds, `Z`); microseconds are cut
to milliseconds.

`make import-check` runs the whole path on fake demo data and compares the result.
