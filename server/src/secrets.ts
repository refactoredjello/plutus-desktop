/**
 * Encryption of secret app settings (the SimpleFIN access URL, the Anthropic API key).
 *
 * Ports the encryption half of app/services/app_settings.py. Python used Fernet with a key
 * derived as SHA-256(SECRET_KEY); the port uses AES-256-GCM with the same derivation
 * (plan section 5.7). The desktop app supplies its own store over Electron's safeStorage.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export interface SecretStore {
  encrypt(plain: string): string
  decrypt(blob: string): string
}

/** The blob cannot be decrypted: wrong key, or not a blob this store wrote. */
export class SecretDecryptError extends Error {
  constructor(message = 'Secret cannot be decrypted') {
    super(message)
    this.name = 'SecretDecryptError'
  }
}

const IV_BYTES = 12
const TAG_BYTES = 16

/** AES-256-GCM keyed by SHA-256 of a secret string. Blob: base64url(iv | ciphertext | tag). */
export class KeySecretStore implements SecretStore {
  readonly #key: Buffer

  constructor(secretKey: string) {
    if (!secretKey) throw new Error('A secret key is required')
    this.#key = createHash('sha256').update(secretKey, 'utf8').digest()
  }

  encrypt(plain: string): string {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv)
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url')
  }

  decrypt(blob: string): string {
    const raw = Buffer.from(blob, 'base64url')
    if (raw.length < IV_BYTES + TAG_BYTES || raw.toString('base64url') !== blob) {
      throw new SecretDecryptError()
    }
    const iv = raw.subarray(0, IV_BYTES)
    const tag = raw.subarray(raw.length - TAG_BYTES)
    const body = raw.subarray(IV_BYTES, raw.length - TAG_BYTES)
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
    } catch {
      throw new SecretDecryptError()
    }
  }
}
