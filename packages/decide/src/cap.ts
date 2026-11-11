import type { PolicyVersion } from '@mamoru/policy'
import { bucketValues } from './rerange/index.ts'
import type { Observation } from './types.ts'

/**
 * otto/mamoru#212: what this account has placed on this chain, in raw savings units: its managed positions (with what
 * they can collect), the idle tokens of its pools that are not the savings asset (bought for an entry) and its vault
 * shares (`bucketValues`). The idle savings asset is not placed. otto/mamoru#352: shares in an observed vault no bucket
 * names (left from an earlier policy) are placed money too.
 */
export function placedOf(obs: Observation, policy: PolicyVersion): bigint {
  const pools = new Set(policy.buckets.flatMap((b) => b.pools))
  const { total } = bucketValues(obs, policy, pools)
  const free = obs.balances[policy.savingsAsset] ?? 0n
  const named = new Set(policy.buckets.flatMap((b) => b.vaults ?? []))
  const unnamed = (obs.vaults ?? []).filter((v) => !named.has(v.name)).reduce((s, v) => s + v.assets, 0n)
  return (total > free ? total - free : 0n) + unnamed
}

/**
 * otto/mamoru#212: how much more savings the engine may place on this chain without taking what the account has placed
 * across every chain above its cap, or null when the observation carries no cap (backtest, lab). `elsewhereUsdc` null:
 * another chain could not be read, so nothing new is placed (fail closed).
 */
export function capRoomOf(obs: Observation, policy: PolicyVersion): bigint | null {
  const cap = obs.cap
  if (!cap) return null
  const reinvest = cap.reinvestUsdc ?? 0n
  // otto/mamoru#352: a vault of this chain unread is an unread leg, as another chain is: nothing new.
  const placed = placedOf(obs, policy)
  let left = cap.elsewhereUsdc === null || obs.vaultsUnread?.length ? 0n : cap.capUsdc - cap.elsewhereUsdc - placed
  // A remote Safe places within its own cap as well as the account's.
  if (cap.chainCapUsdc !== undefined && cap.chainCapUsdc - placed < left) left = cap.chainCapUsdc - placed
  // What the engine's own re-range or reduce took out goes back in, even above the cap or with a chain unread.
  return left > reinvest ? left : reinvest
}

/**
 * otto/mamoru#212 (soft cap): the observation the fixed-weight entries (`enterBucket`) size with, where the savings the
 * account holds above its room under the cap are not there to place: entries take at most the room, the rest stays
 * idle. otto/mamoru#353: nothing else reads it. Target weights pass the room to `allocate` (capRoomOf), which reads the
 * total, the targets, sales of idle volatile and the remote bucket's return from the observation as it is; positions
 * already placed are re-ranged, harvested and reduced as before, and nothing is sold, reduced or moved between chains
 * because of the cap. Unchanged without a cap or within it.
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
