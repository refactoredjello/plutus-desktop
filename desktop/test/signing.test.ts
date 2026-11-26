import { describe, expect, it } from 'vitest'
import { macSigning } from '../src/lib/signing.js'

describe('macSigning', () => {
  it('signs ad hoc when no identity is configured, so the build still runs and verifies', () => {
    expect(macSigning({})).toEqual({ identity: '-', hardenedRuntime: false, notarize: false })
  })

  it('treats blank variables as absent', () => {
    expect(macSigning({ CSC_LINK: '', CSC_NAME: '  ' })).toEqual({
      identity: '-',
      hardenedRuntime: false,
      notarize: false,
    })
  })

  it('never notarizes an ad hoc build, even with Apple credentials set', () => {
    const env = { APPLE_ID: 'a@example.test', APPLE_APP_SPECIFIC_PASSWORD: 'x', APPLE_TEAM_ID: 'T' }
    expect(macSigning(env).notarize).toBe(false)
    expect(macSigning(env).identity).toBe('-')
  })

  const certificates = [{ CSC_LINK: '/secure/developer-id.p12' }, { CSC_NAME: 'Plutus Local Signing' }]
  const appleId = { APPLE_ID: 'a@example.test', APPLE_APP_SPECIFIC_PASSWORD: 'x', APPLE_TEAM_ID: 'T' }
  const apiKey = { APPLE_API_KEY: '/secure/key.p8', APPLE_API_KEY_ID: 'K', APPLE_API_ISSUER: 'I' }

  it('signs with a certificate alone (a self-signed one) under the hardened runtime, not notarized', () => {
    for (const env of certificates) {
      const signing = macSigning(env)
      expect(signing).toEqual({ hardenedRuntime: true, notarize: false })
      expect('identity' in signing).toBe(false)
    }
  })

  it('notarizes a certificate build when a full set of Apple credentials is present', () => {
    for (const cert of certificates) {
      for (const creds of [appleId, apiKey]) {
        expect(macSigning({ ...cert, ...creds })).toEqual({ hardenedRuntime: true, notarize: true })
      }
    }
  })

  it('does not notarize with a partial or blank set of Apple credentials', () => {
    for (const creds of [appleId, apiKey]) {
      for (const missing of Object.keys(creds)) {
        const partial = { ...creds, [missing]: undefined }
        const blank = { ...creds, [missing]: ' ' }
        expect(macSigning({ CSC_NAME: 'Plutus Local Signing', ...partial }).notarize).toBe(false)
        expect(macSigning({ CSC_NAME: 'Plutus Local Signing', ...blank }).notarize).toBe(false)
      }
    }
    // Half of each set is not a set.
    const mixed = { APPLE_ID: 'a@example.test', APPLE_API_KEY_ID: 'K', APPLE_TEAM_ID: 'T', APPLE_API_ISSUER: 'I' }
    expect(macSigning({ CSC_NAME: 'Plutus Local Signing', ...mixed }).notarize).toBe(false)
  })

  it('never notarizes an ad hoc build, even with the API key set', () => {
    expect(macSigning(apiKey)).toEqual({ identity: '-', hardenedRuntime: false, notarize: false })
  })
})
