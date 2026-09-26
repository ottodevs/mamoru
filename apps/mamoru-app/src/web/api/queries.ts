import { useQuery } from '@tanstack/react-query'
import { useApi } from './client.ts'

export const queryKeys = {
  config: ['config'] as const,
  session: ['session'] as const,
  dashboard: (accountKey: string) => ['dashboard', accountKey] as const,
  pools: ['pools'] as const,
}

export function useConfig() {
  const api = useApi()
  return useQuery({ queryKey: queryKeys.config, queryFn: () => api.config(), staleTime: Infinity })
}

export function useSession(enabled = true) {
  const api = useApi()
  return useQuery({ queryKey: queryKeys.session, queryFn: () => api.session(), enabled })
}

export function useDashboard(accountKey: string | undefined) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.dashboard(accountKey ?? ''),
    queryFn: () => api.dashboard(accountKey as string),
    enabled: accountKey !== undefined,
    refetchInterval: 60_000,
  })
}

export function usePools() {
  const api = useApi()
  return useQuery({ queryKey: queryKeys.pools, queryFn: () => api.pools(), refetchInterval: 60_000 })
}
