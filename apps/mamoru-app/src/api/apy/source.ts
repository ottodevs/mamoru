import type { ApyView } from '@mamoru/domain'
import { conservadorLiveV2 } from '@mamoru/policy'
import { baseRegistry, entry } from '@mamoru/registry'

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>
/** The slice of the Workers Cache API used here; tests pass an in-memory one. */
export type ApyCache = { match(key: string): Promise<Response | undefined>; put(key: string, res: Response): Promise<void> }

/** The plan whose pools make up the reference APY until our positions earn fees. */
export const APY_POLICY = conservadorLiveV2

export type PlanPool = { name: string; address: string; fee: number; weight: number }

/** One pool per bucket, weighted by the bucket's preference (bps). */
export function planPools(policy = APY_POLICY): PlanPool[] {
  return policy.buckets.flatMap((b) => {
    const name = b.pools[0]
    if (!name) return []
    const e = entry(name, baseRegistry)
    return [{ name, address: e.address, fee: e.fee ?? 500, weight: b.preference }]
  })
}

const UA = { accept: 'application/json', 'user-agent': 'mamoru-app/1.0 (+https://mamoru.lol)' }
const GECKO = 'https://api.geckoterminal.com/api/v2/networks/base/pools/'
const CURRENT_TTL = 300
const MONTHLY_TTL = 3600
const STALE_TTL = 86_400
const DAY_MS = 86_400_000
const KEY = 'https://apy.mamoru.internal'

export const CURRENT_SOURCE = 'fee APR · GeckoTerminal'
export const MONTHLY_SOURCE = '30-day fee APR · GeckoTerminal'
/** Complete UTC days in the monthly window; every one must be there (a missing day is unread, never zero volume). */
const MONTH_DAYS = 30

const round2 = (n: number) => Math.round(n * 100) / 100
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : null
}

/** Fee APR from the last 24h of volume: volume * fee * 365 / reserve. The last hour is too noisy. */
export async function geckoApr(fetcher: Fetcher, address: string, feeTier: number): Promise<number | null> {
  try {
    const res = await fetcher(GECKO + address, { headers: UA })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: { attributes?: { volume_usd?: { h24?: unknown }; reserve_in_usd?: unknown } } }
    const a = body.data?.attributes
    const reserve = num(a?.reserve_in_usd)
    const h24 = num(a?.volume_usd?.h24)
    if (!reserve || reserve <= 0 || h24 === null) return null
    return ((h24 * (feeTier / 1_000_000) * 365) / reserve) * 100
  } catch {
    return null
  }
}

/** Current TVL of the pool (GeckoTerminal reserve_in_usd). */
async function geckoReserve(fetcher: Fetcher, address: string): Promise<number | null> {
  try {
    const res = await fetcher(GECKO + address, { headers: UA })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: { attributes?: { reserve_in_usd?: unknown } } }
    const reserve = num(body.data?.attributes?.reserve_in_usd)
    return reserve && reserve > 0 ? reserve : null
  } catch {
    return null
  }
}

/**
 * Mean daily USD volume over the last 30 complete UTC days, from GeckoTerminal `ohlcv/day` (row: [t, o, h, l, c, volume]).
 * Today's partial row is dropped; any missing day leaves the mean unread.
 */
export async function geckoMonthlyVolume(fetcher: Fetcher, address: string, now: Date): Promise<number | null> {
  try {
    const res = await fetcher(`${GECKO}${address}/ohlcv/day?limit=${MONTH_DAYS + 1}`, { headers: UA })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: { attributes?: { ohlcv_list?: unknown } } }
    const list = body.data?.attributes?.ohlcv_list
    if (!Array.isArray(list)) return null
    const today = Math.floor(now.getTime() / DAY_MS) * (DAY_MS / 1000)
    const byDay = new Map<number, number>()
    for (const r of list) {
      const v = Array.isArray(r) && typeof r[0] === 'number' ? num(r[5]) : null
      if (v !== null && v >= 0) byDay.set(r[0] as number, v)
    }
    let sum = 0
    for (let i = 1; i <= MONTH_DAYS; i++) {
      const v = byDay.get(today - i * (DAY_MS / 1000))
      if (v === undefined) return null
      sum += v
    }
    return sum / MONTH_DAYS
  } catch {
    return null
  }
}

