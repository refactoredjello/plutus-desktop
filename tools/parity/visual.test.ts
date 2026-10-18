import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { ROUTES, diffBands, fileName, fixedClockScript, pixelDiff, seedSteps } from './visual/compare.ts'

describe('ROUTES', () => {
  it('has every route the web router registers, once', () => {
    const paths = ROUTES.map((r) => r.path)
    for (const p of ['/', '/month', '/transactions', '/review', '/spending', '/recurring', '/goals', '/planned', '/settings']) {
      expect(paths).toContain(p)
    }
    expect(paths.some((p) => /^\/month\/\d{4}-\d{2}$/.test(p))).toBe(true)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('matches every path in web/src/app/router.tsx', () => {
    const router = readFileSync(new URL('../../web/src/app/router.tsx', import.meta.url), 'utf8')
    const registered = [...router.matchAll(/path: '([^']+)'/g)].map((m) => `/${m[1]}`)
    expect(registered.length).toBeGreaterThan(5)
    for (const r of registered) {
      const pattern = new RegExp(`^${r.replace(/:[a-z]+/g, '[^/]+')}$`)
      expect(ROUTES.some((route) => pattern.test(route.path))).toBe(true)
    }
  })

  it('gives each route a distinct file name', () => {
    const names = ROUTES.map((r) => fileName(r.path))
    expect(new Set(names).size).toBe(names.length)
    expect(fileName('/')).toBe('overview')
    expect(fileName('/month/2026-08')).toBe('month-2026-08')
    for (const n of names) expect(n).toMatch(/^[a-z0-9-]+$/)
  })
})

/** A 2x2 BGRA bitmap from four [b, g, r, a] pixels. */
const bitmap = (...pixels: number[][]) => Uint8Array.from(pixels.flat())

describe('pixelDiff', () => {
  const white = [255, 255, 255, 255]
  const black = [0, 0, 0, 255]
  const nearWhite = [250, 250, 250, 255]

  it('finds no difference in equal bitmaps or below the threshold', () => {
    const a = bitmap(white, white, black, black)
    expect(pixelDiff(a, a, 2, 2).differing).toBe(0)
    expect(pixelDiff(a, bitmap(nearWhite, white, black, black), 2, 2).differing).toBe(0)
  })

  it('counts differing pixels and marks them red in the diff image', () => {
    const a = bitmap(white, white, black, black)
    const b = bitmap(white, black, black, white)
    const d = pixelDiff(a, b, 2, 2)
    expect(d.differing).toBe(2)
    expect(d.total).toBe(4)
    // BGRA red at the differing pixels.
    expect([...d.image.slice(4, 8)]).toEqual([0, 0, 255, 255])
    expect([...d.image.slice(12, 16)]).toEqual([0, 0, 255, 255])
    expect(d.rows).toEqual([0, 1])
  })
})

describe('diffBands', () => {
  it('merges differing rows into bands, joining gaps up to the tolerance', () => {
    expect(diffBands([], 10)).toEqual([])
    expect(diffBands([3, 4, 5, 9, 30, 31], 5)).toEqual([
      { top: 3, bottom: 9 },
      { top: 30, bottom: 31 },
    ])
  })
})

describe('fixedClockScript', () => {
  it('makes new Date() and Date.now() start at the fixed instant, leaving explicit dates alone', () => {
    const script = fixedClockScript('2026-09-30T12:00:00Z')
    const result = runInNewContext(
      `${script}; ({ now: Date.now(), made: new Date().toISOString(), explicit: new Date(0).toISOString(), parsed: Date.parse('2020-01-01T00:00:00Z'), isDate: new Date() instanceof Date, utc: Date.UTC(2020, 0, 1) })`,
      { Date },
    ) as Record<string, unknown>
    const fixed = Date.parse('2026-09-30T12:00:00Z')
    expect(result.now as number).toBeGreaterThanOrEqual(fixed)
    expect(result.now as number).toBeLessThan(fixed + 5000)
    expect((result.made as string).slice(0, 13)).toBe('2026-09-30T12')
    expect(result.explicit).toBe('1970-01-01T00:00:00.000Z')
    expect(result.parsed).toBe(Date.parse('2020-01-01T00:00:00Z'))
    expect(result.isDate).toBe(true)
    expect(result.utc).toBe(Date.UTC(2020, 0, 1))
  })
})

describe('seedSteps', () => {
  it('gives both apps the same goal, planned entries, and confirmed recurrence', () => {
    const steps = seedSteps('2026-09-30')
    const paths = steps.map((s) => `${s.method} ${s.path}`)
    expect(paths).toContain('POST /api/goals')
    expect(paths.filter((p) => p === 'POST /api/manual-entries')).toHaveLength(2)
    expect(steps.some((s) => s.confirmFirstProposed === true)).toBe(true)
  })
})
