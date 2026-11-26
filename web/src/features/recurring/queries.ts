import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, unwrap, type Schemas } from '@/api/client'
import { invalidateDerived } from '@/app/invalidate'

type Charge = Schemas['RecurringChargeRead']

export const useRecurring = () =>
  useQuery({ queryKey: ['recurring'], queryFn: () => unwrap(api.GET('/api/recurring')) })

/** PATCH a recurring charge. Optimistic so the row does not jump; rolls back on error. */
export function useUpdateRecurring() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: Schemas['RecurringChargeUpdate'] }) =>
      unwrap(api.PATCH('/api/recurring/{recurring_id}', { params: { path: { recurring_id: id } }, body })),
    onMutate: async ({ id, body }) => {
      await qc.cancelQueries({ queryKey: ['recurring'] })
      const previous = qc.getQueryData<Charge[]>(['recurring'])
      qc.setQueryData<Charge[]>(['recurring'], (list) =>
        list?.map((c) =>
          c.id === id
            ? {
                ...c,
                ...(body.status ? { status: body.status } : {}),
                ...(body.essentiality ? { essentiality: body.essentiality } : {}),
                ...(body.amount_varies != null ? { amount_varies: body.amount_varies } : {}),
              }
            : c,
        ),
      )
      return { previous }
    },
    onError: (_err, _vars, ctx) => qc.setQueryData(['recurring'], ctx?.previous),
    // Recurring flags feed the projection and What changed; settling refetches the list either way.
    onSettled: () => invalidateDerived(qc),
  })
}

/**
 * Annual totals over confirmed items (amounts are signed; outflows are negative), as positive numbers:
 * bills (`total`), the flexible or discretionary part of them, and income.
 */
export function annualSummary(charges: Charge[]) {
  let total = 0
  let flexible = 0
  let income = 0
  for (const c of charges) {
    const annual = Number(c.annual_cost)
    if (c.status !== 'confirmed') continue
    if (annual > 0) {
      income += annual
      continue
    }
    if (annual === 0) continue
    total += -annual
    if (c.essentiality === 'discretionary' || c.essentiality === 'flexible') flexible += -annual
  }
  return { total: total.toFixed(2), flexible: flexible.toFixed(2), income: income.toFixed(2) }
}

type Cadence = Schemas['Cadence']

export const CADENCES: { value: Cadence; label: string; phrase: string }[] = [
  { value: 'weekly', label: 'Weekly', phrase: 'weekly' },
  { value: 'biweekly', label: 'Every 2 weeks', phrase: 'every 2 weeks' },
  { value: 'semimonthly', label: 'Twice a month', phrase: 'twice a month' },
  { value: 'monthly', label: 'Monthly', phrase: 'monthly' },
  { value: 'yearly', label: 'Yearly', phrase: 'yearly' },
]

export const cadencePhrase = (c: Cadence) => CADENCES.find((x) => x.value === c)?.phrase ?? c

/** Confirm a transaction's merchant as a recurring charge (creates or updates it). */
export function useMarkRecurring() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Schemas['RecurringChargeCreate']) => unwrap(api.POST('/api/recurring', { body })),
    onSuccess: () => invalidateDerived(qc),
    // Shown in the open cadence popover, next to the choice that failed.
    meta: { inlineError: true },
  })
}

/** The confirmed recurring item for this merchant and account. Fetches only while `enabled` (e.g. a popover is open). */
export function useConfirmedRecurring(merchantKey: string | null, accountId: number, enabled: boolean) {
  const { data } = useQuery({
    queryKey: ['recurring'],
    queryFn: () => unwrap(api.GET('/api/recurring')),
    enabled,
  })
  if (!merchantKey) return undefined
  return data?.find((c) => c.status === 'confirmed' && c.merchant_key === merchantKey && c.account_id === accountId)
}
