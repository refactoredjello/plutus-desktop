/**
 * Accounts with their latest balance snapshot. Ports list_accounts from
 * api/app/routers/accounts.py, where the query lived in the router.
 *
 * Rewritten for SQLite:
 * - `DISTINCT ON (account_id) ... ORDER BY account_id, as_of DESC, id DESC` is
 *   `row_number() over (partition by account_id order by as_of desc, id desc) = 1`.
 * - `ORDER BY institution_name` puts NULLs last in Postgres and first in SQLite, so it says
 *   `nulls last`.
 */

import { asc, sql } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { accounts, balanceSnapshots } from '../db/schema.js'
import { formatMoney } from '../lib/money.js'
import type { AccountRead } from '../schemas/accounts.js'

export function listAccounts(db: Db): AccountRead[] {
  const ranked = db
    .select({
      account_id: balanceSnapshots.account_id,
      balance: balanceSnapshots.balance,
      available: balanceSnapshots.available,
      as_of: balanceSnapshots.as_of,
      rn: sql<number>`row_number() over (partition by ${balanceSnapshots.account_id} order by ${balanceSnapshots.as_of} desc, ${balanceSnapshots.id} desc)`.as(
        'rn',
      ),
    })
    .from(balanceSnapshots)
    .as('ranked')
  const latest = new Map(
    db
      .select()
      .from(ranked)
      .where(sql`${ranked.rn} = 1`)
      .all()
      .map((s) => [s.account_id, s]),
  )
  return db
    .select()
    .from(accounts)
    .orderBy(sql`${accounts.institution_name} asc nulls last`, asc(accounts.name), asc(accounts.id))
    .all()
    .map((a) => {
      const snap = latest.get(a.id)
      return {
        id: a.id,
        name: a.name,
        type: a.type,
        institution_name: a.institution_name,
        currency: a.currency,
        is_active: a.is_active,
        balance: snap ? formatMoney(snap.balance) : null,
        available: snap && snap.available !== null ? formatMoney(snap.available) : null,
        balance_as_of: snap ? snap.as_of : null,
      }
    })
}
