/**
 * Pure helpers for the page-by-page visual comparison (capture.ts runs them in Electron).
 * Unit-tested in ../visual.test.ts.
 */

export interface Route {
  path: string
  /** Text the page shows once its data has loaded; capture waits for it. */
  ready?: string
}

/** Every route in web/src/app/router.tsx; `month/:month` as a month with data. */
export const ROUTES: readonly Route[] = [
  { path: '/' },
  { path: '/month' },
  { path: '/month/2026-08' },
  { path: '/transactions' },
  { path: '/review' },
  { path: '/spending' },
  { path: '/recurring' },
  { path: '/goals' },
  { path: '/planned' },
  { path: '/settings' },
]

export function fileName(path: string): string {
  const bare = (path.split('?')[0] ?? path).replace(/^\/+|\/+$/g, '')
  return bare === '' ? 'overview' : bare.replaceAll('/', '-').toLowerCase()
}

export interface PixelDiff {
  differing: number
  total: number
  /** BGRA, same size as the inputs: differing pixels red, the rest a faded copy of `a`. */
  image: Uint8Array
  /** Rows (y) with at least one differing pixel, ascending. */
  rows: number[]
}

/** Compare two BGRA bitmaps of `width` x `height`; a channel must differ by more than `threshold`. */
export function pixelDiff(a: Uint8Array, b: Uint8Array, width: number, height: number, threshold = 24): PixelDiff {
  const image = new Uint8Array(width * height * 4)
  const rows: number[] = []
  let differing = 0
  for (let y = 0; y < height; y++) {
    let rowDiffers = false
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      let differs = false
      for (let c = 0; c < 3; c++) {
        if (Math.abs((a[i + c] ?? 0) - (b[i + c] ?? 0)) > threshold) differs = true
      }
      if (differs) {
        differing += 1
        rowDiffers = true
        image.set([0, 0, 255, 255], i)
      } else {
        const v = ((a[i] ?? 0) + (a[i + 1] ?? 0) + (a[i + 2] ?? 0)) / 3
        const faded = Math.round(255 - (255 - v) * 0.3)
        image.set([faded, faded, faded, 255], i)
      }
    }
    if (rowDiffers) rows.push(y)
  }
  return { differing, total: width * height, image, rows }
}

/** Merge differing rows into bands; rows at most `gap` apart join one band. */
export function diffBands(rows: readonly number[], gap: number): { top: number; bottom: number }[] {
  const bands: { top: number; bottom: number }[] = []
  for (const y of rows) {
    const last = bands.at(-1)
    if (last !== undefined && y - last.bottom <= gap) last.bottom = y
    else bands.push({ top: y, bottom: y })
  }
  return bands
}

/**
 * Page script that starts the browser clock at `iso` (the frontend reads the current month
 * from `new Date()`), so both apps render as of PLUTUS_TODAY. Explicit dates are untouched.
 */
export function fixedClockScript(iso: string): string {
  return `(() => {
  const RealDate = Date
  const offset = RealDate.parse(${JSON.stringify(iso)}) - RealDate.now()
  function FixedDate(...args) {
    if (!new.target) return new RealDate(RealDate.now() + offset).toString()
    return args.length === 0 ? new RealDate(RealDate.now() + offset) : new RealDate(...args)
  }
  FixedDate.prototype = RealDate.prototype
  FixedDate.now = () => RealDate.now() + offset
  FixedDate.parse = RealDate.parse
  FixedDate.UTC = RealDate.UTC
  globalThis.Date = FixedDate
})()`
}

export interface SeedStep {
  method: 'POST' | 'PATCH'
  path: string
  body?: Record<string, unknown>
  /** PATCH the first proposed recurrence (path is a placeholder). */
  confirmFirstProposed?: boolean
  /** Path holds `{goal}`, replaced by the id the first goal POST returned. */
  usesGoal?: boolean
}

const day = (today: string, days: number) =>
  new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

/** The same requests on both apps before capture, so Goals, Planned, and Recurring have data. */
export function seedSteps(today: string): SeedStep[] {
  return [
    { method: 'POST', path: '/api/goals', body: { name: 'Emergency fund', target_amount: '6000.00', target_date: day(today, 365) } },
    {
      method: 'POST',
      path: '/api/manual-entries',
      body: { amount: '-180.00', description: 'Car registration', due_date: day(today, 14), recurrence: 'none' },
    },
    {
      method: 'POST',
      path: '/api/manual-entries',
      body: { amount: '250.00', description: 'Side income', due_date: day(today, 5), recurrence: 'monthly', end_date: day(today, 120) },
    },
    { method: 'PATCH', path: '/api/recurring/{first proposed}', body: { status: 'confirmed' }, confirmFirstProposed: true },
    { method: 'POST', path: '/api/goals/{goal}/suggestions', usesGoal: true },
  ]
}
