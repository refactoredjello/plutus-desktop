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

  it('leaves the identity to electron-builder with a certificate, hardened and notarized', () => {
    for (const env of [{ CSC_LINK: '/secure/developer-id.p12' }, { CSC_NAME: 'Some Developer (TEAMID1234)' }]) {
      const signing = macSigning(env)
      expect(signing).toEqual({ hardenedRuntime: true, notarize: true })
      expect('identity' in signing).toBe(false)
    }
  })
})
