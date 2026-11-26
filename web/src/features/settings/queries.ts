import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'

export const useSimplefinStatus = () =>
  useQuery({ queryKey: ['settings', 'simplefin'], queryFn: () => unwrap(api.GET('/api/settings/simplefin')) })

export const useLlmStatus = () =>
  useQuery({ queryKey: ['settings', 'llm'], queryFn: () => unwrap(api.GET('/api/settings/llm')) })

export const useHealth = () =>
  useQuery({ queryKey: ['health'], queryFn: () => unwrap(api.GET('/api/health')), staleTime: Infinity })

export const useAccounts = () =>
  useQuery({ queryKey: ['accounts'], queryFn: () => unwrap(api.GET('/api/accounts')) })

export function useConnectSimplefin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (setup_token: string) =>
      unwrap(api.POST('/api/settings/simplefin', { body: { setup_token } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'simplefin'] }),
    // Shown under the token field.
    meta: { inlineError: true },
  })
}

export function useDisconnectSimplefin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => unwrap(api.DELETE('/api/settings/simplefin')),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'simplefin'] }),
  })
}
