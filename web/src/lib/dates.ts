/** Calendar helpers on YYYY-MM-DD / YYYY-MM strings, in local time so API dates never shift by time zone. */
const pad = (n: number) => String(n).padStart(2, '0')

export const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const monthKey = (d: Date) => isoDate(d).slice(0, 7)

export function parseDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y!, m! - 1, d ?? 1)
}

export function addMonths(key: string, n: number): string {
  const [y, m] = key.split('-').map(Number)
  return monthKey(new Date(y!, m! - 1 + n, 1))
}

export const monthStart = (key: string) => `${key.slice(0, 7)}-01`

export function monthEnd(key: string): string {
  const [y, m] = key.split('-').map(Number)
  return isoDate(new Date(y!, m!, 0))
}

export function monthLabel(key: string, style: 'short' | 'long' = 'short'): string {
  const [y, m] = key.split('-').map(Number)
  return new Date(y!, m! - 1, 1).toLocaleDateString('en-US',
    style === 'short' ? { month: 'short' } : { month: 'long', year: 'numeric' })
}
