/**
 * Key/value app settings with optional encryption of values, plus the SimpleFIN connection
 * logic (routes stay thin).
 *
 * Encryption goes through the SecretStore. With KeySecretStore the
 * key is derived from PLUTUS_SECRET_KEY, so rotating it invalidates stored secrets.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { appSettings } from '../db/schema.js'
import { utcNow } from '../lib/dates.js'
import { DomainError } from '../lib/errors.js'
import { SecretDecryptError, type SecretStore } from '../secrets.js'

export const SIMPLEFIN_ACCESS_URL = 'simplefin_access_url'
export const SIMPLEFIN_CONNECTED_AT = 'simplefin_connected_at'

export function setSetting(
  db: Db,
  secrets: SecretStore,
  key: string,
  value: string,
  { encrypt = false }: { encrypt?: boolean } = {},
): void {
  const stored = encrypt ? secrets.encrypt(value) : value
  const row = db.select().from(appSettings).where(eq(appSettings.key, key)).get()
  if (row === undefined) {
    db.insert(appSettings).values({ key, value: stored, is_encrypted: encrypt }).run()
  } else {
    db.update(appSettings)
      .set({ value: stored, is_encrypted: encrypt })
      .where(eq(appSettings.key, key))
      .run()
  }
}

export function getSetting(db: Db, secrets: SecretStore, key: string): string | null {
  const row = db.select().from(appSettings).where(eq(appSettings.key, key)).get()
  if (row === undefined) return null
  if (!row.is_encrypted) return row.value
  try {
    return secrets.decrypt(row.value)
  } catch (err) {
    if (err instanceof SecretDecryptError) {
      throw new DomainError(
        `Stored setting '${key}' cannot be decrypted; SECRET_KEY has changed. Reconnect.`,
      )
    }
    throw err
  }
}

export function deleteSetting(db: Db, key: string): void {
  db.delete(appSettings).where(eq(appSettings.key, key)).run()
}

export interface SimpleFINStatus {
  connected: boolean
  connected_at: string | null
}

/** Exchanges a SimpleFIN setup token for the access URL (providers/bank/simplefin.ts). */
export type ClaimSetupToken = (setupToken: string) => Promise<string>

export function simplefinStatus(db: Db, secrets: SecretStore): SimpleFINStatus {
  const connected = getSetting(db, secrets, SIMPLEFIN_ACCESS_URL)
  const stamp = getSetting(db, secrets, SIMPLEFIN_CONNECTED_AT)
  return {
    connected: connected !== null,
    // datetime.fromisoformat then serialization: the same instant, in the server's format.
    connected_at: connected !== null && stamp ? new Date(stamp).toISOString() : null,
  }
}

/** Exchange a SimpleFIN setup token for an access URL and store it encrypted. */
export async function connectSimplefin(
  db: Db,
  secrets: SecretStore,
  setupToken: string,
  claim: ClaimSetupToken,
): Promise<SimpleFINStatus> {
  const accessUrl = await claim(setupToken)
  const now = utcNow()
  setSetting(db, secrets, SIMPLEFIN_ACCESS_URL, accessUrl, { encrypt: true })
  setSetting(db, secrets, SIMPLEFIN_CONNECTED_AT, now)
  return { connected: true, connected_at: now }
}

export function disconnectSimplefin(db: Db): void {
  deleteSetting(db, SIMPLEFIN_ACCESS_URL)
  deleteSetting(db, SIMPLEFIN_CONNECTED_AT)
}
