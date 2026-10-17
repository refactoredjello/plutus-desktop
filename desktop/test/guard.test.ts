import { describe, expect, it } from 'vitest'
import { newGuardToken } from '../src/lib/guard.js'

describe('newGuardToken', () => {
  it('is 32 random bytes in base64url, safe as a cookie value', () => {
    const token = newGuardToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)
  })

  it('is different on every launch', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => newGuardToken()))
    expect(tokens.size).toBe(50)
  })

  it('encodes the bytes it is given', () => {
    const bytes = Buffer.alloc(32, 0xfb)
    expect(newGuardToken(() => bytes)).toBe(bytes.toString('base64url'))
  })
})
