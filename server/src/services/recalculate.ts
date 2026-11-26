/**
 * The Refresh button: recompute derived data locally after rules or categories change.
 *
 * Re-keys transactions whose description changed, re-applies rules to non-manual categorizations, categorizes what it can from rules and the
 * merchant cache, then detects recurring charges, in one transaction. Never asks the bank or
 * the LLM: merchants never seen before stay uncategorized until the next sync.
 */

import type { RuntimeDefaults } from '../config.js'
import type { Db } from '../db/index.js'
import type { RecalculateRead } from '../schemas/recalculate.js'
import type { SecretStore } from '../secrets.js'
import { categorizeLocally, reapplyRules, refreshMerchantKeys } from './categorize.js'
import { detectRecurring } from './recurring.js'

export function recalculate(db: Db, secrets: SecretStore, defaults: RuntimeDefaults): RecalculateRead {
  return db.transaction(() => {
    refreshMerchantKeys(db, secrets, defaults)
    const recategorized = reapplyRules(db, secrets, defaults)
    const categorized = categorizeLocally(db, secrets, defaults)
    const recurring_changes = detectRecurring(db)
    return { recategorized, categorized, recurring_changes }
  })
}
