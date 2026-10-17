import { useCallback } from 'react'
import { useSearchParams } from 'react-router'
import type { Schemas } from '@/api/client'

export const PAGE_SIZE = 50

export interface Filters {
  q: string
  start: string
  end: string
  account: string
  category: string
  essentiality: '' | Schemas['EssentialityFilter']
  /** Spending with no category at all. */
  uncategorized: boolean
  review: boolean
  transfers: boolean
  page: number
}

const essentialities = ['essential', 'flexible', 'discretionary', 'unset']

export const emptyFilters: Filters = {
  q: '',
  start: '',
  end: '',
  account: '',
  category: '',
  essentiality: '',
  uncategorized: false,
  review: false,
  transfers: false,
  page: 1,
}

function parse(p: URLSearchParams): Filters {
  const ess = p.get('essentiality') ?? ''
  return {
    q: p.get('q') ?? '',
    start: p.get('start') ?? '',
    end: p.get('end') ?? '',
    account: p.get('account') ?? '',
    category: p.get('category') ?? '',
    essentiality: essentialities.includes(ess) ? (ess as Filters['essentiality']) : '',
    uncategorized: p.get('uncategorized') === '1',
    review: p.get('review') === '1',
    transfers: p.get('transfers') === '1',
    page: Math.max(1, Number(p.get('page')) || 1),
  }
}

/** Filter state lives in the URL search params so it survives reload and can be shared. */
export function useFilters() {
  const [params, setParams] = useSearchParams()
  const filters = parse(params)

  const update = useCallback(
    (patch: Partial<Filters>) => {
      setParams(
        (prev) => {
          const next = { ...parse(prev), ...patch }
          if (!('page' in patch)) next.page = 1
          const out = new URLSearchParams()
          for (const [key, value] of Object.entries(next)) {
            if (value === '' || value === false || (key === 'page' && value === 1)) continue
            out.set(key, value === true ? '1' : String(value))
          }
          return out
        },
        { replace: true },
      )
    },
    [setParams],
  )

  return [filters, update] as const
}

export const hasActiveFilters = (f: Filters) =>
  Boolean(f.q || f.start || f.end || f.account || f.category || f.essentiality || f.uncategorized || f.review || f.transfers)
