import { entry } from '@mamoru/registry'
import type { PolicyVersion } from '@mamoru/policy'
import { registryOf } from './gates/index.ts'
import { amountsForLiquidity, inSavings } from './value.ts'
import type { Observation, PoolDepthObs, PoolObs, ShadowRisk } from './types.ts'

/**
 * Packaging's exit-direction depth rules (Brais's risk document, Risk Monitor B "EEL" and E "exit slippage and position
 * ratio"; Execution Health Gate 3.3), shadow only. Per bucket (stables = Stables, btc-usdc = Bluechip, risk = Mercenary):
 * - `impactLimitBps`: the price impact at which the EEL (effective exit liquidity) is read off the curve;
 * - `eelMinUsd`: the EEL under it would EXIT (B);
 * - `exitSlippageBps`: quoted slippage (impact plus pool fee) of selling the position's non-USDC leg at or over it would EXIT (E);
 * - `positionRatioBps`: position value over EEL above it would EXIT.
 */
export const PACKAGING_EEL_RULES: Record<string, { impactLimitBps: number; eelMinUsd: number; exitSlippageBps: number; positionRatioBps: number }> = {
  stables: { impactLimitBps: 200, eelMinUsd: 600_000, exitSlippageBps: 300, positionRatioBps: 1000 },
  'btc-usdc': { impactLimitBps: 200, eelMinUsd: 350_000, exitSlippageBps: 300, positionRatioBps: 1000 },
  risk: { impactLimitBps: 500, eelMinUsd: 75_000, exitSlippageBps: 600, positionRatioBps: 500 },
}

/** Whole USD of the largest ladder step; an EEL with every step inside the limit is read as this ("10M or more"). */
export const PACKAGING_EEL_CAP_USD = 10_000_000

type Point = { s: number; i: number }

/** Impact assigned to the size where the ladder stopped (QuoterV2 reverted or gave nothing): the pool cannot fill it. */
export const PACKAGING_NULL_IMPACT_BPS = 10_000

/**
 * The curve up to its first null (a null stops the ladder), or null when it is not usable (malformed, or no good point).
 * A null after good points means the pool could not fill that size: it enters the curve as a point of 10,000 bps, so EEL and
 * exit slippage interpolate between the last good point and it. `complete`: all sizes were read (no null).
 */
function curveOf(d: PoolDepthObs | undefined): { pts: Point[]; complete: boolean } | null {
  if (!d || !Array.isArray(d.sizesUsd) || !Array.isArray(d.impactBps) || d.sizesUsd.length === 0 || d.sizesUsd.length !== d.impactBps.length) return null
  if (!Number.isFinite(d.feeBps) || d.feeBps < 0) return null
  const pts: Point[] = []
  let prev = 0
  let ended = false
  for (let k = 0; k < d.sizesUsd.length; k++) {
    const s = d.sizesUsd[k]!
    const i = d.impactBps[k]
    if (typeof s !== 'number' || !Number.isFinite(s) || s <= prev) return null
    prev = s
    if (i === null || i === undefined) {
      if (pts.length) pts.push({ s, i: PACKAGING_NULL_IMPACT_BPS })
      ended = true
      break
    }
    if (typeof i !== 'number' || !Number.isFinite(i) || i < 0) return null
    pts.push({ s, i })
  }
  // A first size that is already null leaves nothing to interpolate from: unread.
  if (!pts.length) return null
  return { pts, complete: !ended }
}

/** EEL in USD: the largest size whose impact is within `limitBps`, linear in size between ladder points, impact 0 at size 0. */
export function eelOf(pts: readonly Point[], complete: boolean, limitBps: number): { usd: number; atCap: boolean } {
  let prev: Point = { s: 0, i: 0 }
  for (const p of pts) {
    if (p.i > limitBps) return { usd: prev.s + ((limitBps - prev.i) * (p.s - prev.s)) / (p.i - prev.i), atCap: false }
    prev = p
  }
  // Every point is inside the limit: the last good size, or the cap when the whole ladder was read.
  return complete ? { usd: Math.max(prev.s, PACKAGING_EEL_CAP_USD), atCap: true } : { usd: prev.s, atCap: false }
}

/** Impact (bps) of selling `usd`, linear between curve points from (0, 0); `beyond` past the last point: the caller passes 10,000 when that point is a null (a size larger than one the pool cannot fill), null when it is real data (nothing is known above it). */
export function impactAt(pts: readonly Point[], usd: number, beyond: number | null = null): number | null {
  let prev: Point = { s: 0, i: 0 }
  for (const p of pts) {
    if (usd <= p.s) return prev.i + ((p.i - prev.i) * (usd - prev.s)) / (p.s - prev.s)
    prev = p
  }
  return beyond
}

const money = (usd: number): string => (usd >= 1_000_000 ? `${(usd / 1_000_000).toFixed(2)}M` : `${Math.round(usd / 1000).toLocaleString('en-US')}k`)

