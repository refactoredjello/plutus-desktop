/**
 * Structured logging with pino: JSON lines everywhere (no pretty printer dependency).
 * LOG_LEVEL takes debug, info, warning (or warn), error, or critical (or fatal), in any case.
 */

import { type DestinationStream, type Logger, pino } from 'pino'

export type { Logger }

const LOG_LEVELS: Record<string, string> = {
  debug: 'debug',
  info: 'info',
  warning: 'warn',
  warn: 'warn',
  error: 'error',
  critical: 'fatal',
  fatal: 'fatal',
}

export function createLogger(options: { level: string }, destination?: DestinationStream): Logger {
  const level = LOG_LEVELS[options.level.toLowerCase()]
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
