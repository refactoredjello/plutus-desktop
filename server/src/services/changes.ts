/**
 * What changed (R12). Ports app/services/changes.py. Brief 3B owns this file.
 *
 * Orchestrator stub so brief 3A (sync) can call pruneDismissals while 3B runs in parallel.
 * Brief 3B replaces the whole file; keep the signature.
 */

import type { Db } from '../db/index.js'

/**
 * prune_dismissals: drop dismissals older than the retention window and return how many.
 * `now` is an ISO 8601 UTC timestamp, default the current instant. Does not open a transaction.
 */
export function pruneDismissals(_db: Db, _now?: string): number {
  return 0
}
