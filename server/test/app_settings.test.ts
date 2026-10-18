/**
 * App settings: encryption round trip (never stored in plain text), and the SimpleFIN
 * connection logic, which lives in the service so the route stays thin.
 */

import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { Db } from '../src/db/index.js'
import { appSettings } from '../src/db/schema.js'
import { DomainError } from '../src/lib/errors.js'
import { KeySecretStore } from '../src/secrets.js'
import {
  SIMPLEFIN_ACCESS_URL,
  SIMPLEFIN_CONNECTED_AT,
  connectSimplefin,
  deleteSetting,
  disconnectSimplefin,
  getSetting,
  setSetting,
  simplefinStatus,
} from '../src/services/app_settings.js'
import { ACCESS_URL } from './factories.js'
import { makeDb } from './setup.js'

// A fixed test key.
const secrets = new KeySecretStore('test-secret')

function row(db: Db, key: string) {
  return db.select().from(appSettings).where(eq(appSettings.key, key)).get()
}

describe('app settings', () => {
  it('round-trips an encrypted value and never stores the plain text', () => {
    const db = makeDb()
    setSetting(db, secrets, SIMPLEFIN_ACCESS_URL, ACCESS_URL, { encrypt: true })
    const stored = row(db, SIMPLEFIN_ACCESS_URL)
    expect(stored).toBeDefined()
    expect(stored?.is_encrypted).toBe(true)
    expect(stored?.value).not.toContain('pass456')
    expect(stored?.value).not.toContain('bridge.example')
    const raw = db.$client.prepare('select value from app_settings').pluck().get() as string
    expect(raw).not.toContain('pass456')
    expect(getSetting(db, secrets, SIMPLEFIN_ACCESS_URL)).toBe(ACCESS_URL)
    deleteSetting(db, SIMPLEFIN_ACCESS_URL)
    expect(getSetting(db, secrets, SIMPLEFIN_ACCESS_URL)).toBeNull()
  })

  it('stores a plain value as is', () => {
    const db = makeDb()
    setSetting(db, secrets, 'k', 'v')
    expect(row(db, 'k')).toMatchObject({ value: 'v', is_encrypted: false })
    expect(getSetting(db, secrets, 'k')).toBe('v')
  })

  it('returns null for a missing key', () => {
    expect(getSetting(makeDb(), secrets, 'missing')).toBeNull()
  })

  it('overwrites an existing row, value and encryption flag', () => {
    const db = makeDb()
    setSetting(db, secrets, 'k', 'secret', { encrypt: true })
    setSetting(db, secrets, 'k', 'plain')
    expect(row(db, 'k')).toMatchObject({ value: 'plain', is_encrypted: false })
    setSetting(db, secrets, 'k', 'again', { encrypt: true })
    expect(row(db, 'k')?.is_encrypted).toBe(true)
    expect(getSetting(db, secrets, 'k')).toBe('again')
    expect(db.select().from(appSettings).all()).toHaveLength(1)
  })

  it('deleting a missing key is a no-op', () => {
    expect(() => deleteSetting(makeDb(), 'missing')).not.toThrow()
  })

  it('raises a DomainError naming the key when the secret key has changed', () => {
    const db = makeDb()
    setSetting(db, secrets, SIMPLEFIN_ACCESS_URL, ACCESS_URL, { encrypt: true })
    const rotated = new KeySecretStore('another-secret')
    let error: unknown
    try {
      getSetting(db, rotated, SIMPLEFIN_ACCESS_URL)
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(DomainError)
    expect((error as DomainError).status).toBe(400)
    expect((error as DomainError).detail).toBe(
      "Stored setting 'simplefin_access_url' cannot be decrypted; SECRET_KEY has changed. Reconnect.",
    )
    expect((error as DomainError).detail).not.toContain('pass456')
  })

  it("uses the store's own explanation when it has one", () => {
    const db = makeDb()
    setSetting(db, secrets, SIMPLEFIN_ACCESS_URL, ACCESS_URL, { encrypt: true })
    const store = Object.assign(new KeySecretStore('another-secret'), {
      undecryptableReason: 'the OS key changed. Reconnect.',
    })
    expect(() => getSetting(db, store, SIMPLEFIN_ACCESS_URL)).toThrow(
      "Stored setting 'simplefin_access_url' cannot be decrypted; the OS key changed. Reconnect.",
    )
  })
})

describe('SimpleFIN connection', () => {
  it('reports disconnected on an empty database', () => {
    expect(simplefinStatus(makeDb(), secrets)).toEqual({ connected: false, connected_at: null })
  })

  it('claims the token, stores the access URL encrypted, and stamps the connection', async () => {
    const db = makeDb()
    const claimed: string[] = []
    const before = new Date().toISOString()
    const status = await connectSimplefin(db, secrets, 'setup-token', async (token) => {
      claimed.push(token)
      return ACCESS_URL
    })
    expect(claimed).toEqual(['setup-token'])
    expect(status.connected).toBe(true)
    expect(status.connected_at).not.toBeNull()
    expect(status.connected_at! >= before).toBe(true)
    expect(JSON.stringify(status)).not.toContain('pass456')
    expect(row(db, SIMPLEFIN_ACCESS_URL)?.is_encrypted).toBe(true)
    expect(row(db, SIMPLEFIN_ACCESS_URL)?.value).not.toContain('pass456')
    expect(row(db, SIMPLEFIN_CONNECTED_AT)).toMatchObject({
      value: status.connected_at,
      is_encrypted: false,
    })
    expect(getSetting(db, secrets, SIMPLEFIN_ACCESS_URL)).toBe(ACCESS_URL)
    expect(simplefinStatus(db, secrets)).toEqual(status)
  })

  it('stores nothing when the claim fails', async () => {
    const db = makeDb()
    const failing = async (): Promise<string> => {
      throw new DomainError('bad token')
    }
    await expect(connectSimplefin(db, secrets, 'x', failing)).rejects.toThrow('bad token')
    expect(db.select().from(appSettings).all()).toEqual([])
  })

  it('reports a stored stamp with microseconds and an offset as a UTC instant in milliseconds', () => {
    const db = makeDb()
    setSetting(db, secrets, SIMPLEFIN_ACCESS_URL, ACCESS_URL, { encrypt: true })
    // A stamp with microseconds and an explicit offset.
    setSetting(db, secrets, SIMPLEFIN_CONNECTED_AT, '2026-03-04T05:06:07.123456+00:00')
    expect(simplefinStatus(db, secrets)).toEqual({
      connected: true,
      connected_at: '2026-03-04T05:06:07.123Z',
    })
  })

  it('has no stamp without an access URL, and none when the stamp is missing', () => {
    const db = makeDb()
    setSetting(db, secrets, SIMPLEFIN_CONNECTED_AT, '2026-03-04T05:06:07.000Z')
    expect(simplefinStatus(db, secrets)).toEqual({ connected: false, connected_at: null })
    deleteSetting(db, SIMPLEFIN_CONNECTED_AT)
    setSetting(db, secrets, SIMPLEFIN_ACCESS_URL, ACCESS_URL, { encrypt: true })
    expect(simplefinStatus(db, secrets)).toEqual({ connected: true, connected_at: null })
  })

  it('disconnects by deleting both rows', async () => {
    const db = makeDb()
    await connectSimplefin(db, secrets, 't', async () => ACCESS_URL)
    setSetting(db, secrets, 'other', 'kept')
    disconnectSimplefin(db)
    expect(simplefinStatus(db, secrets)).toEqual({ connected: false, connected_at: null })
    expect(db.select().from(appSettings).all().map((r) => r.key)).toEqual(['other'])
  })
})
