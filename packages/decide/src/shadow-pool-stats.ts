import { entry } from '@mamoru/registry'
import type { PolicyVersion } from '@mamoru/policy'
import { registryOf } from './gates/index.ts'
import type { Observation, PoolStatsObs, ShadowRisk } from './types.ts'

/**
 * Packaging's pool monitor (Brais's risk document, sections A "TVL" and C "Volume"), shadow only. Per bucket: V/TVL 7d
 * minimum in bps and the absolute 7d volume floor in whole USD.
 */
export const PACKAGING_VOLUME_RULES: Record<string, { ratioBps: bigint; floorUsd: number }> = {
  stables: { ratioBps: 3500n, floorUsd: 1_000_000 }, // Conservative 0.35x
  'btc-usdc': { ratioBps: 2500n, floorUsd: 300_000 }, // Bluechip 0.25x
  risk: { ratioBps: 500n, floorUsd: 20_000 }, // Mercenary 0.05x
}

/** TVL change limits in percent, at or under which the pool would EXIT. */
export const PACKAGING_TVL_DROP_PCT = [
  { window: '1d', pct: 12, key: 'tvl1dAgoUsd' },
  { window: '7d', pct: 20, key: 'tvl7dAgoUsd' },
  { window: '30d', pct: 30, key: 'tvl30dAgoUsd' },
] as const

/** Stables only: the last day's volume under this share (percent) of the 4-week daily average would EXIT. */
export const PACKAGING_STABLES_DAY_PCT = 30

const ok = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/**
 * otto/mamoru#101 phase 1b, shadow only: Packaging's TVL change and activity rules for the policy pools. Entries go to
 * Decision.shadowRisk, outside the premise hash. Nothing when the observation carries no `poolStats` (not supplied), or
 * the policy's savings asset is not USDC (amounts are in dollars). A pool with missing data gets RISK_POOL_STATS_UNREAD
 * (never an exit: D8, FR-LC-007) and the rules whose inputs exist are still evaluated.
 */
export function poolStatsShadowRisk(obs: Observation, policy: PolicyVersion, policyPools: ReadonlySet<string>): ShadowRisk[] {
  if (!obs.poolStats || policy.savingsAsset !== 'USDC') return []
  const decimals = entry(policy.savingsAsset, registryOf(obs)).decimals
  if (decimals === undefined) return []
  const raw = (usd: number): string => BigInt(Math.round(usd * 10 ** Math.min(decimals, 6))).toString() + '0'.repeat(Math.max(0, decimals - 6))
  const out: ShadowRisk[] = []
  for (const name of [...policyPools].sort()) {
    const bucket = policy.buckets.find((b) => b.pools.includes(name))?.id
    const s: PoolStatsObs | undefined = obs.poolStats[name]
    if (!s) {
      out.push({ code: 'RISK_POOL_STATS_UNREAD', pool: name, threshold: '0', label: 'no stats' })
      continue
    }
    const missing: string[] = []
    const tvl = s.tvlUsd
    if (!ok(tvl) || tvl <= 0) missing.push('tvl')
    else {
      for (const d of PACKAGING_TVL_DROP_PCT) {
        const ago = s[d.key]
        if (!ok(ago) || ago <= 0) {
          missing.push(`tvl${d.window}`)
          continue
        }
        // tvl <= ago * (1 - pct/100), in integers of percent so the limit itself fires.
        if (tvl * 100 <= ago * (100 - d.pct)) {
          const bps = Math.round(((tvl - ago) / ago) * 10_000)
          out.push({ code: 'RISK_POOL_TVL_DROP', pool: name, window: d.window, threshold: String(-d.pct * 100), metric: String(bps), label: `${(bps / 100).toFixed(1)}% ${d.window}` })
        }
      }
    }
    const rule = bucket ? PACKAGING_VOLUME_RULES[bucket] : undefined
    if (rule) {
      if (!ok(s.volume7dUsd)) missing.push('volume7d')
      else if (ok(tvl) && tvl > 0) {
        const byRatio = (tvl * Number(rule.ratioBps)) / 10_000
        const min = Math.max(byRatio, rule.floorUsd)
        if (s.volume7dUsd < min) out.push({ code: 'RISK_POOL_VOLUME_LOW', pool: name, window: '7d', threshold: raw(min), metric: raw(s.volume7dUsd), label: `${(s.volume7dUsd / tvl).toFixed(2)}x V/TVL 7d` })
      }
      if (bucket === 'stables') {
        if (!ok(s.volumeLastDayUsd)) missing.push('volumeLastDay')
        if (!ok(s.volume28dAvgUsd)) missing.push('volume28dAvg')
        if (ok(s.volumeLastDayUsd) && ok(s.volume28dAvgUsd) && s.volumeLastDayUsd * 100 < s.volume28dAvgUsd * PACKAGING_STABLES_DAY_PCT) {
          out.push({ code: 'RISK_POOL_VOLUME_LOW', pool: name, window: '28d', threshold: raw((s.volume28dAvgUsd * PACKAGING_STABLES_DAY_PCT) / 100), metric: raw(s.volumeLastDayUsd), label: `last day ${Math.round(s.volumeLastDayUsd).toLocaleString('en-US')} vs avg ${Math.round(s.volume28dAvgUsd).toLocaleString('en-US')}` })
        }
      }
    }
    if (missing.length) out.push({ code: 'RISK_POOL_STATS_UNREAD', pool: name, threshold: '0', label: `missing ${missing.join(',')}` })
  }
  return out
}
