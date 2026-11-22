import type { ReasonCode } from '@mamoru/domain'
import { grantKeyFor, type PolicyVersion } from '@mamoru/policy'
import { vaultFloorOf } from '../allocate/index.ts'
import { reinvestRoomOf } from '../harvest/index.ts'
import type { Observation, VaultDepositProposal } from '../types.ts'
import { bucketVaults } from '../value.ts'
import { bucketValues } from '../rerange/index.ts'

// otto/mamoru#413 (spec 012 savings-layer.md): harvested USDC is savings, kept in the Stable bucket's vault as shares
// tagged savings, outside the bucket weights. The operator keeps the books (`Observation.savings`); here they are only
// read: taken off the account for every bucket decision, and spent by the savings deposit alone.

/** Pending savings the Safe holds now: the books' amount, never above the savings asset held. */
export function savingsPending(obs: Observation, policy: PolicyVersion): bigint {
  const pending = obs.savings?.pending ?? 0n
  if (pending <= 0n) return 0n
  const held = obs.balances[policy.savingsAsset] ?? 0n
  return pending < held ? pending : held
}

/**
 * SAV-R4: the observation without the savings layer, what allocation, the drain band, idle sales and entries see:
 * pending savings off the savings asset, savings shares off each vault (their assets and the vault's limits at the
 * vault's rate, floored, so the bucket is never counted above what it holds). The result has no `savings`, so taking
 * it off twice changes nothing. Without `obs.savings` the same object, and every decision hashes as before.
 */
export function bucketObs(obs: Observation, policy: PolicyVersion): Observation {
  if (!obs.savings) return obs
  const { savings: _books, ...rest } = obs
  const asset = policy.savingsAsset
  const pending = savingsPending(obs, policy)
  const balances = pending > 0n ? { ...obs.balances, [asset]: (obs.balances[asset] ?? 0n) - pending } : obs.balances
  const vaults = obs.vaults?.map((v) => {
    const own = obs.savings!.shares[v.name] ?? 0n
    const tagged = own < v.shares ? (own > 0n ? own : 0n) : v.shares
    if (tagged === 0n) return v
    const shares = v.shares - tagged
    const assets = v.shares === 0n ? 0n : (v.assets * shares) / v.shares
    return { ...v, shares, assets, maxWithdraw: v.maxWithdraw < assets ? v.maxWithdraw : assets, maxRedeem: v.maxRedeem < shares ? v.maxRedeem : shares }
  })
  return { ...rest, balances, ...(vaults ? { vaults } : {}) }
}

/**
 * otto/mamoru#413 (Lab harvest modes, 22 Nov): the smallest savings deposit also grows with the account, this share (bps)
 * of its value, so a large account sweeps a few times a day, not every harvest (about 20 a day at 100k with the 1 USDC
 * floor alone). 5 bps: 50 USDC at 100k, 0.50 at 1k (the vault floor, 1 USDC on v7/v8, binds there).
 */
export const SWEEP_FLOOR_BPS = 5n

/** The smallest savings deposit: the vault floor, or SWEEP_FLOOR_BPS of the account's value when larger. Stateless. */
export function sweepFloorOf(obs: Observation, policy: PolicyVersion): bigint {
  const vault = vaultFloorOf(obs, policy)
  const { total } = bucketValues(obs, policy, new Set(policy.buckets.flatMap((b) => b.pools)))
  const bySize = (total * SWEEP_FLOOR_BPS) / 10_000n
  return bySize > vault ? bySize : vault
}

export type SavingsSweep = { proposal: VaultDepositProposal | null; wait: { bucket: string; code: ReasonCode } | null }

/**
 * SAV-R2: pending savings go into the Stable bucket's vault, tagged savings, once they reach the sweep floor (the vault
 * floor an allocation deposit needs, or 5 bps of the account when larger: `sweepFloorOf`). Less waits and adds up with the next harvests,
 * silently (nothing to report until it can go). Within what the vault takes now, the V4 vault ratio (`vaultRoom`) and
 * the V4 room reserve (HRV-R7). Never with an unsafe deposit, an unread vault the policy names, or the bucket frozen
 * (`still`: a fall or a depeg holds the stables bucket still). Absent `obs.savings`: nothing.
 */
export function savingsSweepOf(obs: Observation, policy: PolicyVersion, still?: ReadonlySet<string>): SavingsSweep {
  const none: SavingsSweep = { proposal: null, wait: null }
  if (!obs.savings || obs.deposits.some((d) => !d.safe)) return none
  const b = policy.buckets.find((x) => (x.vaults?.length ?? 0) > 0 && x.preference > 0) ?? policy.buckets.find((x) => (x.vaults?.length ?? 0) > 0)
  if (!b || still?.has(b.id)) return none
  const named = new Set(b.vaults ?? [])
  if (obs.vaultsUnread?.some((v) => named.has(v))) return none
  const pending = savingsPending(obs, policy)
  const floor = sweepFloorOf(obs, policy)
  if (pending < floor) return none
  const live = (grant: string) => obs.sessions.some((s) => s.grant === grant && s.active && BigInt(s.validUntil) > obs.block.timestamp && (s.usesLeft ?? 1) > 0)
  const open = bucketVaults(obs, b).filter((v) => v.maxDeposit >= floor)
  const v = open.find((x) => live(grantKeyFor(policy, 'vault-supply', x.name))) ?? open[0]
  if (!v) return { proposal: null, wait: { bucket: b.id, code: 'DECIDE_WAIT_VAULT_LIQUIDITY' } }
  let assets = pending < v.maxDeposit ? pending : v.maxDeposit
  const ratioRoom = obs.budget?.vaultRoom
  if (ratioRoom !== undefined && ratioRoom < assets) {
    if (ratioRoom < floor) return { proposal: null, wait: { bucket: b.id, code: 'DECIDE_WAIT_BUDGET' } }
    assets = ratioRoom
  }
  // HRV-R7 (review of #392, P1): sized down to what the V4 room leaves after the all-positions reserve, so a room that
  // replenishes in parts still takes the savings in parts; under the floor it waits.
  const fits = reinvestRoomOf(obs, policy)
  if (fits !== null && fits < assets) {
    if (fits < floor) return { proposal: null, wait: { bucket: b.id, code: 'DECIDE_WAIT_BUDGET' } }
    assets = fits
  }
  return { proposal: { kind: 'vault_deposit', grant: grantKeyFor(policy, 'vault-supply', v.name) as `vault-supply:${string}`, bucket: b.id, pool: v.name, vault: v.name, assets, savings: true }, wait: null }
}
