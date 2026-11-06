import type { ReasonCode } from '@mamoru/domain'
import { hasManageAny, type PolicyVersion } from '@mamoru/policy'
import type { RegistryName } from '@mamoru/registry'
import { convertKey, positionValue } from '../rerange/index.ts'
import type { EnterSwapProposal, HarvestProposal, Observation, PoolObs, PositionObs } from '../types.ts'
import { inSavings, opCostInSavings } from '../value.ts'

export type FeeEstimate = { fees0: bigint; fees1: bigint; feesValue: bigint; costValue: bigint; aboveCost: boolean }

function sub0(a: bigint, b: bigint): bigint {
  return a > b ? a - b : 0n
}

/** FR-DEC-009 and FR-DEC-015: fees are what is collectable above the principal owed, compared with the op cost times the policy factor. */
export function estimateFees(obs: Observation, policy: PolicyVersion, position: PositionObs, pool: PoolObs): FeeEstimate {
  const savings = policy.savingsAsset
  const fees0 = sub0(position.collectable0, position.principalOwed0)
  const fees1 = sub0(position.collectable1, position.principalOwed1)
  const feesValue = inSavings(pool, pool.token0, fees0, savings) + inSavings(pool, pool.token1, fees1, savings)
  const costValue = opCostInSavings(obs, savings)
  const aboveCost = feesValue > 0n && feesValue * 10_000n > costValue * BigInt(policy.harvest.costFactorBps)
  return { fees0, fees1, feesValue, costValue, aboveCost }
}

/**
 * A managed position whose fees beat the cost gets a harvest proposal. It only collects (otto/mamoru#140): a
 * conversion in the same batch swapped an amount fixed before inclusion, which could be principal if the fees were
 * collected elsewhere first (FR-UNI-005). The volatile fees stay in the account for a later sell-back or entry.
 */
export function harvestOf(position: PositionObs, pool: PoolObs, policy: PolicyVersion, est: FeeEstimate): { code: ReasonCode; proposal: HarvestProposal | null } {
  if (!est.aboveCost) return { code: 'DECIDE_HARVEST_BELOW_COST', proposal: null }
  return {
    code: 'DECIDE_HARVEST',
    proposal: {
      kind: 'harvest',
      grant: `manage:${position.tokenId}`,
      pool: pool.name,
      tokenId: position.tokenId,
      fees0: est.fees0,
      fees1: est.fees1,
      convert: null,
    },
  }
}

/** otto/mamoru#107 (spec 012 HRV-R2): after this long, harvested volatile is sold once it beats its op cost once, not 3x. */
export const HARVEST_SALE_AGE_SECONDS = 7n * 86_400n
/**
 * otto/mamoru#107 (spec 012 HRV-R7): the spending room a re-mint of every position needs, as a share (bps) of their
 * value: the mint itself (1.0) plus the swap that re-centres it, at most half the position (0.5). An upper bound.
 */
export const REINVEST_RESERVE_BPS = 15_000n

/** Harvested volatile the Safe still holds, per token: what a harvest collected and no sale or spend has used. */
export function harvestedHeld(obs: Observation, token: RegistryName): bigint {
  const h = obs.harvested?.[token]
  if (!h || h.amount <= 0n) return 0n
  const held = obs.balances[token] ?? 0n
  return h.amount < held ? h.amount : held
}

/**
 * The observation without the harvested volatile: what entries and idle sales see (spec 012 HRV-R1). The harvest sale
 * is the only thing that takes it. Without `obs.harvested` the same object, so every other decision hashes as before.
 */
export function principalObs(obs: Observation): Observation {
  if (!obs.harvested) return obs
  const balances = { ...obs.balances }
  for (const token of Object.keys(obs.harvested)) {
    const h = harvestedHeld(obs, token)
    if (h > 0n) balances[token] = (balances[token] ?? 0n) - h
  }
  return { ...obs, balances }
}

/**
 * V4 (spec 012 HRV-R7): a reinvestment worth `value` goes only if the spending room left after it still covers
 * re-minting every position on this chain. Without `obs.budget` (not V4) it always goes: the chain's own checks apply.
 */
export function reinvestFits(obs: Observation, policy: PolicyVersion, value: bigint): boolean {
  if (!obs.budget) return true
  const savings = policy.savingsAsset
  let lp = 0n
  for (const p of obs.positions) {
    const pool = p.pool ? obs.pools.find((x) => x.name === p.pool) : undefined
    if (pool && p.liquidity > 0n) lp += positionValue(p, pool, savings)
  }
  return obs.budget.room >= value + (lp * REINVEST_RESERVE_BPS) / 10_000n
}

export type HarvestSale = { proposal: EnterSwapProposal | null; waits: { bucket: string; code: ReasonCode }[] }

/**
 * otto/mamoru#107 (spec 012 HRV-R1, R2, R7): harvested volatile is sold to the savings asset in its own op, the amount
 * the harvests collected and the Safe still holds (never principal), through the first eligible policy pool that
 * pairs it. Worth no more than its op cost times the harvest factor (once the cost after 7 days) it waits and adds up;
 * on V4 it also waits while the spending room would not cover re-minting every position.
 */
export function harvestSaleOf(obs: Observation, policy: PolicyVersion): HarvestSale {
  const waits: HarvestSale['waits'] = []
  if (!obs.harvested || !hasManageAny(policy)) return { proposal: null, waits }
  const savings = policy.savingsAsset
  const cost = opCostInSavings(obs, savings)
  for (const token of Object.keys(obs.harvested).sort()) {
    if (token === savings) continue
    const amount = harvestedHeld(obs, token)
    if (amount === 0n) continue
    const at = policy.buckets.flatMap((b) => (b.exitOnly ? [] : b.pools.map((name) => ({ b, pool: obs.pools.find((x) => x.name === name) }))))
    const hit = at.find((x) => x.pool && (x.pool.token0 === token || x.pool.token1 === token) && (x.pool.token0 === savings || x.pool.token1 === savings))
    if (!hit?.pool) continue
    const value = inSavings(hit.pool, token, amount, savings)
    const aged = obs.block.timestamp - BigInt(obs.harvested[token]!.since) >= HARVEST_SALE_AGE_SECONDS
    const factor = aged ? 10_000n : BigInt(policy.harvest.costFactorBps)
    if (value * 10_000n <= cost * factor) {
      waits.push({ bucket: hit.b.id, code: 'DECIDE_WAIT_HARVEST_SALE' })
      continue
    }
    if (!reinvestFits(obs, policy, value)) {
      waits.push({ bucket: hit.b.id, code: 'DECIDE_WAIT_BUDGET' })
      continue
    }
    const pool = hit.pool
    return { proposal: { kind: 'enter_swap', grant: convertKey(policy, pool.name), pool: pool.name, tokenIn: token, tokenOut: savings, fee: pool.fee, amountIn: amount, harvestSale: true }, waits }
  }
  return { proposal: null, waits }
}
