import type { ApyView } from '@mamoru/domain'
import { entry } from '@mamoru/registry'

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>
/** The slice of the Workers Cache API used here; tests pass an in-memory one. */
export type ApyCache = { match(key: string): Promise<Response | undefined>; put(key: string, res: Response): Promise<void> }

/** The Conservador plan's live pool: Uniswap v3 USDC/cbBTC 0.05% on Base. */
export const APY_POOL = entry('pool:USDC/cbBTC/500')
/** DefiLlama yields id of that pool (found 2026-09-26 in yields.llama.fi/pools: Base, uniswap-v3, USDC-CBBTC, 0.05%). */
export const LLAMA_POOL_ID = '9c3c95ef-5e04-4c75-b7ec-6a59a9ea904b'

const UA = { accept: 'application/json', 'user-agent': 'mamoru-app/1.0 (+https://mamoru.lol)' }
const GECKO = 'https://api.geckoterminal.com/api/v2/networks/base/pools/'
const LLAMA_CHART = 'https://yields.llama.fi/chart/'
const CURRENT_TTL = 60
const MONTHLY_TTL = 3600
const DAY_MS = 86_400_000

type Current = Pick<ApyView, 'currentPct' | 'currentWindow' | 'currentSource'>
type Monthly = Pick<ApyView, 'monthlyPct' | 'monthlySource'>

const round2 = (n: number) => Math.round(n * 100) / 100
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : null
}

/** Fee APR from recent volume: volume * fee * periods per year / reserve. Last hour, else last 24h. */
export async function currentApy(fetcher: Fetcher, pool: string, feeTier: number): Promise<Current> {
  const fail: Current = { currentPct: null, currentWindow: '1h', currentSource: 'GeckoTerminal unavailable' }
  try {
    const res = await fetcher(GECKO + pool, { headers: UA })
    if (!res.ok) return fail
    const body = (await res.json()) as { data?: { attributes?: { volume_usd?: { h1?: unknown; h24?: unknown }; reserve_in_usd?: unknown } } }
    const a = body.data?.attributes
    const reserve = num(a?.reserve_in_usd)
    if (!reserve || reserve <= 0) return fail
    const fee = feeTier / 1_000_000
    const h1 = num(a?.volume_usd?.h1)
    if (h1 !== null && h1 > 0) {
      return { currentPct: round2(((h1 * fee * 8760) / reserve) * 100), currentWindow: '1h', currentSource: 'Pool fees, last hour · GeckoTerminal' }
    }
    const h24 = num(a?.volume_usd?.h24)
    if (h24 !== null) {
      return { currentPct: round2(((h24 * fee * 365) / reserve) * 100), currentWindow: '24h', currentSource: 'Pool fees, last 24h · GeckoTerminal' }
    }
    return fail
  } catch {
    return fail
  }
}

/** Fallback for the current rate: DefiLlama's latest daily base APY of the pool. */
export async function llamaSpotApy(fetcher: Fetcher, poolId: string): Promise<Current> {
  const fail: Current = { currentPct: null, currentWindow: '24h', currentSource: 'Pool fee data unavailable' }
  try {
    const res = await fetcher(LLAMA_CHART + poolId, { headers: UA })
    if (!res.ok) return fail
    const body = (await res.json()) as { data?: { apy?: unknown; apyBase?: unknown }[] }
    const last = body.data?.at(-1)
    const v = num(last?.apyBase) ?? num(last?.apy)
    return v === null ? fail : { currentPct: round2(v), currentWindow: '24h', currentSource: 'Pool fees, last 24h · DefiLlama' }
  } catch {
    return fail
  }
}

/** Mean of DefiLlama's daily APY points over the last 30 days; the latest 7-day mean if the window is empty. */
export async function monthlyApy(fetcher: Fetcher, poolId: string, now: Date): Promise<Monthly> {
  const fail: Monthly = { monthlyPct: null, monthlySource: 'DefiLlama unavailable' }
  try {
    const res = await fetcher(LLAMA_CHART + poolId, { headers: UA })
    if (!res.ok) return fail
    const body = (await res.json()) as { data?: { timestamp?: string; apy?: unknown; apyBase?: unknown; apyBase7d?: unknown }[] }
    const points = body.data ?? []
    const since = now.getTime() - 30 * DAY_MS
    const window = points
      .filter((p) => p.timestamp !== undefined && Date.parse(p.timestamp) >= since)
      .map((p) => num(p.apy) ?? num(p.apyBase))
      .filter((v): v is number => v !== null)
    if (window.length > 0) {
      return { monthlyPct: round2(window.reduce((s, v) => s + v, 0) / window.length), monthlySource: '30-day mean · DefiLlama' }
    }
    const last7 = num(points.at(-1)?.apyBase7d)
    return last7 === null ? fail : { monthlyPct: round2(last7), monthlySource: '7-day mean · DefiLlama' }
  } catch {
    return fail
  }
}

/** Serves a successful result from cache for ttl seconds; failures are never cached. */
async function cached<T>(cache: ApyCache | null, key: string, ttl: number, ok: (v: T) => boolean, load: () => Promise<T>): Promise<T> {
  if (cache) {
    try {
      const hit = await cache.match(key)
      if (hit) return (await hit.json()) as T
    } catch {
      // A cache fault only costs a fresh upstream call.
    }
  }
  const value = await load()
  if (cache && ok(value)) {
    const res = new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${ttl}` } })
    await cache.put(key, res).catch(() => undefined)
  }
  return value
}

const STALE_TTL = 86_400

async function remember(cache: ApyCache | null, key: string, value: unknown): Promise<void> {
  if (!cache) return
  const res = new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${STALE_TTL}` } })
  await cache.put(key, res).catch(() => undefined)
}

async function recall<T>(cache: ApyCache | null, key: string): Promise<T | null> {
  if (!cache) return null
  try {
    const hit = await cache.match(key)
    return hit ? ((await hit.json()) as T) : null
  } catch {
    return null
  }
}

export async function apyView(fetcher: Fetcher, cache: ApyCache | null, now: Date): Promise<ApyView> {
  const pool = APY_POOL.address
  const fee = APY_POOL.fee ?? 500
  const [current, monthly] = await Promise.all([
    cached<Current>(cache, `https://apy.mamoru.internal/current/${pool}`, CURRENT_TTL, (v) => v.currentPct !== null, async () => {
      const gecko = await currentApy(fetcher, pool, fee)
      if (gecko.currentPct !== null) {
        await remember(cache, `https://apy.mamoru.internal/last-current/${pool}`, gecko)
        return gecko
      }
      // GeckoTerminal rate-limits shared egress: last good value (1 day), then DefiLlama's daily figure.
      const last = await recall<Current>(cache, `https://apy.mamoru.internal/last-current/${pool}`)
      return last ?? llamaSpotApy(fetcher, LLAMA_POOL_ID)
    }),
    cached<Monthly>(cache, `https://apy.mamoru.internal/monthly/${LLAMA_POOL_ID}`, MONTHLY_TTL, (v) => v.monthlyPct !== null, () => monthlyApy(fetcher, LLAMA_POOL_ID, now)),
  ])
  return { pool, ...current, ...monthly, asOf: now.toISOString() }
}
