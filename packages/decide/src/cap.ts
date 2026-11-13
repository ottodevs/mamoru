import type { PolicyVersion } from '@mamoru/policy'
import { bucketValues } from './rerange/index.ts'
import type { Observation } from './types.ts'

/**
 * otto/mamoru#212: what this account has placed on this chain, in raw savings units: its managed positions (with what
 * they can collect), the idle tokens of its pools that are not the savings asset (bought for an entry) and its vault
 * shares (`bucketValues`). The idle savings asset is not placed. otto/mamoru#352: shares in an observed vault no bucket
 * names (left from an earlier policy) are placed money too. otto/mamoru#408: the sleeve on another chain
 * (`obs.remote`, which `bucketValues` adds to its total) is not on this chain: `capRoomOf` counts it with the others.
 */
export function placedOf(obs: Observation, policy: PolicyVersion): bigint {
  const pools = new Set(policy.buckets.flatMap((b) => b.pools))
  const { total } = bucketValues(obs, policy, pools)
  const off = (obs.balances[policy.savingsAsset] ?? 0n) + (obs.remote?.value ?? 0n)
  const named = new Set(policy.buckets.flatMap((b) => b.vaults ?? []))
  const unnamed = (obs.vaults ?? []).filter((v) => !named.has(v.name)).reduce((s, v) => s + v.assets, 0n)
  return (total > off ? total - off : 0n) + unnamed
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
  // otto/mamoru#408: every exposure once. The sleeve `obs.remote` is added only when the operator says the peer reads
  // in `elsewhereUsdc` do not hold it; when they do, it is already there (b22428c7, 13 Nov: 145 USDC of Monad counted
  // twice left no room and 77 USDC idle). Not known: as another chain unread, nothing new.
  const elsewhere = cap.elsewhereUsdc === null ? null : !obs.remote ? cap.elsewhereUsdc : cap.elsewhereIncludesRemote === true ? cap.elsewhereUsdc : cap.elsewhereIncludesRemote === false ? cap.elsewhereUsdc + obs.remote.value : null
  let left = elsewhere === null || obs.vaultsUnread?.length ? 0n : cap.capUsdc - elsewhere - placed
  // A remote Safe places within its own cap as well as the account's.
  if (cap.chainCapUsdc !== undefined && cap.chainCapUsdc - placed < left) left = cap.chainCapUsdc - placed
  // What the engine's own re-range or reduce took out goes back in, even above the cap or with a chain unread; never
  // above this Safe's own cap (otto/mamoru#382).
  const back = cap.chainCapUsdc !== undefined && cap.chainCapUsdc - placed < reinvest ? (cap.chainCapUsdc > placed ? cap.chainCapUsdc - placed : 0n) : reinvest
  return left > back ? left : back
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
