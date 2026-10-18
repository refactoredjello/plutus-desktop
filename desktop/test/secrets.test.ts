import { KeySecretStore, SecretDecryptError } from 'plutus-server/secrets'
import { describe, expect, it, vi } from 'vitest'
import { type SafeStorageLike, SafeStorageSecretStore } from '../src/lib/secrets.js'

const MAGIC = Buffer.from('fake-os-crypto:')

/** Stands in for Electron's safeStorage: reversible, and throws on blobs it did not write. */
function fakeSafeStorage(available = true) {
  const fake = {
    isEncryptionAvailable: vi.fn(() => available),
    encryptString: vi.fn((plain: string) =>
      Buffer.concat([MAGIC, Buffer.from(plain, 'utf8').map((b) => b ^ 0x5a)]),
    ),
    decryptString: vi.fn((blob: Buffer) => {
      if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Error while decrypting')
      return Buffer.from(blob.subarray(MAGIC.length).map((b) => b ^ 0x5a)).toString('utf8')
    }),
  }
  return fake satisfies SafeStorageLike
}

const accessUrl = 'https://user:pass@bridge.example.test/simplefin'

describe('SafeStorageSecretStore', () => {
  it('round-trips a secret through the OS store', () => {
    const store = new SafeStorageSecretStore(fakeSafeStorage())
    expect(store.decrypt(store.encrypt(accessUrl))).toBe(accessUrl)
    expect(store.decrypt(store.encrypt(''))).toBe('')
    expect(store.decrypt(store.encrypt('naïve ✓'))).toBe('naïve ✓')
  })

  it('stores a base64 string that does not contain the secret', () => {
    const blob = new SafeStorageSecretStore(fakeSafeStorage()).encrypt(accessUrl)
    expect(blob).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(blob).not.toContain('bridge.example.test')
    expect(Buffer.from(blob, 'base64').toString('utf8')).not.toContain('bridge.example.test')
  })

  it('does not touch the OS store until a secret is used', () => {
    const safeStorage = fakeSafeStorage()
    new SafeStorageSecretStore(safeStorage)
    expect(safeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
  })

  it('refuses to encrypt when OS encryption is unavailable, never storing plain text', () => {
    const safeStorage = fakeSafeStorage(false)
    const store = new SafeStorageSecretStore(safeStorage)
    expect(() => store.encrypt(accessUrl)).toThrow(/encryption is not available/i)
    expect(safeStorage.encryptString).not.toHaveBeenCalled()
  })

  // services/app_settings turns SecretDecryptError into a 400; any other error is a 500.
  it('raises SecretDecryptError when OS encryption is unavailable at decrypt time', () => {
    const blob = new SafeStorageSecretStore(fakeSafeStorage()).encrypt(accessUrl)
    const store = new SafeStorageSecretStore(fakeSafeStorage(false))
    expect(() => store.decrypt(blob)).toThrow(SecretDecryptError)
    expect(() => store.decrypt(blob)).toThrow(/encryption is not available/i)
  })

  it('raises SecretDecryptError, not the raw error, when safeStorage throws on decrypt', () => {
    const safeStorage = fakeSafeStorage()
    const store = new SafeStorageSecretStore(safeStorage)
    const blob = store.encrypt(accessUrl)
    safeStorage.decryptString.mockImplementation(() => {
      throw new TypeError('keychain locked')
    })
    expect(() => store.decrypt(blob)).toThrow(SecretDecryptError)
  })

  it('raises SecretDecryptError for a blob it did not write', () => {
    const store = new SafeStorageSecretStore(fakeSafeStorage())
    const foreign = new KeySecretStore('another-key').encrypt(accessUrl)
    expect(() => store.decrypt(foreign)).toThrow(SecretDecryptError)
    expect(() => store.decrypt('not base64 at all!')).toThrow(SecretDecryptError)
    expect(() => store.decrypt('')).toThrow(SecretDecryptError)
  })

  it('never puts the secret in an error message', () => {
    const safeStorage = fakeSafeStorage()
    safeStorage.encryptString.mockImplementation((plain: string) => {
      throw new Error(`keychain refused ${plain}`)
    })
    const store = new SafeStorageSecretStore(safeStorage)
    let message = ''
    try {
      store.encrypt(accessUrl)
    } catch (err) {
      message = String(err) + JSON.stringify(err)
    }
    expect(message).not.toBe('')
    expect(message).not.toContain('bridge.example.test')
  })
})
