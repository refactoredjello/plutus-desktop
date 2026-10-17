import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from '@/api/client'

export const useMonthDetail = (month: string, enabled = true) =>
  useQuery({
    queryKey: ['reports', 'month', month],
    enabled,
    queryFn: () => unwrap(api.GET('/api/reports/month/{month}', { params: { path: { month } } })),
  })
