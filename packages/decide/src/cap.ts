import type { PolicyVersion } from '@mamoru/policy'
import { bucketValues } from './rerange/index.ts'
import type { Observation } from './types.ts'

/**
 * otto/mamoru#212: what this account has placed on this chain, in raw savings units: its managed positions (with what
 * they can collect) and the idle tokens of its pools that are not the savings asset (bought for an entry). The idle
 * savings asset is not placed.
 */
export function placedOf(obs: Observation, policy: PolicyVersion): bigint {
  const pools = new Set(policy.buckets.flatMap((b) => b.pools))
  const { total } = bucketValues(obs, policy, pools)
  const free = obs.balances[policy.savingsAsset] ?? 0n
  return total > free ? total - free : 0n
}

/**
 * otto/mamoru#212: how much more savings the engine may place on this chain without taking what the account has placed
 * across every chain above its cap, or null when the observation carries no cap (backtest, lab). `elsewhereUsdc` null:
 * another chain could not be read, so nothing new is placed (fail closed).
 */
export function capRoomOf(obs: Observation, policy: PolicyVersion): bigint | null {
  const cap = obs.cap
  if (!cap) return null
  if (cap.elsewhereUsdc === null) return 0n
  const room = cap.capUsdc - cap.elsewhereUsdc - placedOf(obs, policy)
  return room > 0n ? room : 0n
}

/**
 * otto/mamoru#212 (soft cap): the observation `decide` sizes with, where the savings the account holds above its room
 * under the cap are not there to place. Every step then sizes from what may still be placed: entries take at most the
 * room, the rest stays idle; positions already placed are re-ranged, harvested and reduced as before, and nothing is
 * sold because their value rose above the cap. Unchanged without a cap or within it.
 */
export function withinCap(obs: Observation, policy: PolicyVersion): Observation {
  const room = capRoomOf(obs, policy)
  if (room === null) return obs
  const savings = policy.savingsAsset
  const held = obs.balances[savings] ?? 0n
  // safeSavings takes the unsafe deposits off what is held: they stay counted, so what is left is the room.
  const unsafe = obs.deposits.filter((d) => d.token === savings && !d.safe).reduce((s, d) => s + d.amount, 0n)
  const allowed = unsafe + room
  if (held <= allowed) return obs
  return { ...obs, balances: { ...obs.balances, [savings]: allowed } }
}
