import { describe, expect, it } from 'vitest'
import { shouldOpenDevTools } from '../src/lib/devtools.js'

describe('shouldOpenDevTools', () => {
  it('opens the DevTools panel in a dev build when PLUTUS_DEVTOOLS=1', () => {
    expect(shouldOpenDevTools({ isPackaged: false, env: { PLUTUS_DEVTOOLS: '1' } })).toBe(true)
  })

  it('ignores PLUTUS_DEVTOOLS in a packaged build', () => {
    expect(shouldOpenDevTools({ isPackaged: true, env: { PLUTUS_DEVTOOLS: '1' } })).toBe(false)
  })

  it('stays closed when the variable is unset or anything but 1', () => {
    for (const value of [undefined, '', '0', 'true', 'yes']) {
      expect(shouldOpenDevTools({ isPackaged: false, env: { PLUTUS_DEVTOOLS: value } })).toBe(false)
    }
  })
})
