// Lab (#101 round 3): stables depeg guard. Pure; read only by a policy with `depegGuard`.
import type { DepegGuard, PolicyVersion } from '@mamoru/policy'
import { depthOf } from '../depth/index.ts'
import { anyKey, isManaged } from '../rerange/index.ts'
import type { EnterSwapProposal, Observation, PoolObs, ReduceProposal } from '../types.ts'
import { inSavings, opCostInSavings, volatileOf } from '../value.ts'

/** What the engine keeps between reviews: when the deviation went over the threshold, when it came back under release. */
export type PegState = { tripped: boolean; beyondSince: number | null; withinSince: number | null }

export const PEG_CLEAR: PegState = { tripped: false, beyondSince: null, withinSince: null }

/**
 * Deviation from 1.0 of a stable/stable pool's price at `tick`, in bps, either side. Both tokens of the Lab's stables
 * pool have 6 decimals, so tick 0 is parity. A pool of tokens with other decimals would need the decimal shift.
 */
export function pegDeviationBps(tick: number): number {
  return Math.round(Math.abs(1.0001 ** tick - 1) * 10_000)
}

/**
 * One step of the guard at time `now` with the deviation measured there (null: no TWAP; the state holds, the guard
 * neither trips nor releases on missing data). Trips once the deviation has been at or over the threshold for
 * `holdSeconds` without a break; releases once it has been under `releaseBps` for `releaseSeconds`.
 */
export function pegStep(prev: PegState, now: number, deviationBps: number | null, rule: DepegGuard): PegState {
  if (deviationBps === null) return prev
  const beyondSince = deviationBps >= rule.thresholdBps ? (prev.beyondSince ?? now) : null
  const withinSince = deviationBps < rule.releaseBps ? (prev.withinSince ?? now) : null
  let tripped = prev.tripped
  if (!tripped && beyondSince !== null && now - beyondSince >= rule.holdSeconds) tripped = true
  else if (tripped && withinSince !== null && now - withinSince >= rule.releaseSeconds) tripped = false
  return { tripped, beyondSince, withinSince }
}

/** The stables pool of the policy, when the guard is set and the engine reports it tripped. */
export function depeggedPool(obs: Observation, policy: PolicyVersion): PoolObs | null {
  if (!policy.depegGuard || !obs.guard?.peg?.tripped) return null
  const name = policy.buckets.find((b) => b.id === 'stables')?.pools[0]
  return (name && obs.pools.find((p) => p.name === name)) || null
}

/**
 * `exit` while tripped: close the stables position (a reduce of all its liquidity: decrease + collect to the Safe),
 * then sell its non-savings token to savings, each sale no larger than `exitImpactBps` of impact allows. Null when
 * nothing is left to do, or the rest is under the op cost times the harvest factor.
 */
export function depegExitOf(obs: Observation, policy: PolicyVersion, pool: PoolObs): ReduceProposal | EnterSwapProposal | null {
  const rule = policy.depegGuard
  if (!rule || rule.action !== 'exit') return null
  const policyPools = new Set(policy.buckets.flatMap((b) => b.pools))
  const p = obs.positions.find((x) => x.pool === pool.name && x.liquidity > 0n && isManaged(x, policy, policyPools))
  if (p) return { kind: 'reduce', grant: anyKey(policy, 'manage-any', pool.name), pool: pool.name, tokenId: p.tokenId, liquidity: p.liquidity }
  const savings = policy.savingsAsset
  const token = volatileOf(pool, savings)
  const held = obs.balances[token] ?? 0n
  const floor = opCostInSavings(obs, savings) * BigInt(policy.harvest.costFactorBps)
  if (held === 0n || inSavings(pool, token, held, savings) * 10_000n <= floor) return null
  const room = depthOf(obs, { ...policy, depth: { maxImpactBps: rule.exitImpactBps, maxShareBps: 10_000 } }, pool, policy.range.widthTicksByPool?.[pool.name] ?? policy.range.widthTicks)?.sellRoom ?? 0n
  const amountIn = held < room ? held : room
  if (amountIn === 0n) return null
  return { kind: 'enter_swap', grant: anyKey(policy, 'convert-any', pool.name), pool: pool.name, tokenIn: token, tokenOut: savings, fee: pool.fee, amountIn }
}
