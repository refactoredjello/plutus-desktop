/**
 * Load or clear fake demo data for local development. Ports app/demo.py.
 *
 *   npm run demo -- load    # sync the fake SimpleFIN fixture through the real pipeline
 *   npm run demo -- clear   # delete demo accounts, their transactions, and demo sync runs
 *
 * The database is the server's: PLUTUS_DB_PATH, else <PLUTUS_DATA_DIR>/plutus.sqlite.
 * Demo rows use provider "demo", so they never mix with a real SimpleFIN connection.
 * Run `clear` before connecting a real bank so demo classifications are not reused.
 *
 * Python renamed a SimpleFINProvider instance; here a small wrapper carries the name.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq, isNotNull, notInArray } from 'drizzle-orm'
import { type RuntimeDefaults, loadConfig } from '../src/config.js'
import { type Db, openDb } from '../src/db/index.js'
import { accounts, merchantClassifications, syncRuns, transactions } from '../src/db/schema.js'
import { type Logger, createLogger, silentLogger } from '../src/lib/log.js'
import { SimpleFINProvider } from '../src/providers/bank/simplefin.js'
import type { BankProvider } from '../src/providers/bank/types.js'
import { KeySecretStore, type SecretStore } from '../src/secrets.js'
import { runSync } from '../src/services/sync.js'

export const DEMO_PROVIDER = 'demo'
export const FIXTURE = fileURLToPath(new URL('../test/fixtures/simplefin_accounts.json', import.meta.url))

const USAGE = `Load or clear fake demo data for local development.

    npm run demo -- load    # sync the fake SimpleFIN fixture through the real pipeline
    npm run demo -- clear   # delete demo accounts, their transactions, and demo sync runs

Demo rows use provider "demo", so they never mix with a real SimpleFIN connection.
Run \`clear\` before connecting a real bank so demo classifications are not reused.`

export function demoProvider(): BankProvider {
  const payload: unknown = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  const inner = new SimpleFINProvider('https://demo:demo@demo.invalid/simplefin', async () => Response.json(payload))
  return {
    name: DEMO_PROVIDER,
    get requestsMade() {
      return inner.requestsMade
    },
    fetch: (start, end) => inner.fetch(start, end),
  }
}

/** Sync the fixture; returns the lines Python printed. */
export async function load(
  db: Db,
  secrets: SecretStore,
  defaults: RuntimeDefaults,
  log: Logger = silentLogger(),
): Promise<string[]> {
  const run = await runSync(db, secrets, defaults, demoProvider(), 'manual', log)
  const lines = [`demo sync ${run.status}: added ${run.added}, updated ${run.updated}`]
  if (run.error_text) lines.push(run.error_text)
  return lines
}

/** Delete the demo data; returns the lines Python printed. */
export function clear(db: Db): string[] {
  return db.transaction(() => {
    const removed = db.delete(accounts).where(eq(accounts.provider, DEMO_PROVIDER)).returning({ id: accounts.id }).all()
    db.delete(syncRuns).where(eq(syncRuns.provider, DEMO_PROVIDER)).run()
    // Demo data is classified by whichever LLM is configured, often the fake one. Drop cached
    // classifications no remaining transaction uses, so real data gets classified fresh.
    const used = db
      .select({ key: transactions.merchant_key })
      .from(transactions)
      .where(isNotNull(transactions.merchant_key))
    const orphans = db
      .delete(merchantClassifications)
      .where(notInArray(merchantClassifications.merchant_key, used))
      .returning({ key: merchantClassifications.merchant_key })
      .all()
    return [
      `removed ${removed.length} demo accounts, their transactions, and ${orphans.length} cached merchants`,
      'Rules you created are kept.',
    ]
  })
}

/** `python -m app.demo <command>`: returns the exit code. */
export async function main(argv: readonly string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const command = argv.length === 1 ? argv[0] : undefined
  if (command !== 'load' && command !== 'clear') {
    console.error(USAGE)
    return 1
  }
  const config = loadConfig(env)
  const db = openDb(config.databasePath)
  try {
    const lines =
      command === 'load'
        ? await load(db, new KeySecretStore(config.secretKey), config.defaults, createLogger({ level: config.logLevel }))
        : clear(db)
    for (const line of lines) console.log(line)
    return 0
  } finally {
    db.$client.close()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
