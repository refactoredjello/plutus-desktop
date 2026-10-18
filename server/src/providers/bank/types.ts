/**
 * Bank data provider interface. Nothing provider-specific may leak past these types.
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
  /** Null when the bank sends none. */
  readonly payee: string | null
  /** Null when the bank sends none. */
  readonly memo: string | null
  readonly pending: boolean
  /** ISO 8601 UTC timestamp, or null. */
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
  readonly transactions: readonly ProviderTransaction[]
}

export interface ProviderSnapshot {
  readonly accounts: readonly ProviderAccount[]
  /** Messages the provider reports alongside the data. */
  readonly errors: readonly string[]
}

export interface BankProvider {
  readonly name: string
  /**
   * HTTP requests made so far, so syncs can track the daily request budget. Providers without
   * a budget may omit it (read as 0).
   */
  readonly requestsMade?: number
  /**
   * All accounts with transactions posted between start and end, inclusive.
   */
  fetch(start: PlainDate, end: PlainDate): Promise<ProviderSnapshot>
}
