import { QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { createQueryClient } from '@/app/queryClient'
import { useUpdateTransaction } from './queries'

describe('useUpdateTransaction', () => {
  it('a category edit invalidates reports, so totals elsewhere refresh', async () => {
    const qc = createQueryClient()
    qc.setQueryData(['reports', 'month', '2026-09'], { stale: false })
    qc.setQueryData(['projection', 3], { stale: false })
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    const { result } = renderHook(() => useUpdateTransaction(), { wrapper })
    result.current.mutate({ id: 1000, body: { category_id: 3, essentiality: 'essential' } })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(qc.getQueryState(['reports', 'month', '2026-09'])?.isInvalidated).toBe(true)
    expect(qc.getQueryState(['projection', 3])?.isInvalidated).toBe(true)
  })
})
