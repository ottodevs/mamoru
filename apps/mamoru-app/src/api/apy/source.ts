import type { ApyView } from '@mamoru/domain'
import { conservadorLiveV2 } from '@mamoru/policy'
import { baseRegistry, entry } from '@mamoru/registry'

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>
/** The slice of the Workers Cache API used here; tests pass an in-memory one. */
export type ApyCache = { match(key: string): Promise<Response | undefined>; put(key: string, res: Response): Promise<void> }

/** The plan whose pools make up the reference APY until our positions earn fees. */
export const APY_POLICY = conservadorLiveV2

/**
 * DefiLlama yields ids of the plan's pools. Found 2026-09-26 in yields.llama.fi/pools
 * (chain Base, project uniswap-v3, fee tier from poolMeta; TVL matches GeckoTerminal's reserve).
 */
export const LLAMA_POOL_IDS: Record<string, string> = {
  'pool:USDC/USDT/100': 'ca2132ac-cd06-4b04-8130-ff2cd07ab934', // USDC-USDT 0.01%
  'pool:USDC/cbBTC/500': '9c3c95ef-5e04-4c75-b7ec-6a59a9ea904b', // USDC-CBBTC 0.05%
  'pool:WETH/USDC/3000': 'b99bcdf5-1350-4269-981e-0e9b5cccb007', // WETH-USDC 0.3%
}

export type PlanPool = { name: string; address: string; fee: number; llamaId: string; weight: number }

/** One pool per bucket, weighted by the bucket's preference (bps). */
export function planPools(policy = APY_POLICY): PlanPool[] {
  return policy.buckets.flatMap((b) => {
    const name = b.pools[0]
    const llamaId = name ? LLAMA_POOL_IDS[name] : undefined
    if (!name || !llamaId) return []
    const e = entry(name, baseRegistry)
    return [{ name, address: e.address, fee: e.fee ?? 500, llamaId, weight: b.preference }]
  })
}

const UA = { accept: 'application/json', 'user-agent': 'mamoru-app/1.0 (+https://mamoru.lol)' }
const GECKO = 'https://api.geckoterminal.com/api/v2/networks/base/pools/'
const LLAMA_CHART = 'https://yields.llama.fi/chart/'
const CURRENT_TTL = 300
const MONTHLY_TTL = 3600
const STALE_TTL = 86_400
const DAY_MS = 86_400_000
const KEY = 'https://apy.mamoru.internal'

export const CURRENT_SOURCE = 'fee APR · GeckoTerminal/DefiLlama'
export const MONTHLY_SOURCE = '30-day mean · DefiLlama'
/** otto/mamoru#248: figures from the operator's hourly GeckoTerminal stats (GeckoTerminal answers 429 to Cloudflare). */
export const OPERATOR_CURRENT_SOURCE = 'last-day fee APR · GeckoTerminal'
export const OPERATOR_MONTHLY_SOURCE = '28-day fee APR · GeckoTerminal'

/** One pool of the operator's GET /pool-stats; every field null until read (unread is never zero). */
export type OperatorPoolStats = { tvlUsd: number | null; volumeLastDayUsd: number | null; volume28dAvgUsd: number | null }
/** The operator's pool stats by pool name, or null when it is not configured or not reachable. */
export type OperatorStats = () => Promise<Record<string, OperatorPoolStats> | null>

const round2 = (n: number) => Math.round(n * 100) / 100
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : null
}

type Point = { timestamp?: string; apy?: unknown; apyBase?: unknown }

async function llamaChart(fetcher: Fetcher, poolId: string): Promise<Point[] | null> {
  try {
    const res = await fetcher(LLAMA_CHART + poolId, { headers: UA })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: Point[] }
    return Array.isArray(body.data) ? body.data : null
  } catch {
    return null
  }
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

