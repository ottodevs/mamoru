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

/** The curve up to its first null (a null stops the ladder), or null when it is not usable (malformed, or no point at all). */
function curveOf(d: PoolDepthObs | undefined): { pts: Point[]; complete: boolean } | null {
  if (!d || !Array.isArray(d.sizesUsd) || !Array.isArray(d.impactBps) || d.sizesUsd.length === 0 || d.sizesUsd.length !== d.impactBps.length) return null
  if (!Number.isFinite(d.feeBps) || d.feeBps < 0) return null
  const pts: Point[] = []
  let prev = 0
  for (let k = 0; k < d.sizesUsd.length; k++) {
    const s = d.sizesUsd[k]!
    const i = d.impactBps[k]
    if (typeof s !== 'number' || !Number.isFinite(s) || s <= prev) return null
    prev = s
    if (i === null || i === undefined) break
    if (typeof i !== 'number' || !Number.isFinite(i) || i < 0) return null
    pts.push({ s, i })
  }
  if (!pts.length) return null
  return { pts, complete: pts.length === d.sizesUsd.length }
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

/** Impact (bps) of selling `usd`, linear between ladder points from (0, 0); null beyond the last read point. */
export function impactAt(pts: readonly Point[], usd: number): number | null {
  let prev: Point = { s: 0, i: 0 }
  for (const p of pts) {
    if (usd <= p.s) return prev.i + ((p.i - prev.i) * (usd - prev.s)) / (p.s - prev.s)
    prev = p
  }
  return null
}

const money = (usd: number): string => (usd >= 1_000_000 ? `${(usd / 1_000_000).toFixed(2)}M` : `${Math.round(usd / 1000).toLocaleString('en-US')}k`)

/**
 * otto/mamoru#101 phase 1c, shadow only: Packaging's EEL, exit slippage and position ratio for the policy pools that pair
 * USDC. Entries go to Decision.shadowRisk, outside the premise hash. Nothing when the observation carries no `poolDepth`
 * (not supplied) or the policy's savings asset is not USDC (sizes are dollars). A pool with no usable curve gets
 * RISK_POOL_DEPTH_UNREAD and nothing else (D8, FR-LC-007: never an exit on missing data).
 *
 * Exit sell size of a position = the USD value, at the pool's slot0, of its non-USDC leg (the USDC leg needs no swap). The
 * slippage rule takes the worst position of the account in the pool; the ratio uses the account's whole value in the pool
 * (both legs of every position, principal at slot0, no uncollected fees) over the EEL.
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
    // The account's positions in this pool, valued at slot0.
    let total = 0
    let worst: { slip: number; label: string } | null = null
    for (const pos of obs.positions) {
      if (pos.pool !== name || pos.liquidity <= 0n) continue
      const { amount0, amount1 } = amountsForLiquidity(pool.sqrtPriceX96, pos.tickLower, pos.tickUpper, pos.liquidity)
      const valueRaw = inSavings(pool, pool.token0, amount0, policy.savingsAsset) + inSavings(pool, pool.token1, amount1, policy.savingsAsset)
      total += Number(valueRaw) / scale
      const sellToken = pool.token0 === policy.savingsAsset ? pool.token1 : pool.token0
      const sellRaw = inSavings(pool, sellToken, sellToken === pool.token0 ? amount0 : amount1, policy.savingsAsset)
      const sellUsd = Number(sellRaw) / scale
      if (sellUsd <= 0) continue
      const impact = impactAt(curve.pts, sellUsd)
      // Past the last point the curve was read to (liquidity ran out there): the exit would cost more than any limit.
      const slip = impact === null ? Number.POSITIVE_INFINITY : Math.round(impact + depth.feeBps)
      const label = impact === null ? `exit ${money(sellUsd)} beyond ladder` : `exit ${money(sellUsd)}: ${slip} bps`
      if (!worst || slip > worst.slip) worst = { slip, label }
    }
    if (worst && worst.slip >= rule.exitSlippageBps) {
      out.push({ code: 'RISK_EXIT_SLIPPAGE', pool: name, threshold: String(rule.exitSlippageBps), ...(Number.isFinite(worst.slip) ? { metric: String(worst.slip) } : {}), label: worst.label })
    }
    if (total > 0 && eel.usd > 0 && total * 10_000 > rule.positionRatioBps * eel.usd) {
      const bps = Math.round((total / eel.usd) * 10_000)
      out.push({ code: 'RISK_POSITION_RATIO', pool: name, threshold: String(rule.positionRatioBps), metric: String(bps), label: `${money(total)} / EEL ${eelLabel}` })
    }
  }
  return out
}
