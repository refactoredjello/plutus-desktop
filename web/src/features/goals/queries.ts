import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, unwrap, type Schemas } from '@/api/client'

export const useGoals = () => useQuery({ queryKey: ['goals'], queryFn: () => unwrap(api.GET('/api/goals')) })

export function useGoalMutations() {
  const qc = useQueryClient()
  const invalidate = () => qc.invalidateQueries({ queryKey: ['goals'] })
  const create = useMutation({
    mutationFn: (body: Schemas['GoalCreate']) => unwrap(api.POST('/api/goals', { body })),
    onSuccess: invalidate,
  })
  const update = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Schemas['GoalUpdate'] }) =>
      unwrap(api.PATCH('/api/goals/{goal_id}', { params: { path: { goal_id: id } }, body })),
    onSuccess: invalidate,
  })
  return { create, update }
}

export const useSuggestions = (goalId: number) =>
  useQuery({
    queryKey: ['suggestions', goalId],
    queryFn: () => unwrap(api.GET('/api/goals/{goal_id}/suggestions', { params: { path: { goal_id: goalId } } })),
  })

/** Asks the LLM for ideas. Slow (seconds) and may fail with a 502; callers show `error.message`. */
export function useGenerateSuggestions(goalId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => unwrap(api.POST('/api/goals/{goal_id}/suggestions', { params: { path: { goal_id: goalId } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['suggestions', goalId] }),
  })
}

export function useUpdateSuggestion(goalId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status }: { id: number; status: Schemas['SuggestionStatus'] }) =>
      unwrap(api.PATCH('/api/suggestions/{suggestion_id}', { params: { path: { suggestion_id: id } }, body: { status } })),
    onMutate: async ({ id, status }) => {
      const key = ['suggestions', goalId]
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData<Schemas['SuggestionRead'][]>(key)
      qc.setQueryData<Schemas['SuggestionRead'][]>(key, (list) => list?.map((s) => (s.id === id ? { ...s, status } : s)))
      return { previous }
    },
    onError: (_e, _v, ctx) => qc.setQueryData(['suggestions', goalId], ctx?.previous),
    onSettled: () => qc.invalidateQueries({ queryKey: ['suggestions', goalId] }),
  })
}