/**
 * 30-day fee APR: mean daily volume of the last 30 days * fee * 365 / current reserve. DefiLlama's yields chart goes
 * paid on 2026-11-13 (otto/mamoru#248); the reserve is today's, GeckoTerminal keeps no free TVL history.
 */
export async function geckoMonthly(fetcher: Fetcher, address: string, feeTier: number, now: Date): Promise<number | null> {
  const [volume, reserve] = await Promise.all([geckoMonthlyVolume(fetcher, address, now), geckoReserve(fetcher, address)])
  if (volume === null || reserve === null) return null
  return ((volume * (feeTier / 1_000_000) * 365) / reserve) * 100
}

async function put(cache: ApyCache | null, key: string, ttl: number, value: unknown): Promise<void> {
  if (!cache) return
  const res = new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${ttl}` } })
  await cache.put(key, res).catch(() => undefined)
}

async function get<T>(cache: ApyCache | null, key: string): Promise<T | null> {
  if (!cache) return null
  try {
    const hit = await cache.match(key)
    return hit ? ((await hit.json()) as T) : null
  } catch {
    return null
  }
}

/** Serves a number from cache for ttl seconds; nulls are never cached. */
async function cached(cache: ApyCache | null, key: string, ttl: number, load: () => Promise<number | null>): Promise<number | null> {
  const hit = await get<number>(cache, key)
  if (typeof hit === 'number') return hit
  const value = await load()
  if (value !== null) await put(cache, key, ttl, value)
  return value
}

/** Per-pool current: GeckoTerminal 24h fee APR, then the last good value (1 day). */
function poolCurrent(fetcher: Fetcher, cache: ApyCache | null, p: PlanPool) {
  return cached(cache, `${KEY}/current/${p.address}`, CURRENT_TTL, async () => {
    const gecko = await geckoApr(fetcher, p.address, p.fee)
    if (gecko !== null) {
      await put(cache, `${KEY}/last-current/${p.address}`, STALE_TTL, gecko)
      return gecko
    }
    const last = await get<number>(cache, `${KEY}/last-current/${p.address}`)
    return typeof last === 'number' ? last : null
  })
}

function poolMonthly(fetcher: Fetcher, cache: ApyCache | null, p: PlanPool, now: Date) {
  return cached(cache, `${KEY}/monthly/${p.address}`, MONTHLY_TTL, () => geckoMonthly(fetcher, p.address, p.fee, now))
}

/** Weighted mean over the pools that have data; weights renormalize over those. */
export function combine(values: (number | null)[], weights: number[]): { pct: number | null; covered: number } {
  let sum = 0
  let w = 0
  let covered = 0
  values.forEach((v, i) => {
    const wi = weights[i] ?? 0
    if (v === null || wi <= 0) return
    sum += v * wi
    w += wi
    covered++
  })
  return { pct: w > 0 ? round2(sum / w) : null, covered }
}

function source(label: string, covered: number, total: number): string {
  if (covered === 0) return 'Plan pool data unavailable'
  const scope = covered === total ? 'Plan pools' : `Plan pools (${covered} of ${total} with data, reweighted)`
  return `${scope}, ${label}`
}

/**
 * One current and one monthly APY for the account. Before our positions earn fees this is a
 * reference: the plan's pools' APYs weighted by the policy's bucket weights.
 */
export async function apyView(fetcher: Fetcher, cache: ApyCache | null, now: Date, pools: PlanPool[] = planPools()): Promise<ApyView> {
  const weights = pools.map((p) => p.weight)
  const [current, monthly] = await Promise.all([
    Promise.all(pools.map((p) => poolCurrent(fetcher, cache, p))),
    Promise.all(pools.map((p) => poolMonthly(fetcher, cache, p, now))),
  ])
  const c = combine(current, weights)
  const m = combine(monthly, weights)
  return {
    pool: APY_POLICY.policyId,
    currentPct: c.pct,
    currentWindow: '24h',
    currentSource: source(CURRENT_SOURCE, c.covered, pools.length),
    monthlyPct: m.pct,
    monthlySource: source(MONTHLY_SOURCE, m.covered, pools.length),
    byPool: pools.map((p, i) => ({ pool: p.name, weight: p.weight, currentPct: round(current[i]), monthlyPct: round(monthly[i]) })),
    asOf: now.toISOString(),
  }
}

const round = (v: number | null | undefined): number | null => (v === null || v === undefined ? null : round2(v))
