import { describe, expect, it } from 'vitest'
import { KeySecretStore, SecretDecryptError, type SecretStore } from '../src/secrets.js'

const ACCESS_URL = 'https://user123:pass456@bridge.example/simplefin'

describe('KeySecretStore', () => {
  const store: SecretStore = new KeySecretStore('test-secret-key')

  it('round-trips a value', () => {
    expect(store.decrypt(store.encrypt(ACCESS_URL))).toBe(ACCESS_URL)
  })

  it('round-trips empty and non-ASCII values', () => {
    expect(store.decrypt(store.encrypt(''))).toBe('')
    expect(store.decrypt(store.encrypt('café ✓ 日本'))).toBe('café ✓ 日本')
  })

  it('never stores the plain text', () => {
    const blob = store.encrypt(ACCESS_URL)
    expect(blob).not.toContain('pass456')
    expect(blob).not.toContain('bridge.example')
  })

  it('uses a fresh nonce per encryption', () => {
    expect(store.encrypt(ACCESS_URL)).not.toBe(store.encrypt(ACCESS_URL))
  })

  it('produces a text blob that fits app_settings.value', () => {
    expect(store.encrypt(ACCESS_URL)).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('decrypts with a second store built from the same key', () => {
    expect(new KeySecretStore('test-secret-key').decrypt(store.encrypt('x'))).toBe('x')
  })

  it('refuses to decrypt with a different key', () => {
    const blob = store.encrypt(ACCESS_URL)
    expect(() => new KeySecretStore('another-key').decrypt(blob)).toThrow(SecretDecryptError)
  })

  it('refuses a tampered blob', () => {
    const blob = store.encrypt(ACCESS_URL)
    const i = 20
    const swapped = blob[i] === 'A' ? 'B' : 'A'
    expect(() => store.decrypt(blob.slice(0, i) + swapped + blob.slice(i + 1))).toThrow(
      SecretDecryptError,
    )
  })

  it('refuses garbage', () => {
    expect(() => store.decrypt('not a blob')).toThrow(SecretDecryptError)
    expect(() => store.decrypt('')).toThrow(SecretDecryptError)
  })

  it('refuses an empty key', () => {
    expect(() => new KeySecretStore('')).toThrow()
  })
})
