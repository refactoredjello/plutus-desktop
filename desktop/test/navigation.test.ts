import { describe, expect, it } from 'vitest'
import { classifyNavigation } from '../src/lib/navigation.js'

const origin = 'http://127.0.0.1:51234'

describe('classifyNavigation', () => {
  it('keeps the app origin inside the window', () => {
    expect(classifyNavigation(`${origin}/`, origin)).toBe('app')
    expect(classifyNavigation(`${origin}/transactions?month=2026-09#top`, origin)).toBe('app')
  })

  it('sends web and mail links to the system browser', () => {
    expect(classifyNavigation('https://bridge.simplefin.org/simplefin/create', origin)).toBe('external')
    expect(classifyNavigation('http://example.com/', origin)).toBe('external')
    expect(classifyNavigation('mailto:someone@example.com', origin)).toBe('external')
  })

  it('treats another loopback port or host name as outside the app', () => {
    expect(classifyNavigation('http://127.0.0.1:8000/', origin)).toBe('external')
    expect(classifyNavigation('http://localhost:51234/', origin)).toBe('external')
  })

  it('blocks every other scheme and anything unparseable', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'not a url', '']) {
      expect(classifyNavigation(url, origin)).toBe('block')
    }
  })
})
