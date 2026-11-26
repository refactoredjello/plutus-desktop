import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, unwrap, type Schemas } from '@/api/client'
import { isoDate } from '@/lib/dates'

export const useMonthly = () =>
  useQuery({
    queryKey: ['reports', 'monthly', 12],
    queryFn: () => unwrap(api.GET('/api/reports/monthly', { params: { query: { months: 12 } } })),
  })

export const useByCategory = (month: string, essentiality?: Schemas['EssentialityFilter']) =>
  useQuery({
    queryKey: ['reports', 'by-category', month, essentiality ?? null],
    queryFn: () => unwrap(api.GET('/api/reports/by-category', { params: { query: { month, essentiality } } })),
    placeholderData: keepPreviousData,
  })

export const useBalances = (days = 90) =>
  useQuery({
    queryKey: ['reports', 'balances', days],
    queryFn: () => {
      const end = new Date()
      const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - days)
      return unwrap(api.GET('/api/reports/balances', { params: { query: { start: isoDate(start), end: isoDate(end) } } }))
    },
  })

export const useProjection = () =>
  useQuery({
    queryKey: ['projection', 3],
    queryFn: () => unwrap(api.GET('/api/projection', { params: { query: { months: 3 } } })),
  })

const CHANGES_KEY = ['reports', 'changes'] as const

export const useChanges = (all = false) =>
  useQuery({
    queryKey: [...CHANGES_KEY, all],
    queryFn: () => unwrap(api.GET('/api/reports/changes', { params: { query: all ? { all: true } : {} } })),
    placeholderData: keepPreviousData,
  })

export function useDismissChange() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (key: string) => unwrap(api.POST('/api/reports/changes/dismiss', { body: { key } })),
    onMutate: async (key) => {
      await qc.cancelQueries({ queryKey: CHANGES_KEY })
      const previous = qc.getQueriesData<Schemas['ChangesRead']>({ queryKey: CHANGES_KEY })
      qc.setQueriesData<Schemas['ChangesRead']>({ queryKey: CHANGES_KEY }, (d) =>
        d && { ...d, items: d.items.filter((i) => i.key !== key) },
      )
      return { previous }
    },
    onError: (_e, _key, ctx) => ctx?.previous.forEach(([k, d]) => qc.setQueryData(k, d)),
    onSettled: () => qc.invalidateQueries({ queryKey: CHANGES_KEY }),
    meta: { errorTitle: 'Could not dismiss that change' },
  })
}

export function useClearDismissals() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => unwrap(api.DELETE('/api/reports/changes/dismissals')),
    onSuccess: () => qc.invalidateQueries({ queryKey: CHANGES_KEY }),
    meta: { errorTitle: 'Could not clear dismissed changes' },
  })
}
