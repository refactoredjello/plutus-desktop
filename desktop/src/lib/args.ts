/**
 * The shell's own command-line flags. Electron passes everything through process.argv
 * (`electron . --data-dir x` in development, `Plutus --data-dir x` when packaged); Chromium
 * switches such as --remote-debugging-port are left alone.
 */

import { resolve } from 'node:path'

export interface ShellArgs {
  /** --data-dir: a second profile's folder (database, log, and single-instance lock). */
  dataDir: string | null
}

const FLAG = '--data-dir'

export function parseShellArgs(argv: readonly string[], cwd: string): ShellArgs {
  let value: string | undefined
  let found = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === FLAG) {
      found = true
      value = argv[i + 1]
      break
    }
    if (arg.startsWith(`${FLAG}=`)) {
      found = true
      value = arg.slice(FLAG.length + 1)
      break
    }
  }
  if (!found) return { dataDir: null }
  // Never fall back to the default folder: a mistyped flag must not open the real data.
  if (!value || value.startsWith('--')) throw new Error(`${FLAG} needs a path: ${FLAG} <folder>`)
  return { dataDir: resolve(cwd, value) }
}
