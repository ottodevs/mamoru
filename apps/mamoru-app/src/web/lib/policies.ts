import { conservadorLiveV4, conservadorLiveV5, conservadorLiveV6, POLICIES, type PolicyVersion } from '@mamoru/policy'

/** The policies an account may run, by id: what its mix and targets are read from (never typed in the app). */
export const KNOWN_POLICIES: Record<string, PolicyVersion> = { ...POLICIES, ...Object.fromEntries([conservadorLiveV4, conservadorLiveV5, conservadorLiveV6].map((p) => [p.policyId, p])) }

/** A policy with a share served on another chain (conservador-live-v6: Growth on Monad). */
export const isMultichainTarget = (policyId: string | undefined) => !!policyId && !!KNOWN_POLICIES[policyId]?.remoteBuckets?.length

/**
 * otto/mamoru#216: each pool's bucket target as a share of the whole account (0..100), local and remote buckets
 * alike; empty for an unknown policy. A pool at preference 0 (v6's USDC/cbBTC, being left) targets 0.
 */
export function poolTargets(policyId: string | undefined): Map<string, number> {
  const p = policyId ? KNOWN_POLICIES[policyId] : undefined
  const out = new Map<string, number>()
  if (!p) return out
  const total = p.buckets.reduce((s, b) => s + b.preference, 0) + (p.remoteBuckets ?? []).reduce((s, b) => s + b.preference, 0)
  if (total <= 0) return out
  for (const b of [...p.buckets, ...(p.remoteBuckets ?? [])]) for (const pool of b.pools) out.set(pool, (b.preference * 100) / total)
  return out
}
