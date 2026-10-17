import { describe, expect, it } from 'vitest'
import type { Schemas } from '@/api/client'
import { topCategories } from './data'

const row = (category_id: number | null, label: string, total: string): Schemas['CategoryTotal'] => ({
  category_id,
  label,
  primary: null,
  total,
  count: 1,
})

describe('topCategories', () => {
  it('keeps a real "Other" category distinct from the folded remainder', () => {
    const rows = [
      row(1, 'Rent', '2000.00'),
      row(127, 'Other', '191.33'),
      row(null, 'Uncategorized', '40.00'),
      row(4, 'Coffee', '30.00'),
      row(5, 'Gas', '20.00'),
    ]
    const out = topCategories(rows, '2026-08', 2)
    expect(out.map((r) => r.label)).toEqual(['Rent', 'Other', '3 more categories'])
    expect(out[1]!.href).toBe('/transactions?category=127&start=2026-08-01&end=2026-08-31')
    expect(out[2]!.href).toBeNull()
    expect(new Set(out.map((r) => r.key)).size).toBe(out.length)
  })

  it('links Uncategorized to transactions with no category', () => {
    const out = topCategories([row(null, 'Uncategorized', '40.00')], '2026-08')
    expect(out[0]!.href).toBe('/transactions?uncategorized=1&start=2026-08-01&end=2026-08-31')
    expect(out[0]!.muted).toBe(true)
  })
})
