/**
 * Import a Postgres JSON export into a fresh SQLite database, from the command line.
 *
 *   PLUTUS_SECRET_KEY=... node_modules/.bin/tsx server/scripts/import-json.ts <export.json> [--db <path>]
 *
 * The target defaults to PLUTUS_DB_PATH, else <PLUTUS_DATA_DIR>/plutus.sqlite. Secrets are
 * encrypted with KeySecretStore and PLUTUS_SECRET_KEY, for the headless server; the desktop
 * imports from its File menu instead. The rules are in src/importer.ts, the steps in
 * docs/MIGRATING_DATA.md. The export holds the SimpleFIN access URL in clear text: delete it
 * after the import.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.js'
import { openDb } from '../src/db/index.js'
import { importExport } from '../src/importer.js'
import { KeySecretStore } from '../src/secrets.js'

export interface Output {
  log(message: string): void
  error(message: string): void
}

const USAGE = 'usage: PLUTUS_SECRET_KEY=... tsx server/scripts/import-json.ts <export.json> [--db <path>]'

/** The command line: returns the exit code. */
export function runCli(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  out: Output = console,
): number {
  const args = [...argv]
  let dbPath: string | undefined
  const at = args.indexOf('--db')
  if (at !== -1) {
    dbPath = args[at + 1]
    args.splice(at, 2)
  }
  const [file, ...rest] = args
  if (file === undefined || rest.length > 0 || (at !== -1 && !dbPath)) {
    out.error(USAGE)
    return 2
  }
  const secretKey = env.PLUTUS_SECRET_KEY
  if (!secretKey) {
    out.error('PLUTUS_SECRET_KEY is not set: it encrypts the SimpleFIN access URL in the new database')
    return 2
  }
  const target = resolve(dbPath ?? loadConfig(env).databasePath)

  let data: unknown
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    out.error(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  const db = openDb(target)
  try {
    const counts = importExport(db, data, new KeySecretStore(secretKey), { defaults: loadConfig(env).defaults })
    for (const [name, n] of Object.entries(counts)) out.log(`${name.padEnd(26)} ${String(n).padStart(7)}`)
    out.log('runtime config (LLM provider, owner name tokens, sync settings, API key) stored in app_settings')
    out.log(`imported into ${target}. Delete ${file} now: it holds secrets in clear text.`)
    return 0
  } catch (err) {
    out.error(`import refused, nothing written: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  } finally {
    db.$client.close()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runCli(process.argv.slice(2)))
}
