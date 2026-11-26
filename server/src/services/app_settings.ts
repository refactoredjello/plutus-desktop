/**
 * Key/value app settings with optional encryption of values, plus the SimpleFIN connection
 * logic (routes stay thin).
 *
 * Encryption goes through the SecretStore. With KeySecretStore the
 * key is derived from PLUTUS_SECRET_KEY, so rotating it invalidates stored secrets. A store
 * may explain an unreadable secret itself (undecryptableReason).
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { appSettings } from '../db/schema.js'
import { utcNow } from '../lib/dates.js'
import { DomainError } from '../lib/errors.js'
import { SecretDecryptError, type SecretStore } from '../secrets.js'

export const SIMPLEFIN_ACCESS_URL = 'simplefin_access_url'
export const SIMPLEFIN_CONNECTED_AT = 'simplefin_connected_at'

/** The headless server's key is PLUTUS_SECRET_KEY (or SECRET_KEY); wording kept from Python. */
const HEADLESS_UNDECRYPTABLE = 'SECRET_KEY has changed. Reconnect.'

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
        `Stored setting '${key}' cannot be decrypted; ${secrets.undecryptableReason ?? HEADLESS_UNDECRYPTABLE}`,
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

/**
 * Connected means an access URL is stored. It is never decrypted here (backlog 13): an
 * unreadable secret (Keychain denied, key changed) still reports connected, and the sync that
 * needs it reports the problem.
 */
export function simplefinStatus(db: Db, secrets: SecretStore): SimpleFINStatus {
  const stored = db.select().from(appSettings).where(eq(appSettings.key, SIMPLEFIN_ACCESS_URL)).get()
  const connected = stored !== undefined && stored.value !== ''
  const stamp = getSetting(db, secrets, SIMPLEFIN_CONNECTED_AT)
  return {
    connected,
    // Any ISO stamp, written back as the same instant in the server's format.
    connected_at: connected && stamp ? new Date(stamp).toISOString() : null,
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
