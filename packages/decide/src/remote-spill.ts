import type { PolicyVersion } from '@mamoru/policy'
import type { Observation } from './types.ts'

/**
 * otto/mamoru#401: the part of the remote buckets' share their sleeve cannot hold. A sleeve never places more than its
 * own signed cap (`obs.remote.cap`), so the share above it (or above what it already holds, if more) stays on this chain
 * and is spread over the local buckets by preference: every unit keeps working, at this chain's yield. 0 without a cap,
 * so every target is what it was.
 */
export function remoteSpill(obs: Observation, policy: Pick<PolicyVersion, 'remoteBuckets'>, total: bigint, prefTotal: bigint): bigint {
  const cap = obs.remote?.cap
  const remotePref = BigInt((policy.remoteBuckets ?? []).reduce((s, b) => s + b.preference, 0))
  if (cap === undefined || remotePref === 0n || prefTotal <= remotePref) return 0n
  const share = (total * remotePref) / prefTotal
  const value = obs.remote?.value ?? 0n
  const holds = value > cap ? value : cap
  return share > holds ? share - holds : 0n
}

/** A local bucket's target with its part of `spill` (its preference over every local one). */
export function localTarget(total: bigint, preference: number, prefTotal: bigint, remotePref: number, spill: bigint): bigint {
  const base = (total * BigInt(preference)) / prefTotal
  const local = prefTotal - BigInt(remotePref)
  return spill > 0n && local > 0n ? base + (spill * BigInt(preference)) / local : base
}
