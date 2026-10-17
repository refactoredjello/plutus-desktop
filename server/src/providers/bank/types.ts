/**
 * Bank data provider interface. Nothing provider-specific may leak past these types.
 * Ports app/providers/bank/base.py; the frozen dataclasses become readonly types.
 */

import type { AccountType } from '../../db/schema.js'
import type { PlainDate } from '../../lib/dates.js'
import type { Cents } from '../../lib/money.js'

export interface ProviderTransaction {
  readonly external_id: string
  readonly posted_on: PlainDate
  /** Negative is an outflow. */
  readonly amount: Cents
  readonly description: string
  /** Python default None. */
  readonly payee: string | null
  /** Python default None. */
  readonly memo: string | null
  /** Python default False. */
  readonly pending: boolean
  /** ISO 8601 UTC timestamp; Python default None. */
  readonly transacted_at: string | null
}

export interface ProviderAccount {
  readonly external_id: string
  readonly name: string
  readonly type: AccountType
  readonly institution_name: string | null
  readonly currency: string
  readonly balance: Cents
  readonly available: Cents | null
  /** ISO 8601 UTC timestamp. */
  readonly balance_as_of: string
  /** Python default []. */
  readonly transactions: readonly ProviderTransaction[]
}

export interface ProviderSnapshot {
  readonly accounts: readonly ProviderAccount[]
  /** Python default []. */
  readonly errors: readonly string[]
}

export interface BankProvider {
  readonly name: string
  /**
   * HTTP requests made so far, so syncs can track the daily request budget. Python read it with
   * getattr(provider, "requests_made", 0); providers without a budget may omit it.
   */
  readonly requestsMade?: number
  /**
   * All accounts with transactions posted between start and end, inclusive. Async because
   * HTTP is async in Node; the Python method was synchronous.
   */
  fetch(start: PlainDate, end: PlainDate): Promise<ProviderSnapshot>
}
