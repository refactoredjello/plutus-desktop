import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, unwrap, type Schemas } from '@/api/client'

export const usePlanned = () =>
  useQuery({ queryKey: ['planned'], queryFn: () => unwrap(api.GET('/api/manual-entries')) })

export function usePlannedMutations() {
  const qc = useQueryClient()
  const invalidate = () => qc.invalidateQueries({ queryKey: ['planned'] })
  const create = useMutation({
    mutationFn: (body: Schemas['ManualEntryCreate']) => unwrap(api.POST('/api/manual-entries', { body })),
    onSuccess: invalidate,
    // The entry dialog shows the error next to its fields.
    meta: { inlineError: true },
  })
  const update = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Schemas['ManualEntryUpdate'] }) =>
      unwrap(api.PATCH('/api/manual-entries/{entry_id}', { params: { path: { entry_id: id } }, body })),
    onSuccess: invalidate,
    meta: { inlineError: true },
  })
  const remove = useMutation({
    mutationFn: (id: number) => unwrap(api.DELETE('/api/manual-entries/{entry_id}', { params: { path: { entry_id: id } } })),
    onSuccess: invalidate,
  })
  return { create, update, remove }
}
