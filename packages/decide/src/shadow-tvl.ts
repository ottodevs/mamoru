import { entry } from '@mamoru/registry'
import type { PolicyVersion } from '@mamoru/policy'
import { registryOf } from './gates/index.ts'
import type { Observation, ShadowMetric, ShadowNote } from './types.ts'

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
 * otto/mamoru#101 phase 1, shadow only: one note per policy pool whose TVL is under the floor, or unread. Nothing for a pool
 * above it. These notes never change a proposal, a hold or a code; they only ride in the decision's `shadow`.
 *
 * The notes carry no measured value: `shadow` is part of the premise hash, and a TVL that moves every block would give
 * every review a new premise, defeating the dedupe of a discarded premise and the bundler backoff (engine.ts). The
 * value goes in `metrics`, which the decision carries outside its hash.
 */
export function tvlShadowNotes(obs: Observation, policy: PolicyVersion, policyPools: ReadonlySet<string>): { notes: ShadowNote[]; metrics: ShadowMetric[] } {
  const decimals = entry(policy.savingsAsset, registryOf(obs)).decimals
  if (decimals === undefined) return { notes: [], metrics: [] }
  const floor = PACKAGING_TVL_FLOOR_USDC * 10n ** BigInt(decimals)
  const notes: ShadowNote[] = []
  const metrics: ShadowMetric[] = []
  for (const name of [...policyPools].sort()) {
    const pool = obs.pools.find((p) => p.name === name)
    if (!pool) continue
    // undefined: this observation did not ask for it (nothing to say); null: it asked and could not read it.
    if (pool.tvlSavings === undefined) continue
    const tvl = pool.tvlSavings
    if (tvl === null) {
      notes.push({ code: 'RISK_DATA_INSUFFICIENT', note: `${name} TVL unread`, pool: name, threshold: floor.toString() })
    } else if (tvl < floor) {
      notes.push({ code: 'RISK_POOL_TVL_FLOOR', note: `${name} TVL under the ${PACKAGING_TVL_FLOOR_USDC / 1_000_000n}M floor: Packaging would exit`, pool: name, threshold: floor.toString() })
      metrics.push({ code: 'RISK_POOL_TVL_FLOOR', pool: name, metric: tvl.toString(), label: millions(tvl, decimals) })
    }
  }
  return { notes, metrics }
}
