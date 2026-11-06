import type { FundingView, OpView } from '@mamoru/domain'
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
  ethereumSibling: (accountKey: string) => ['ethereum-sibling', accountKey] as const,
  yieldLedger: (accountKey: string) => ['yield-ledger', accountKey] as const,
  stats: ['stats'] as const,
  valueSeries: (accountKey: string) => ['value-series', accountKey] as const,
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
 * otto/mamoru#135: the next funding poll. `fastMs` while the caller says something of the owner's own is in flight
 * (an op just submitted, an entry starting): the owner is watching for it. `engineMs` while the engine is mid-entry on
 * its own (`progress`, or `engine.placing` between steps), #255: an entry takes minutes, so a reading every 10 s
 * follows it without polling at the owner's pace. `intervalMs` otherwise. Pure so the cadence can be checked without
 * a running query.
 */
export function fundingInterval(data: Pick<FundingView, 'progress' | 'engine'> | undefined, inFlight: boolean, intervalMs: number, fastMs = 4_000, engineMs = 10_000): number {
  if (inFlight) return Math.min(fastMs, intervalMs)
  if (data?.progress || data?.engine?.placing === true) return Math.min(engineMs, intervalMs)
  return intervalMs
}

/**
 * #255: the funding poll when nothing is moving. otto/mamoru#340: 15 s, not 60 s: a deposit moves nothing of the
 * account, so this poll is the only way Home learns of one. The operator looks for a deposit at most every 30 s
 * (one log read) and, while that look is current, answers from a balance read up to 60 s old, so the balance costs
 * the chain no more than the 60 s poll did; a deposit it finds sends the next read to the chain.
 */
export const FUNDING_IDLE_MS = 15_000

/**
 * otto/mamoru#340: the Safe's idle USDC went up between two funding reads, most often a deposit landing. The
 * history (GET /ops) is polled only while an op is in flight, so Home asks it again then, for the deposit's row.
 */
export function depositArrived(before: Pick<FundingView, 'address' | 'usdc'> | undefined, after: Pick<FundingView, 'address' | 'usdc'> | undefined): boolean {
  if (!before || !after || before.address.toLowerCase() !== after.address.toLowerCase()) return false
  return BigInt(after.usdc) > BigInt(before.usdc)
}

/**
 * What the Safe holds now. FUNDING_IDLE_MS by default; 4 s while `inFlight` (an owner op the caller is watching, or an
 * entry it already knows is starting), 10 s while the engine reports progress on its own. The add-money screen
 * passes a 4 s `intervalMs` outright and `fresh` too (otto/mamoru#135): it is open only to watch a deposit
 * land, which moves nothing of the account, so without `fresh` those polls would answer from the operator's
 * 15-60 s cache; with it each gets a read at most 2 s old, under the 4 s gap, so none is wasted. Paused while the tab is hidden (react-query's default
 * `refetchIntervalInBackground: false`).
 */
export function useFunding(accountKey: string | undefined, enabled: boolean, intervalMs = FUNDING_IDLE_MS, inFlight = false, fresh = false) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.funding(accountKey ?? ''),
    queryFn: () => api.funding(accountKey as string, fresh ? { fresh: true } : undefined),
    enabled: enabled && accountKey !== undefined,
    refetchInterval: (q) => fundingInterval(q.state.data, inFlight, intervalMs),
    // otto/mamoru#340: back on the tab (a deposit is sent from another app), read at once, not at the next tick.
    refetchOnWindowFocus: true,
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

/** Spec 013: the public Stats. The API caches it for minutes; a slow poll is enough. */
export function useStats() {
  const api = useApi()
  return useQuery({ queryKey: queryKeys.stats, queryFn: () => api.stats(), retry: 1, refetchInterval: 5 * 60_000 })
}

/** Spec 013 STATS-R14: the Portfolio's Total value by day. No retry: a failure hides the chart. */
export function useValueSeries(accountKey: string | undefined) {
  const api = useApi()
  return useQuery({ queryKey: queryKeys.valueSeries(accountKey ?? ''), queryFn: () => api.valueSeries(accountKey as string), enabled: accountKey !== undefined, retry: false, refetchInterval: 10 * 60_000 })
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
    refetchInterval: (q) => (q.state.data?.route && ['sending', 'deposited', 'unconfirmed', 'expired'].includes(q.state.data.route.state) ? (q.state.data.route.state === 'expired' ? 60_000 : 5_000) : false),
  })
}

/**
 * #311: Mamoru's session on the account's own Safe on Ethereum. Polls every 5 s while its setup is being sent, every
 * minute otherwise; a read that never succeeded shows nothing (an operator without Ethereum: 404).
 */
export function useEthereumSibling(accountKey: string | undefined) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.ethereumSibling(accountKey ?? ''),
    queryFn: () => api.ethereumSiblingStatus(accountKey as string),
    enabled: accountKey !== undefined,
    retry: false,
    // Review of #243 (GPT-6 P1): every minute in every other state too, so funds that reach Ethereum later, or a scope
    // turned on in /ops, show the offer in an open page. The operator answers this from memory.
    refetchInterval: (q) => (q.state.data && (q.state.data.state === 'sending' || q.state.data.state === 'unconfirmed') ? 5_000 : 60_000),
  })
}

/**
 * Operations on the account. Polls every 4 s while any operation is not confirmed or failed; otto/mamoru#340: every
 * 30 s while only a deposit is arriving (it turns confirmed about 10 minutes later, once its block is deep enough).
 */
export function opsInterval(ops: readonly Pick<OpView, 'kind' | 'state'>[] | undefined): number | false {
  const open = (ops ?? []).filter((op) => !TERMINAL.has(op.state))
  if (open.some((op) => op.kind !== 'deposit')) return 4_000
  return open.length ? 30_000 : false
}

export function useOps(accountKey: string | undefined, enabled: boolean) {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.ops(accountKey ?? ''),
    queryFn: () => api.ops(accountKey as string),
    enabled: enabled && accountKey !== undefined,
    refetchInterval: (q) => opsInterval(q.state.data?.ops),
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
