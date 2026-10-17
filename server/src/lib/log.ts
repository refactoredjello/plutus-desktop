/**
 * Structured logging with pino. Ports app/logging.py (structlog).
 *
 * structlog rendered a console format in development and JSON in production; pino writes
 * JSON lines everywhere (no pretty printer dependency). Level names follow Python's, so an
 * existing LOG_LEVEL keeps working.
 */

import { type DestinationStream, type Logger, pino } from 'pino'

export type { Logger }

const PY_LEVELS: Record<string, string> = {
  debug: 'debug',
  info: 'info',
  warning: 'warn',
  warn: 'warn',
  error: 'error',
  critical: 'fatal',
  fatal: 'fatal',
}

export function createLogger(options: { level: string }, destination?: DestinationStream): Logger {
  const level = PY_LEVELS[options.level.toLowerCase()]
  if (!level) throw new Error(`Unknown log level: ${options.level}`)
  return pino(
    {
      level,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    destination ?? pino.destination(1),
  )
}

/** A logger that discards everything, for tests and library defaults. */
export function silentLogger(): Logger {
  return pino({ level: 'silent' })
}
