// Lab (#101, experiment 6): bucket preferences after a volatility target or CPPI. Pure; read only by a policy with
// `volTarget` or `cppi`.
import type { PolicyVersion } from '@mamoru/policy'
import { bucketValues } from '../rerange/index.ts'
import type { Observation } from '../types.ts'
import { inSavings, volatileOf } from '../value.ts'

const SCALE = 1_000_000

/**
 * The policy's buckets with the volatile preferences scaled down and the difference given to `stables`, or null when
 * the policy sets neither rule (or has no stables bucket to take the difference). Every allocation step then reads
 * these preferences, so a bucket over its new target is reduced, one operation per review, by the usual reduce.
 * - volTarget: scale = min(1, targetVolBps / realized 24 h volatility of the bucket's pool), with the bucket's
 *   current weight kept inside the band (see `VolTarget`); no volatility: 1.
 * - cppi: all volatile buckets share scale = min(1, multiplier * cushion / (account value * volatile share)), with
 *   cushion = value - floorBps of max(peak, value).
 */
/**
 * A scale on the grid of `step`: the grid level nearest the current weight among those inside [lo, hi], or the level
 * nearest the middle of the band when none is inside. On a grid, a price move of the holdings never moves the target.
 */
export function levelOf(lo: number, hi: number, cur: number, step: number): number {
  const s = Math.max(1, Math.min(SCALE, step))
  const levels: number[] = []
  for (let k = 0; k * s <= SCALE; k++) levels.push(k * s)
  if (levels.at(-1) !== SCALE) levels.push(SCALE)
  const inside = levels.filter((l) => l >= lo && l <= hi)
  const near = (to: number) => (best: number, l: number) => (Math.abs(l - to) < Math.abs(best - to) ? l : best)
  return inside.length > 0 ? inside.reduce(near(cur)) : levels.reduce(near((lo + hi) / 2))
}

export function weightTargets(obs: Observation, policy: PolicyVersion): PolicyVersion['buckets'] | null {
  if (!policy.volTarget && !policy.cppi) return null
  if (!policy.buckets.some((b) => b.id === 'stables')) return null
  let cppiScale = SCALE
  const values = bucketValues(obs, policy, new Set(policy.buckets.flatMap((b) => b.pools)))
  const prefTotal = policy.buckets.reduce((s, b) => s + b.preference, 0)
  if (policy.cppi) {
    const total = values.total
    const volPref = policy.buckets.filter((b) => b.id !== 'stables' && b.pools[0]).reduce((s, b) => s + b.preference, 0)
    if (total > 0n && volPref > 0) {
      const peak = obs.guard?.peakValue !== undefined && obs.guard.peakValue > total ? obs.guard.peakValue : total
      const floor = (peak * BigInt(policy.cppi.floorBps)) / 10_000n
      const cushion = total > floor ? total - floor : 0n
      const room = (cushion * BigInt(Math.round(policy.cppi.multiplier * 1000))) / 1000n
      const base = (total * BigInt(volPref)) / BigInt(prefTotal)
      cppiScale = base === 0n ? SCALE : Math.min(SCALE, Number((room * BigInt(SCALE)) / base))
    }
  }
  let freed = 0
  const out = policy.buckets.map((b) => {
    if (b.id === 'stables' || !b.pools[0]) return { ...b }
    let scale = cppiScale
    const vol = policy.volTarget ? (obs.guard?.pools[b.pools[0]]?.realizedVol24hBps ?? null) : null
    if (policy.volTarget && vol !== null && vol > 0) {
      const { targetVolBps, bandBps } = policy.volTarget
      const at = (v: number) => Math.min(SCALE, Math.floor((targetVolBps * SCALE) / v))
      const lo = at((vol * (10_000 + bandBps)) / 10_000)
      const hi = at((vol * 10_000) / (10_000 + bandBps))
      // The bucket's current weight (positions and the idle token of its pool, as allocate values it) against its
      // preference: kept while inside [lo, hi].
      const v = values.buckets.find((x) => x.bucket === b.id)
      const pool = obs.pools.find((x) => x.name === b.pools[0])
      const token = pool ? volatileOf(pool, policy.savingsAsset) : null
      const idle = pool && token ? inSavings(pool, token, obs.balances[token] ?? 0n, policy.savingsAsset) : 0n
      const held = (v?.value ?? 0n) + idle
      const cur = values.total === 0n ? 0 : Number((held * BigInt(prefTotal) * BigInt(SCALE)) / (values.total * BigInt(b.preference || 1)))
      scale = Math.min(scale, levelOf(lo, hi, cur, policy.volTarget.stepBps * (SCALE / 10_000)))
    }
    const preference = Math.floor((b.preference * Math.min(scale, SCALE)) / SCALE)
    freed += b.preference - preference
    return { ...b, preference }
  })
  for (const b of out) if (b.id === 'stables') b.preference += freed
  return out
}
