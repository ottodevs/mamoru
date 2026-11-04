import type { FundingView } from '@mamoru/domain'
import { KNOWN_POLICIES } from './policies.ts'
import { bucketOf, valueOf, type Bucket } from './rates.ts'

// otto/mamoru#265: the account's mix now against the mix its policy aims for, per bucket (Stable, Balanced, Growth), as a
// share of the whole money. Brais's account on 1 Nov after the move: 50.3 / 34.6 / 15.1 against 50 / 35 / 15.

export type MixRow = { bucket: Bucket; nowPct: number; targetPct: number }

const ORDER: Bucket[] = ['Stable', 'Balanced', 'Growth']

/**
 * Per bucket: its positions' value, plus, for a bucket served on another chain (Growth on Monad), every USDC on that
 * chain's Safes and on its way there (that money is there only for that bucket), over the whole money. Idle money on the
 * home chain belongs to no bucket yet, so the shares may add up to a little under 100.
 * Null on one chain, and when the share would not be true: no money map, a map that is not complete, an unknown policy, a position with no
 * value, or a total of 0.
 */
export function mixVsTarget(f: FundingView, price: bigint | null = null): MixRow[] | null {
  const m = f.money
  const policyId = f.approval?.policyId
  const policy = policyId ? KNOWN_POLICIES[policyId] : undefined
  // Only for an account on more than one chain: on one chain each row already says its share and its target.
  if (!m || !m.complete || !policy || new Set(m.chains.map((c) => c.chainId)).size < 2) return null
  const total = BigInt(m.totalUsdc)
  if (total <= 0n) return null
  const prefTotal = policy.buckets.reduce((s, b) => s + b.preference, 0) + (policy.remoteBuckets ?? []).reduce((s, b) => s + b.preference, 0)
  if (prefTotal <= 0) return null
  const target = new Map<Bucket, number>()
  const remoteOf = new Map<number, Bucket>()
  for (const b of policy.buckets) {
    if (b.preference <= 0) continue
    const label = b.vaults?.length ? 'Stable' : bucketOf(b.pools[0], undefined, policyId, 8453)
    target.set(label, (target.get(label) ?? 0) + (b.preference * 100) / prefTotal)
  }
  for (const b of policy.remoteBuckets ?? []) {
    if (b.preference <= 0) continue
    const label = bucketOf(b.pools[0], undefined, policyId, b.chainId)
    target.set(label, (target.get(label) ?? 0) + (b.preference * 100) / prefTotal)
    remoteOf.set(b.chainId, label)
  }
  if (target.size < 2) return null
  const now = new Map<Bucket, bigint>()
  const add = (b: Bucket, v: bigint) => now.set(b, (now.get(b) ?? 0n) + v)
  for (const c of m.chains) {
    const remote = remoteOf.get(c.chainId)
    if (remote) {
      add(remote, BigInt(c.totalUsdc))
      continue
    }
    for (const p of c.positions) {
      const { value } = valueOf(p, price)
      if (value === null) return null
      add(p.vault ? 'Stable' : bucketOf(p.pool, p.amounts, policyId, c.chainId), value)
    }
  }
  for (const t of m.inFlight) {
    const remote = remoteOf.get(t.to)
    if (remote && t.stage !== 'failed') add(remote, BigInt(t.amountUsdc))
  }
  const pct = (v: bigint) => Number((v * 10_000n) / total) / 100
  return ORDER.filter((b) => target.has(b) || (now.get(b) ?? 0n) > 0n).map((b) => ({ bucket: b, nowPct: pct(now.get(b) ?? 0n), targetPct: Math.round((target.get(b) ?? 0) * 10) / 10 }))
}
