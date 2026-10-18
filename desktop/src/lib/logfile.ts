/**
 * Where the desktop's logs go: JSON lines appended to <data dir>/logs/plutus.log and echoed
 * to stdout (visible when launched from a terminal). A pino destination. One previous file is
 * kept: at launch, a log over the size limit becomes plutus.log.1.
 */

import { closeSync, mkdirSync, openSync, renameSync, statSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

export const MAX_LOG_BYTES = 5 * 1024 * 1024

export interface LogDestination {
  write(line: string): void
  close(): void
}

export function fileLogDestination(
  file: string,
  { maxBytes = MAX_LOG_BYTES, echo = process.stdout }: { maxBytes?: number; echo?: { write(line: string): unknown } } = {},
): LogDestination {
  mkdirSync(dirname(file), { recursive: true })
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    // no log yet
  }
  if (size >= maxBytes) renameSync(file, `${file}.1`)
  let fd: number | null = openSync(file, 'a', 0o600)
  return {
    write(line) {
      if (fd !== null) writeSync(fd, line)
      echo.write(line)
    },
    close() {
      if (fd !== null) closeSync(fd)
      fd = null
    },
  }
}
