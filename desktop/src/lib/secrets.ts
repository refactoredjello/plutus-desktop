/**
 * The desktop SecretStore (plan section 5.7): secrets are encrypted by the OS through
 * Electron's safeStorage (the Keychain on macOS, DPAPI on Windows, libsecret on Linux).
 * Blobs are base64 of safeStorage's output. Error messages never include the secret.
 */

import { SecretDecryptError, type SecretStore } from 'plutus-server/secrets'

/** The part of Electron's safeStorage this store uses; injected so it can be tested. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

const UNAVAILABLE = 'OS encryption is not available'

export class OsEncryptionUnavailableError extends Error {
  constructor() {
    super(`${UNAVAILABLE}; refusing to store secrets in plain text`)
    this.name = 'OsEncryptionUnavailableError'
  }
}

export class SafeStorageSecretStore implements SecretStore {
  readonly #safeStorage: SafeStorageLike

  /** Touches nothing until a secret is used, so launching never prompts for the Keychain. */
  constructor(safeStorage: SafeStorageLike) {
    this.#safeStorage = safeStorage
  }

  encrypt(plain: string): string {
    if (!this.#safeStorage.isEncryptionAvailable()) throw new OsEncryptionUnavailableError()
    let encrypted: Buffer
    try {
      encrypted = this.#safeStorage.encryptString(plain)
    } catch {
      throw new Error('OS encryption failed')
    }
    return encrypted.toString('base64')
  }

  /** Every failure is a SecretDecryptError, which the settings service reports as a 400. */
  decrypt(blob: string): string {
    if (!this.#safeStorage.isEncryptionAvailable()) throw new SecretDecryptError(UNAVAILABLE)
    const raw = Buffer.from(blob, 'base64')
    if (raw.length === 0 || raw.toString('base64') !== blob) throw new SecretDecryptError()
    try {
      return this.#safeStorage.decryptString(raw)
    } catch {
      throw new SecretDecryptError()
    }
  }
}