/** DefiLlama's latest daily base APY of the pool. */
export async function llamaSpot(fetcher: Fetcher, poolId: string): Promise<number | null> {
  const last = (await llamaChart(fetcher, poolId))?.at(-1)
  return num(last?.apyBase) ?? num(last?.apy)
}

/** Mean of DefiLlama's daily APY points over the last 30 days. */
export async function llamaMonthly(fetcher: Fetcher, poolId: string, now: Date): Promise<number | null> {
  const points = await llamaChart(fetcher, poolId)
  if (!points) return null
  const since = now.getTime() - 30 * DAY_MS
  const window = points
    .filter((p) => p.timestamp !== undefined && Date.parse(p.timestamp) >= since)
    .map((p) => num(p.apy) ?? num(p.apyBase))
    .filter((v): v is number => v !== null)
  return window.length > 0 ? window.reduce((s, v) => s + v, 0) / window.length : null
}

/** Fee APR of a daily USD volume over a reserve; null unless both are read and the reserve is positive. */
export function feeApr(dailyVolume: number | null | undefined, feeTier: number, reserve: number | null | undefined): number | null {
  if (typeof dailyVolume !== 'number' || typeof reserve !== 'number' || !Number.isFinite(dailyVolume) || !(reserve > 0) || dailyVolume < 0) return null
  return ((dailyVolume * (feeTier / 1_000_000) * 365) / reserve) * 100
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

/** Per-pool current: GeckoTerminal 24h fee APR, then the last good value (1 day), then DefiLlama's latest daily figure. */
function poolCurrent(fetcher: Fetcher, cache: ApyCache | null, p: PlanPool, op: OperatorPoolStats | undefined) {
  const own = feeApr(op?.volumeLastDayUsd, p.fee, op?.tvlUsd)
  if (own !== null) return Promise.resolve({ v: own, operator: true })
  return cachedFallback(cache, `${KEY}/current/${p.address}`, CURRENT_TTL, async () => {
    const gecko = await geckoApr(fetcher, p.address, p.fee)
    if (gecko !== null) {
      await put(cache, `${KEY}/last-current/${p.address}`, STALE_TTL, gecko)
      return gecko
    }
    const last = await get<number>(cache, `${KEY}/last-current/${p.address}`)
    return typeof last === 'number' ? last : llamaSpot(fetcher, p.llamaId)
  })
}

function poolMonthly(fetcher: Fetcher, cache: ApyCache | null, p: PlanPool, now: Date, op: OperatorPoolStats | undefined) {
  const own = feeApr(op?.volume28dAvgUsd, p.fee, op?.tvlUsd)
  if (own !== null) return Promise.resolve({ v: own, operator: true })
  return cached(cache, `${KEY}/monthly/${p.llamaId}`, MONTHLY_TTL, () => llamaMonthly(fetcher, p.llamaId, now)).then((v) => ({ v, operator: false }))
}

/** The upstream path of a pool's current figure, tagged as not the operator's. */
function cachedFallback(cache: ApyCache | null, key: string, ttl: number, load: () => Promise<number | null>) {
  return cached(cache, key, ttl, load).then((v) => ({ v, operator: false }))
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
export async function apyView(fetcher: Fetcher, cache: ApyCache | null, now: Date, pools: PlanPool[] = planPools(), operator: OperatorStats = async () => null): Promise<ApyView> {
  const weights = pools.map((p) => p.weight)
  const stats = await operator().catch(() => null)
  const [current, monthly] = await Promise.all([
    Promise.all(pools.map((p) => poolCurrent(fetcher, cache, p, stats?.[p.name]))),
    Promise.all(pools.map((p) => poolMonthly(fetcher, cache, p, now, stats?.[p.name]))),
  ])
  const c = combine(current.map((x) => x.v), weights)
  const m = combine(monthly.map((x) => x.v), weights)
  return {
    pool: APY_POLICY.policyId,
    currentPct: c.pct,
    currentWindow: '24h',
    currentSource: source(labelOf(current, OPERATOR_CURRENT_SOURCE, CURRENT_SOURCE, CURRENT_SOURCE), c.covered, pools.length),
    monthlyPct: m.pct,
    monthlySource: source(labelOf(monthly, OPERATOR_MONTHLY_SOURCE, MONTHLY_SOURCE, '28/30-day mean · GeckoTerminal/DefiLlama'), m.covered, pools.length),
    byPool: pools.map((p, i) => ({ pool: p.name, weight: p.weight, currentPct: round(current[i]?.v), monthlyPct: round(monthly[i]?.v) })),
    asOf: now.toISOString(),
  }
}

/** The source line names what the shown figures came from: the operator's stats, upstream, or both. */
function labelOf(xs: { v: number | null; operator: boolean }[], own: string, upstream: string, mixed: string): string {
  const read = xs.filter((x) => x.v !== null)
  if (read.length > 0 && read.every((x) => x.operator)) return own
  return read.some((x) => x.operator) ? mixed : upstream
}

const OPERATOR_TTL = 300
export const OPERATOR_TIMEOUT_MS = 5_000
/** The operator drops a source after 6 h without a read (PoolStatsCache staleMs); a pool older than 7 h is refused here too. */
export const OPERATOR_MAX_AGE_S = 7 * 3600

/**
 * otto/mamoru#248: the Base operator's GET /pool-stats, signed like /metrics, kept 5 minutes in the Workers Cache (the
 * operator itself refreshes hourly). Null when unsigned, unreachable or malformed: the upstream path takes over.
 */
export function operatorPoolStats(url: string | undefined, secret: string | undefined, fetcher: Fetcher, cache: ApyCache | null, sign: (secret: string, path: string) => Promise<string>, now: Date): OperatorStats {
  // The age check runs on every read, cached or not: a cached pool keeps its asOf.
  const fresh = (pools: Record<string, OperatorPoolStats & { asOf: number }>) => {
    const out: Record<string, OperatorPoolStats> = {}
    for (const [name, p] of Object.entries(pools)) {
      if (now.getTime() / 1000 - p.asOf <= OPERATOR_MAX_AGE_S) out[name] = { tvlUsd: p.tvlUsd, volumeLastDayUsd: p.volumeLastDayUsd, volume28dAvgUsd: p.volume28dAvgUsd }
    }
    return out
  }
  return async () => {
    if (!url || !secret) return null
    const key = `${KEY}/operator-pool-stats`
    const hit = await get<Record<string, OperatorPoolStats & { asOf: number }>>(cache, key)
    if (hit && typeof hit === 'object') return fresh(hit)
    try {
      const res = await fetcher(url.replace(/\/+$/, '') + '/pool-stats', { headers: { 'x-mamoru-sig': await sign(secret, '/pool-stats'), accept: 'application/json' }, signal: AbortSignal.timeout(OPERATOR_TIMEOUT_MS) })
      if (res.status !== 200) return null
      const body = (await res.json()) as { chainId?: unknown; pools?: unknown }
      if (body.chainId !== 8453 || !body.pools || typeof body.pools !== 'object') return null
      const pools: Record<string, OperatorPoolStats & { asOf: number }> = {}
      for (const [name, v] of Object.entries(body.pools as Record<string, Record<string, unknown>>)) {
        if (!v || typeof v !== 'object') continue
        const asOf = num(v.asOf)
        if (asOf === null) continue
        pools[name] = { tvlUsd: num(v.tvlUsd), volumeLastDayUsd: num(v.volumeLastDayUsd), volume28dAvgUsd: num(v.volume28dAvgUsd), asOf }
      }
      await put(cache, key, OPERATOR_TTL, pools)
      return fresh(pools)
    } catch {
      return null
    }
  }
}

const round = (v: number | null | undefined): number | null => (v === null || v === undefined ? null : round2(v))
