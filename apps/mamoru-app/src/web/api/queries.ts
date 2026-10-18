import type { FundingView } from '@mamoru/domain'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { useApi, type ApiClient } from './client.ts'

export const queryKeys = {
  config: ['config'] as const,
  session: ['session'] as const,
  signInChallenge: ['signin-challenge'] as const,
  registrationChallenge: ['registration-challenge'] as const,
  dashboard: (accountKey: string) => ['dashboard', accountKey] as const,
  pools: ['pools'] as const,
  apy: ['apy'] as const,
  funding: (accountKey: string) => ['funding', accountKey] as const,
  otherChains: (accountKey: string) => ['other-chains', accountKey] as const,
  bridgeOut: (accountKey: string) => ['bridge-out', accountKey] as const,
  yieldLedger: (accountKey: string) => ['yield-ledger', accountKey] as const,
  ops: (accountKey: string) => ['ops', accountKey] as const,
  withdrawAssets: (accountKey: string) => ['withdraw-assets', accountKey] as const,
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

/** A sign-in challenge kept ready, so the passkey prompt opens straight from the tap. Renewed before its 5 minutes run out. */
export function useSignInChallenge(enabled: boolean) {
  const api = useApi()
  return useQuery({ queryKey: queryKeys.signInChallenge, queryFn: () => api.signInChallenge(), enabled, staleTime: 0, gcTime: 0, refetchInterval: 4 * 60_000 })
}

/** The registration challenge kept ready while the create step is on screen, so the passkey prompt opens straight from the tap. */
export function useRegistrationChallenge(enabled: boolean) {
  const api = useApi()
  return useQuery({ queryKey: queryKeys.registrationChallenge, queryFn: () => api.registrationChallenge(), enabled, staleTime: 0, gcTime: 0, refetchInterval: 4 * 60_000 })
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

/**
 * otto/mamoru#135: the next funding poll. `fastMs` while the engine is mid-entry (`progress`, or `engine.placing`
 * between steps) or the caller says something of the account's own is in flight (an owner op just submitted, an
 * entry starting); `intervalMs` otherwise. Pure so the cadence can be checked without a running query.
 */
export function fundingInterval(data: Pick<FundingView, 'progress' | 'engine'> | undefined, inFlight: boolean, intervalMs: number, fastMs = 4_000): number {
  const fast = inFlight || !!data?.progress || data?.engine?.placing === true
  return fast ? Math.min(fastMs, intervalMs) : intervalMs
}

/**
 * What the Safe holds now. 30 s by default; 4 s while `inFlight` (an owner op the caller is watching, or an
 * entry it already knows is starting) or while the engine reports progress on its own. The add-money screen
 * passes a 4 s `intervalMs` outright and `fresh` too (otto/mamoru#135): it is open only to watch a deposit
 * land, which moves nothing of the account, so without `fresh` those polls would answer from the operator's
 * 15-60 s cache; with it each gets a read at most 2 s old, under the 4 s gap, so none is wasted. Paused while the tab is hidden (react-query's default
 * `refetchIntervalInBackground: false`).
 */
export function useFunding(accountKey: string | undefined, enabled: boolean, intervalMs = 30_000, inFlight = false, fresh = false) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.funding(accountKey ?? ''),
    queryFn: () => api.funding(accountKey as string, fresh ? { fresh: true } : undefined),
    enabled: enabled && accountKey !== undefined,
    refetchInterval: (q) => fundingInterval(q.state.data, inFlight, intervalMs),
  })
}

/**
 * otto/mamoru#135: a read at most 2 s old (the operator's `fresh=1`), into the same query cache `useFunding`
 * reads, for a dialog about to show an amount the poll's 15-60 s cache may not have caught up with (a deposit
 * never moves anything of the account, so it never invalidates that cache). Nothing is blocked on it: every
 * owner action's prepare reads the chain itself. One fetch per account at a time, by react-query: a poll in
 * flight is cancelled first (its answer is then dropped, never written over this one), a poll tick while this
 * is in flight joins it instead of starting its own, and a later call cancels this one and starts its own
 * (the latest call wins). A failed or cancelled read resolves to `undefined` and leaves the cache as it was,
 * so callers may fire and forget.
 */
export async function fetchFreshFunding(qc: QueryClient, api: Pick<ApiClient, 'funding'>, accountKey: string): Promise<FundingView | undefined> {
  const queryKey = queryKeys.funding(accountKey)
  // Before starting, not after: whatever is in flight (a poll, an earlier fresh call) is dropped, never applied.
  await qc.cancelQueries({ queryKey })
  return qc.fetchQuery({ queryKey, queryFn: () => api.funding(accountKey, { fresh: true }), staleTime: 0 }).catch(() => undefined)
}

/** Call the returned function the moment an Add, Withdraw or Start dialog opens (see fetchFreshFunding). */
export function useFreshFunding(accountKey: string | undefined) {
  const api = useApi()
  const qc = useQueryClient()
  return useCallback(async (): Promise<FundingView | undefined> => (accountKey ? fetchFreshFunding(qc, api, accountKey) : undefined), [accountKey, api, qc])
}

/** otto/mamoru#129: uncollected fees, collected, gas Mamoru paid and value vs hold. Slow poll, no retry: a failure shows nothing, same as useOtherChains. */
export function useYieldLedger(accountKey: string | undefined) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.yieldLedger(accountKey ?? ''),
    queryFn: () => api.yieldLedger(accountKey as string),
    enabled: accountKey !== undefined,
    retry: false,
    refetchInterval: 60_000,
  })
}

/** The account address on chains Mamoru does not run on (a transfer sent on the wrong network). Slow poll, no retry: a failure shows nothing. */
export function useOtherChains(accountKey: string | undefined) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.otherChains(accountKey ?? ''),
    queryFn: () => api.otherChains(accountKey as string),
    enabled: accountKey !== undefined,
    retry: false,
    refetchInterval: 60_000,
  })
}

/** The last move from Ethereum (#133). Polls every 5 s while it is on its way; a failed read shows nothing. */
export function useBridgeOut(accountKey: string | undefined) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.bridgeOut(accountKey ?? ''),
    queryFn: () => api.bridgeOutStatus(accountKey as string),
    enabled: accountKey !== undefined,
    retry: false,
    refetchInterval: (q) => (q.state.data?.route && ['sending', 'deposited', 'unconfirmed'].includes(q.state.data.route.state) ? 5_000 : false),
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

/** Which assets a withdraw can pay out in. A failure is not retried: the dialog falls back to a static list. */
export function useWithdrawAssets(accountKey: string | undefined, enabled: boolean) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.withdrawAssets(accountKey ?? ''),
    queryFn: () => api.withdrawAssets(accountKey as string),
    enabled: enabled && accountKey !== undefined,
    retry: false,
    staleTime: 60_000,
  })
}
