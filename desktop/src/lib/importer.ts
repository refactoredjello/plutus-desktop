/**
 * File > Import from Docker export...: the server's importer run against the desktop's own
 * database, with secrets encrypted by the desktop's SecretStore (safeStorage), so the SimpleFIN
 * connection and the API key carry over. Temporary, like the importer: removed once the
 * owner's data has moved (docs/MIGRATING_DATA.md).
 */

import { readFileSync } from 'node:fs'
import type { RuntimeDefaults } from 'plutus-server/config'
import type { Db } from 'plutus-server/db'
import { type ImportCounts, ImportError, importExport } from 'plutus-server/importer'
import type { SecretStore } from 'plutus-server/secrets'

/**
 * Imports the export file into `db`, which must hold nothing but what a first launch writes.
 * Throws ImportError (or a SQLite error) having written nothing. Messages never include
 * file contents.
 */
export function importExportFile(db: Db, file: string, secrets: SecretStore, defaults: RuntimeDefaults): ImportCounts {
  let data: unknown
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    const reason = err instanceof SyntaxError ? 'not valid JSON' : err instanceof Error ? err.message : String(err)
    throw new ImportError(`cannot read ${file}: ${reason}`)
  }
  return importExport(db, data, secrets, { defaults })
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/** The message shown after a successful import. */
export function importSummary(counts: ImportCounts): string {
  const n = (table: string) => counts[table] ?? 0
  return (
    `Imported ${plural(n('accounts'), 'account')}, ${plural(n('transactions'), 'transaction')}, ` +
    `${plural(n('rules'), 'rule')}, and ${plural(n('goals'), 'goal')}, with your settings and ` +
    'SimpleFIN connection.\n\nDelete the export file now: it holds your SimpleFIN access URL and ' +
    'API key in clear text.'
  )
}
