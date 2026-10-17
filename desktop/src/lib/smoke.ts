/** Helpers for the smoke mode (PLUTUS_SMOKE=1), which checks a real window and exits. */

import { setTimeout as sleep } from 'node:timers/promises'

export interface PollOptions {
  timeoutMs: number
  intervalMs: number
}

/** Calls `probe` until it returns a truthy value; errors count as "not yet". */
export async function pollUntil<T>(
  probe: () => Promise<T | null | undefined | false>,
  { timeoutMs, intervalMs }: PollOptions,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  for (;;) {
    try {
      const value = await probe()
      if (value) return value
    } catch (err) {
      lastError = err
    }
    if (Date.now() >= deadline) {
      const reason = lastError instanceof Error ? `: ${lastError.message}` : ''
      throw new Error(`timed out after ${timeoutMs} ms${reason}`)
    }
    await sleep(intervalMs)
  }
}
