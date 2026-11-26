import { MutationCache, QueryClient } from '@tanstack/react-query'
import { notifyError } from '@/lib/toast'

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: {
      /** The error shows next to the form field that caused it, so it is not toasted too. */
      inlineError?: boolean
      /** Toast title for a failure; "Could not save" by default. */
      errorTitle?: string
    }
  }
}

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
    },
    // Every mutation error is toasted once here, unless its form shows it inline.
    mutationCache: new MutationCache({
      onError: (error, _vars, _ctx, mutation) => {
        if (!mutation.meta?.inlineError) notifyError(mutation.meta?.errorTitle ?? 'Could not save', error)
      },
    }),
  })
}
