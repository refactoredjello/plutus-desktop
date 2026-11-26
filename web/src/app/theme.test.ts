import { afterEach, describe, expect, it } from 'vitest'
import { followSystemTheme, setThemePreference } from './theme'

/** A media query list whose answer the test flips, notifying listeners like a browser. */
function fakeQuery(matches: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>()
  return {
    matches,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => listeners.add(l),
    removeEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => listeners.delete(l),
    flip(next: boolean) {
      this.matches = next
      listeners.forEach((l) => l({ matches: next } as MediaQueryListEvent))
    },
    get listeners() {
      return listeners.size
    },
  }
}

describe('followSystemTheme', () => {
  const root = document.documentElement
  afterEach(() => {
    root.classList.remove('dark')
    delete root.dataset.theme
  })

  it('adds dark when the system is dark and follows changes live', () => {
    const query = fakeQuery(true)
    const stop = followSystemTheme(root, query as unknown as MediaQueryList)
    expect(root).toHaveClass('dark')
    query.flip(false)
    expect(root).not.toHaveClass('dark')
    query.flip(true)
    expect(root).toHaveClass('dark')
    stop()
    expect(query.listeners).toBe(0)
  })

  it('stays light when the system is light', () => {
    followSystemTheme(root, fakeQuery(false) as unknown as MediaQueryList)
    expect(root).not.toHaveClass('dark')
  })

  it('keeps a chosen light or dark whatever the system does, and follows it again on system', () => {
    const query = fakeQuery(true)
    followSystemTheme(root, query as unknown as MediaQueryList)
    setThemePreference('light', root, query as unknown as MediaQueryList)
    expect(root).not.toHaveClass('dark')
    expect(root.dataset.theme).toBe('light')
    query.flip(true)
    expect(root).not.toHaveClass('dark')
    setThemePreference('dark', root, query as unknown as MediaQueryList)
    query.flip(false)
    expect(root).toHaveClass('dark')
    setThemePreference('system', root, query as unknown as MediaQueryList)
    expect(root).not.toHaveClass('dark')
    expect(root.dataset.theme).toBeUndefined()
    query.flip(true)
    expect(root).toHaveClass('dark')
  })

  it('starts from the theme the server wrote on the page', () => {
    root.dataset.theme = 'dark'
    followSystemTheme(root, fakeQuery(false) as unknown as MediaQueryList)
    expect(root).toHaveClass('dark')
  })
})
