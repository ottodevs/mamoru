import { entry } from '@mamoru/registry'
import type { PolicyVersion } from '@mamoru/policy'
import { registryOf } from './gates/index.ts'
import type { Observation, ShadowRisk } from './types.ts'

/**
 * Packaging's pool entry/monitor gate (Brais's risk document): "TVL del pool >= 2M", and below it the position would exit.
 * Whole units of the savings asset (USDC); the raw floor is this times 10^decimals of the policy's savings asset.
 */
export const PACKAGING_TVL_FLOOR_USDC = 2_000_000n

function millions(raw: bigint, decimals: number): string {
  const cents = (raw * 100n) / (10n ** BigInt(decimals) * 1_000_000n)
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}M`
}

/**
 * otto/mamoru#101 phase 1, shadow only: one entry per policy pool whose TVL is under the floor, or could not be read.
 * Nothing for a pool above it, for a pool the observation did not price (absent), or for a policy whose savings asset is
 * not USDC (the floor is in dollars). Goes to Decision.shadowRisk, outside the premise hash; never changes a decision.
 */
export function tvlShadowRisk(obs: Observation, policy: PolicyVersion, policyPools: ReadonlySet<string>): ShadowRisk[] {
  if (policy.savingsAsset !== 'USDC') return []
  const decimals = entry(policy.savingsAsset, registryOf(obs)).decimals
  if (decimals === undefined) return []
  const floor = PACKAGING_TVL_FLOOR_USDC * 10n ** BigInt(decimals)
  const out: ShadowRisk[] = []
  for (const name of [...policyPools].sort()) {
    const pool = obs.pools.find((p) => p.name === name)
    // undefined: not asked for, or the pool does not pair the savings asset; null: asked and could not read it.
    if (!pool || pool.tvlSavings === undefined) continue
    const tvl = pool.tvlSavings
    if (tvl === null) out.push({ code: 'RISK_POOL_TVL_UNREAD', pool: name, threshold: floor.toString() })
    else if (tvl < floor) out.push({ code: 'RISK_POOL_TVL_FLOOR', pool: name, threshold: floor.toString(), metric: tvl.toString(), label: millions(tvl, decimals) })
  }
  return out
}
