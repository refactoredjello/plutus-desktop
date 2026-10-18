/**
 * The native dialog shown when the app can't start. openDb's DatabaseOpenError gets a plain
 * title per case (backup restored, data from a newer Plutus, update refused); anything else
 * keeps the generic one.
 */

import { DatabaseOpenError } from 'plutus-server/db'

export interface StartupDialog {
  title: string
  message: string
}

const TITLES: Record<DatabaseOpenError['kind'], string> = {
  restored: 'Plutus could not update your data',
  too_new: 'This data is from a newer version of Plutus',
  backup_failed: 'Plutus did not update your data',
  migration_failed: 'Plutus could not update your data',
}

export function startupDialog(err: unknown, logFile: string | null): StartupDialog {
  const details = logFile ? `\n\nDetails are in ${logFile}.` : ''
  if (err instanceof DatabaseOpenError) {
    // The technical reasons for a restore are in the log; the owner needs the outcome.
    const message =
      err.kind === 'restored'
        ? 'The update to your data failed a safety check, so Plutus restored the backup it made ' +
          `just before. Nothing was lost.\n\nThe backup is at ${err.backupPath}.\n\n` +
          'Reinstall the previous version of Plutus.'
        : err.message
    return { title: TITLES[err.kind], message: `${message}${details}` }
  }
  const message = err instanceof Error ? err.message : String(err)
  return { title: 'Plutus could not start', message: `${message}${details}` }
}