/**
 * otto/mamoru#101 phase 1c, shadow only: Packaging's EEL, exit slippage and position ratio for the policy pools that pair
 * USDC. Entries go to Decision.shadowRisk, outside the premise hash. Nothing when the observation carries no `poolDepth`
 * (not supplied) or the policy's savings asset is not USDC (sizes are dollars). A pool with no usable curve gets
 * RISK_POOL_DEPTH_UNREAD and nothing else (D8, FR-LC-007: never an exit on missing data).
 *
 * Exit sell size = the USD value, at the pool's slot0, of the non-USDC legs of all the account's positions in the pool (the
 * USDC leg needs no swap): what a full exit sells at once. Slippage is read at that combined size. The ratio uses the
 * account's whole value in the pool (both legs, principal at slot0, no uncollected fees) over the EEL. A null in the ladder
 * after good points is a size the pool cannot fill: a point of 10,000 bps, shared by EEL and slippage. A size past the last
 * point with no null to interpolate to is RISK_POOL_DEPTH_UNREAD ("beyond ladder"), never an exit.
 */
export function poolDepthShadowRisk(obs: Observation, policy: PolicyVersion, policyPools: ReadonlySet<string>): ShadowRisk[] {
  if (!obs.poolDepth || policy.savingsAsset !== 'USDC') return []
  const decimals = entry(policy.savingsAsset, registryOf(obs)).decimals
  if (decimals === undefined) return []
  const scale = 10 ** decimals
  const raw = (usd: number): string => BigInt(Math.round(usd * 10 ** Math.min(decimals, 6))).toString() + '0'.repeat(Math.max(0, decimals - 6))
  const out: ShadowRisk[] = []
  for (const name of [...policyPools].sort()) {
    const pool: PoolObs | undefined = obs.pools.find((p) => p.name === name)
    if (!pool || (pool.token0 !== policy.savingsAsset && pool.token1 !== policy.savingsAsset)) continue
    const bucket = policy.buckets.find((b) => b.pools.includes(name))?.id
    const rule = bucket ? PACKAGING_EEL_RULES[bucket] : undefined
    if (!rule) continue
    const depth = obs.poolDepth[name]
    const curve = curveOf(depth)
    if (!depth || !curve) {
      out.push({ code: 'RISK_POOL_DEPTH_UNREAD', pool: name, threshold: '0', label: depth ? 'no usable curve' : 'no depth' })
      continue
    }
    const eel = eelOf(curve.pts, curve.complete, rule.impactLimitBps)
    const eelLabel = `${eel.atCap ? '>=' : ''}${money(eel.usd)}`
    if (eel.usd < rule.eelMinUsd) {
      out.push({ code: 'RISK_POOL_EEL_LOW', pool: name, threshold: raw(rule.eelMinUsd), metric: raw(eel.usd), label: `EEL ${eelLabel} at ${rule.impactLimitBps} bps` })
    }
    // The account's positions in this pool, valued at slot0. A full exit sells the non-USDC legs of all of them together.
    let total = 0
    let sellUsd = 0
    const sellToken = pool.token0 === policy.savingsAsset ? pool.token1 : pool.token0
    for (const pos of obs.positions) {
      if (pos.pool !== name || pos.liquidity <= 0n) continue
      const { amount0, amount1 } = amountsForLiquidity(pool.sqrtPriceX96, pos.tickLower, pos.tickUpper, pos.liquidity)
      total += Number(inSavings(pool, pool.token0, amount0, policy.savingsAsset) + inSavings(pool, pool.token1, amount1, policy.savingsAsset)) / scale
      sellUsd += Number(inSavings(pool, sellToken, sellToken === pool.token0 ? amount0 : amount1, policy.savingsAsset)) / scale
    }
    if (sellUsd > 0) {
      const impact = impactAt(curve.pts, sellUsd, curve.complete ? null : PACKAGING_NULL_IMPACT_BPS)
      if (impact === null) {
        // Past every point the curve has, with no null point to say the pool cannot fill it: unknown, never an exit (D8).
        out.push({ code: 'RISK_POOL_DEPTH_UNREAD', pool: name, threshold: '0', label: `exit ${money(sellUsd)} beyond ladder` })
      } else {
        const slip = Math.round(impact + depth.feeBps)
        if (slip >= rule.exitSlippageBps) out.push({ code: 'RISK_EXIT_SLIPPAGE', pool: name, threshold: String(rule.exitSlippageBps), metric: String(slip), label: `exit ${money(sellUsd)}: ${slip} bps` })
      }
    }
    if (total > 0 && eel.usd > 0 && total * 10_000 > rule.positionRatioBps * eel.usd) {
      const bps = Math.round((total / eel.usd) * 10_000)
      out.push({ code: 'RISK_POSITION_RATIO', pool: name, threshold: String(rule.positionRatioBps), metric: String(bps), label: `${money(total)} / EEL ${eelLabel}` })
    }
  }
  return out
}
