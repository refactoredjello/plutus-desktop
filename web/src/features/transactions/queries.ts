import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, unwrap, type Schemas } from '@/api/client'
import { invalidateDerived } from '@/app/invalidate'
import { PAGE_SIZE, type Filters } from './filters'

type Page = Schemas['Page_TransactionRead_']
type Update = Schemas['TransactionUpdate']
/** What callers send; the generated type also demands the rule defaults, which we fill in. Rules are saved through /api/rules. */
export type TransactionEdit = Pick<Update, 'category_id' | 'essentiality' | 'note' | 'one_time'>

/** A note or one-time edit: sent as-is and never touches the categorization. */
const isFlagEdit = (body: TransactionEdit) => body.note !== undefined || body.one_time != null

export function useTransactions(f: Filters, limit = PAGE_SIZE) {
  const query = {
    q: f.q || undefined,
    start: f.start || undefined,
    end: f.end || undefined,
    account_id: f.account ? [Number(f.account)] : undefined,
    category_id: f.category ? [Number(f.category)] : undefined,
    essentiality: f.essentiality || undefined,
    uncategorized: f.uncategorized || undefined,
    needs_review: f.review || undefined,
    include_transfers: f.transfers || undefined,
    limit,
    offset: (f.page - 1) * limit,
  }
  return useQuery({
    queryKey: ['transactions', query],
    queryFn: () => unwrap(api.GET('/api/transactions', { params: { query } })),
    placeholderData: keepPreviousData,
  })
}

/** All categories including hidden ones, so a transaction in a hidden category still shows its label. */
export const useCategories = () =>
  useQuery({
    queryKey: ['categories', { includeHidden: true }],
    queryFn: () => unwrap(api.GET('/api/categories', { params: { query: { include_hidden: true } } })),
  })

/** A transaction with an edit applied, as the server will return it. */
export function patchTransaction(t: Schemas['TransactionRead'], body: TransactionEdit): Schemas['TransactionRead'] {
  if (body.note !== undefined) return { ...t, note: body.note?.trim() || null }
  if (body.one_time != null) return { ...t, one_time: body.one_time }
  const cur = t.categorization
  const categoryId = body.category_id ?? cur?.category_id
  if (categoryId == null) return t // nothing to show optimistically without a category
  return {
    ...t,
    categorization: {
      category_id: categoryId,
      essentiality: body.essentiality ?? cur?.essentiality ?? null,
      source: 'manual',
      confidence: 'very_high',
    },
  }
}

/** PATCH a transaction. Optimistic for plain edits; rolls back on error. */
export function useUpdateTransaction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: TransactionEdit }) =>
      unwrap(
        api.PATCH('/api/transactions/{transaction_id}', {
          params: { path: { transaction_id: id } },
          // A flag edit sends exactly { note } or { one_time }; the rule defaults are for category edits.
          body: isFlagEdit(body) ? body : { rule_match_type: 'exact', save_as_rule: false, ...body },
        }),
      ),
    onMutate: async ({ id, body }) => {
      await qc.cancelQueries({ queryKey: ['transactions'] })
      const previous = qc.getQueriesData<Page>({ queryKey: ['transactions'] })
      qc.setQueriesData<Page>({ queryKey: ['transactions'] }, (page) =>
        page && { ...page, items: page.items.map((t) => (t.id === id ? patchTransaction(t, body) : t)) },
      )
      return { previous }
    },
    onError: (_err, _vars, ctx) => {
      for (const [key, data] of ctx?.previous ?? []) qc.setQueryData(key, data)
    },
    // A category, essentiality, or one-time edit moves report totals and recurring essentiality.
    onSuccess: () => invalidateDerived(qc),
  })
}

/** Split a transfer pair; both rows count again, so reports and the projection refresh too. */
export function useUnpairTransfer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) =>
      unwrap(api.POST('/api/transactions/{transaction_id}/unpair', { params: { path: { transaction_id: id } } })),
    onSuccess: () => {
      for (const key of ['transactions', 'reports', 'projection']) void qc.invalidateQueries({ queryKey: [key] })
    },
    // Shown in the open confirm dialog.
    meta: { inlineError: true },
  })
}

/** The owner says a pending charge posted: it counts in totals, so everything derived refreshes. */
export function useMarkPosted() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) =>
      unwrap(api.POST('/api/transactions/{transaction_id}/mark-posted', { params: { path: { transaction_id: id } } })),
    onSuccess: () => invalidateDerived(qc),
  })
}

/** Remove a pending hold that never became a charge. */
export function useRemovePending() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) =>
      unwrap(api.DELETE('/api/transactions/{transaction_id}', { params: { path: { transaction_id: id } } })),
    onSuccess: () => invalidateDerived(qc),
  })
}
