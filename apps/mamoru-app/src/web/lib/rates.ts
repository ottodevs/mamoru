import type { ApyView, FundingView } from '@mamoru/domain'
import { POLICIES, type BucketId } from '@mamoru/policy'
import { cbbtcToUsdc, DUST_USDC, type Split } from './money.ts'
import { poolName, poolTokens } from './positions.ts'

// otto/mamoru#193: the dashboard's rates, per position and for the account, from data the app already has:
// each position's USDC value (funding view) and each plan pool's own rates (apyView.byPool). Nothing here
// guesses: a rate without a source is null and the screen says n/a with the reason.

type Position = FundingView['positions'][number]

export type Bucket = 'Stable' | 'Balanced' | 'Growth'

const BUCKET_LABEL: Record<BucketId, Bucket> = { stables: 'Stable', 'btc-usdc': 'Balanced', risk: 'Growth' }
const STABLES = new Set(['USDC', 'USDT', 'EURC', 'DAI'])

/** The bucket a pool belongs to in Mamoru's plans; a pool no plan names is sorted by its tokens. */
export function bucketOf(pool: string | undefined, amounts?: Position['amounts']): Bucket {
  const name = poolName(pool)
  if (name) {
    for (const p of Object.values(POLICIES)) {
      const b = p.buckets.find((x) => x.pools.includes(name as never))
      if (b) return BUCKET_LABEL[b.id]
    }
  }
  const [a, b] = poolTokens(pool, amounts)
  if (STABLES.has(a) && STABLES.has(b)) return 'Stable'
  return a === 'cbBTC' || b === 'cbBTC' ? 'Balanced' : 'Growth'
}

export type PositionRate = {
  tokenId: string
  pool: string
  bucket: Bucket
  inRange: boolean
  /** USDC base units; null when a leg cannot be priced (see `unpriced`). */
  valueUsdc: bigint | null
  /** Tokens of this position with no USDC price in the view; empty when the value is known. */
  unpriced: string[]
  /** Share of working capital, 0..100; null when any position cannot be valued (a share of a partial total would be wrong). */
  sharePct: number | null
  /** Today's rate: 0 while out of range (it earns nothing), null when its pool has no rate today. */
  currentPct: number | null
  /** The pool's 30-day mean; null when the pool has no history. */
  monthlyPct: number | null
}

/**
 * A position's value in USDC base units from what the view carries: the operator's `valueUsdc`, else each leg's
 * own value, USDC at face, cbBTC at the observed pool price. A leg that none of those prices (USDT or WETH in a view
 * without values, or cbBTC with no price observed) leaves the value unknown, never counted as 0.
 */
export function valueOf(p: Position, price: bigint | null): { value: bigint | null; unpriced: string[] } {
  if (p.valueUsdc !== undefined) return { value: BigInt(p.valueUsdc), unpriced: [] }
  let sum = 0n
  const unpriced: string[] = []
  const leg = (token: string, amount: string | null, valueUsdc?: string) => {
    if (amount === '0') return
    if (valueUsdc !== undefined) sum += BigInt(valueUsdc)
    else if (token === 'USDC' && amount !== null) sum += BigInt(amount)
    else if (token === 'cbBTC' && amount !== null && price !== null) sum += cbbtcToUsdc(BigInt(amount), price)
    else unpriced.push(token)
  }
  if (p.amounts?.length) for (const a of p.amounts) leg(a.token, a.amount, a.valueUsdc)
  // An older view without `amounts` only carries the USDC and cbBTC legs: any other token's amount is unknown.
  else for (const t of poolTokens(p.pool)) leg(t, t === 'USDC' ? p.amountUsdc : t === 'cbBTC' ? p.amountCbbtc : null)
  return { value: unpriced.length ? null : sum, unpriced }
}

