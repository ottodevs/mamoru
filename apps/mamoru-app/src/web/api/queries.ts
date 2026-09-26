import { useQuery } from '@tanstack/react-query'
import { useApi } from './client.ts'

export const queryKeys = {
  config: ['config'] as const,
  session: ['session'] as const,
  dashboard: (accountKey: string) => ['dashboard', accountKey] as const,
  pools: ['pools'] as const,
  apy: ['apy'] as const,
  funding: (accountKey: string) => ['funding', accountKey] as const,
  ops: (accountKey: string) => ['ops', accountKey] as const,
}

const TERMINAL = new Set(['confirmed', 'failed'])

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

/** Pool fee APR of the plan's live pool. Refreshes every 30 s (APY_REFRESH_MS). */
export const APY_REFRESH_MS = 30_000
export function useApy() {
  const api = useApi()
  return useQuery({ queryKey: queryKeys.apy, queryFn: () => api.apy(), refetchInterval: APY_REFRESH_MS, refetchIntervalInBackground: false })
}

/** What the Safe holds now. Polls every 6 s by default, 4 s while waiting for a deposit. */
export function useFunding(accountKey: string | undefined, enabled: boolean, intervalMs = 6_000) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.funding(accountKey ?? ''),
    queryFn: () => api.funding(accountKey as string),
    enabled: enabled && accountKey !== undefined,
    refetchInterval: intervalMs,
  })
}

/** Operations on the account. Polls every 4 s while any operation is not confirmed or failed. */
export function useOps(accountKey: string | undefined, enabled: boolean) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.ops(accountKey ?? ''),
    queryFn: () => api.ops(accountKey as string),
    enabled: enabled && accountKey !== undefined,
    refetchInterval: (q) => (q.state.data?.ops.some((op) => !TERMINAL.has(op.state)) ? 4_000 : false),
  })
}