export function positionRates(f: FundingView, apy: ApyView | undefined, price: bigint | null = null): PositionRate[] {
  const valued = f.positions.map((p) => valueOf(p, price))
  const values = valued.map((v) => v.value)
  const known = values.every((v) => v !== null)
  const total = known ? values.reduce<bigint>((a, v) => a + v!, 0n) : 0n
  return f.positions.map((p, i) => {
    const name = poolName(p.pool)
    const src = name ? apy?.byPool?.find((b) => b.pool === name) : undefined
    const value = values[i]!
    return {
      tokenId: p.tokenId,
      pool: p.pool,
      bucket: bucketOf(p.pool, p.amounts),
      inRange: p.inRange,
      valueUsdc: value,
      unpriced: valued[i]!.unpriced,
      sharePct: known && total > 0n ? Number((value! * 10_000n) / total) / 100 : null,
      currentPct: !p.inRange ? 0 : src?.currentPct ?? null,
      monthlyPct: src?.monthlyPct ?? null,
    }
  })
}

/** Why a rate is n/a; null when there is a figure. */
export type RateGap = 'loading' | 'no-positions' | 'all-paused' | 'no-data' | 'no-value'

export type AccountRate = { pct: number | null; gap: RateGap | null; covered: number; of: number }

function weighted(rows: PositionRate[], pick: (r: PositionRate) => number | null): { pct: number | null; covered: number } {
  let sum = 0
  let w = 0
  let covered = 0
  for (const r of rows) {
    const v = pick(r)
    if (v === null || r.valueUsdc === null || r.valueUsdc <= 0n) continue
    const wi = Number(r.valueUsdc)
    sum += v * wi
    w += wi
    covered++
  }
  return { pct: w > 0 ? Math.round((sum / w) * 100) / 100 : null, covered }
}

/**
 * Current rate: today's rate of the positions earning now (in range), weighted by their USDC value. Paused
 * (out-of-range) positions are left out, as agreed with Brais on 20 Oct. A position whose pool has no rate
 * today is left out too, and `covered < of` says so.
 */
export function currentRate(rows: PositionRate[], apy: ApyView | undefined): AccountRate {
  if (!apy) return { pct: null, gap: 'loading', covered: 0, of: 0 }
  if (rows.length === 0) return { pct: null, gap: 'no-positions', covered: 0, of: 0 }
  const earning = rows.filter((r) => r.inRange)
  if (earning.length === 0) return { pct: null, gap: 'all-paused', covered: 0, of: 0 }
  // A position earning now that cannot be valued may hold most of the capital: no account rate rather than one
  // that leaves it out (otto/mamoru#193 review round 2). A pool with no rate today is left out and counted.
  if (earning.some((r) => r.valueUsdc === null)) return { pct: null, gap: 'no-value', covered: 0, of: earning.length }
  const { pct, covered } = weighted(earning, (r) => r.currentPct)
  return { pct, gap: pct === null ? 'no-data' : null, covered, of: earning.length }
}

/**
 * Monthly rate: each position's pool 30-day mean weighted by its USDC value, paused ones included (they hold
 * capital for the month). Before any position is open, the plan pools' mean the API already blends by bucket.
 */
export function monthlyRate(rows: PositionRate[], apy: ApyView | undefined): AccountRate & { plan: boolean } {
  if (!apy) return { pct: null, gap: 'loading', covered: 0, of: 0, plan: false }
  if (rows.length === 0) return { pct: apy.monthlyPct, gap: apy.monthlyPct === null ? 'no-data' : null, covered: 0, of: 0, plan: true }
  // Every position counts for the month, paused ones too: any unvalued one makes the rate n/a.
  if (rows.some((r) => r.valueUsdc === null)) return { pct: null, gap: 'no-value', covered: 0, of: rows.length, plan: false }
  const { pct, covered } = weighted(rows, (r) => r.monthlyPct)
  return { pct, gap: pct === null ? 'no-data' : null, covered, of: rows.length, plan: false }
}

/** The data source named in an ApyView source line ("Plan pools, 30-day mean · DefiLlama" -> "DefiLlama"). */
export function sourceName(line: string | undefined): string | null {
  if (!line) return null
  const i = line.lastIndexOf('·')
  return i >= 0 ? line.slice(i + 1).trim() : null
}

/** What the idle line says after the amount. */
export function idleReason(f: FundingView, s: Split): string {
  // A listed token (unpriced cbBTC, say) is idle even when its USDC value is unknown.
  if (s.idle < DUST_USDC && s.idleTokens.length === 0) return 'nothing idle'
  if (!f.active) return f.positions.length > 0 ? 'Mamoru is stopped' : 'Mamoru is not running yet'
  if (f.engine?.placing || f.progress) return 'being placed'
  return 'waiting to be placed'
}
