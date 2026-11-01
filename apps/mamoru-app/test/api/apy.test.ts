import { describe, expect, test } from 'bun:test'
import type { ApyView } from '@mamoru/domain'
import { planPools, type ApyCache, type Fetcher } from '../../src/api/apy/source.ts'
import { harness } from './helpers.ts'

// conservador-live-v2: 50% USDC/USDT 0.01%, 40% USDC/cbBTC 0.05%, 10% WETH/USDC 0.3%.
const STABLE = '0xD56da2B74bA826f19015E6B7Dd9Dae1903E85DA1'
const BTC = '0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef'
const RISK = '0x6c561B446416E1A00E8E93E221854d6eA4171372'
const FEE: Record<string, number> = { [STABLE]: 100, [BTC]: 500, [RISK]: 3000 }
const NOW = new Date('2026-09-26T18:00:00Z')
const DAY = 86_400
const TODAY = Math.floor(NOW.getTime() / 1000 / DAY) * DAY
const RESERVE = 1_000_000

/** Daily volume that makes a fee APR of `pct` on the 1M reserve. */
const volumeFor = (pct: number, feeTier: number) => ((pct / 100) * RESERVE) / ((feeTier / 1_000_000) * 365)

/** GeckoTerminal pool body whose 24h fee APR is exactly `pct` for a pool with the given fee tier. */
function gecko(pct: number, feeTier: number, h1 = '999999999') {
  return { data: { attributes: { reserve_in_usd: String(RESERVE), volume_usd: { h1, h24: String(volumeFor(pct, feeTier)) } } } }
}

/**
 * GeckoTerminal ohlcv/day body: one row per complete day 1..30 back (plus today's partial row, which must be ignored),
 * with daily volumes whose mean is a fee APR of `pct`. `skip` drops those days back.
 */
function ohlcv(pct: number, feeTier: number, opts: { skip?: number[]; spread?: boolean } = {}) {
  const v = volumeFor(pct, feeTier)
  const rows: unknown[][] = [[TODAY, 1, 1, 1, 1, 999_999_999]]
  for (let d = 1; d <= 30; d++) {
    if (opts.skip?.includes(d)) continue
    // spread: alternate 0.5v and 1.5v, same mean.
    const vol = opts.spread ? (d % 2 ? v * 0.5 : v * 1.5) : v
    rows.push([TODAY - d * DAY, 1, 1, 1, 1, vol])
  }
  // A 40-day-old row is outside the window.
  rows.push([TODAY - 40 * DAY, 1, 1, 1, 1, 999_999_999])
  return { data: { attributes: { ohlcv_list: rows } } }
}

/** Fake GeckoTerminal keyed by pool address (pool body) or `<address>/ohlcv` (daily candles); missing keys answer 503. */
function fakeFetch(bodies: Record<string, unknown>) {
  const calls: string[] = []
  const fetcher: Fetcher = async (url) => {
    calls.push(url)
    const m = url.match(/pools\/(0x[0-9a-fA-F]+)(\/ohlcv)?/)
    const body = m ? bodies[m[2] ? `${m[1]}/ohlcv` : m[1]!] : undefined
    if (body === undefined) return new Response('upstream down', { status: 503 })
    return Response.json(body)
  }
  return { fetcher, calls }
}

/** Every pool with a current and a monthly APR. */
function pools(cur: Record<string, number>, month: Record<string, number>) {
  const out: Record<string, unknown> = {}
  for (const [a, pct] of Object.entries(cur)) out[a] = gecko(pct, FEE[a]!)
  for (const [a, pct] of Object.entries(month)) out[`${a}/ohlcv`] = ohlcv(pct, FEE[a]!)
  return out
}

function memoryCache(): ApyCache {
  const store = new Map<string, string>()
  return {
    match: async (k) => (store.has(k) ? new Response(store.get(k)) : undefined),
    put: async (k, res) => void store.set(k, await res.text()),
  }
}

async function getApy(fetcher: Fetcher, cache?: ApyCache) {
  const h = harness(() => NOW, { apyFetch: fetcher, ...(cache ? { apyCache: () => cache } : {}) })
  const res = await h.request('/api/apy')
  return { res, view: (await res.json()) as ApyView }
}

describe('GET /api/apy', () => {
  test('plan pools come from the policy buckets with their weights', () => {
    expect(planPools().map((p) => [p.address, p.fee, p.weight])).toEqual([
      [STABLE, 100, 5000],
      [BTC, 500, 4000],
      [RISK, 3000, 1000],
    ])
  })

  test('one current and one monthly value, weighted by bucket weights, no session needed', async () => {
    const { fetcher, calls } = fakeFetch(pools({ [STABLE]: 2, [BTC]: 5, [RISK]: 20 }, { [STABLE]: 3, [BTC]: 10, [RISK]: 30 }))
    const { res, view } = await getApy(fetcher)
    expect(res.status).toBe(200)
    expect(view).toEqual({
      pool: 'conservador-live-v2',
      // 0.5*2 + 0.4*5 + 0.1*20 = 5; the h1 figure is ignored.
      currentPct: 5,
      currentWindow: '24h',
      currentSource: 'Plan pools, fee APR · GeckoTerminal',
      // 0.5*3 + 0.4*10 + 0.1*30 = 8.5; today's partial row and the 40-day-old row are out of the window.
      monthlyPct: 8.5,
      monthlySource: 'Plan pools, 30-day fee APR · GeckoTerminal',
      byPool: [
        { pool: 'pool:USDC/USDT/100', weight: 5000, currentPct: 2, monthlyPct: 3 },
        { pool: 'pool:USDC/cbBTC/500', weight: 4000, currentPct: 5, monthlyPct: 10 },
        { pool: 'pool:WETH/USDC/3000', weight: 1000, currentPct: 20, monthlyPct: 30 },
      ],
      asOf: NOW.toISOString(),
    })
    // No DefiLlama, ever (its yields API goes paid on 2026-11-13, otto/mamoru#248).
    expect(calls.every((u) => u.startsWith('https://api.geckoterminal.com/'))).toBe(true)
    expect(calls.filter((u) => u.includes('/ohlcv/day?limit=31')).length).toBe(3)
  })

  test('the monthly figure is the mean of the daily volumes, not the last day', async () => {
    const { fetcher } = fakeFetch({ [STABLE]: gecko(2, 100), [`${STABLE}/ohlcv`]: ohlcv(4, 100, { spread: true }) })
    const { view } = await getApy(fetcher)
    expect(view.byPool?.[0]!.monthlyPct).toBe(4)
  })

  test('a missing day leaves the monthly figure unread, never counted as zero volume', async () => {
    const { fetcher } = fakeFetch({
      ...pools({ [STABLE]: 2, [BTC]: 5, [RISK]: 20 }, { [BTC]: 10, [RISK]: 30 }),
      [`${STABLE}/ohlcv`]: ohlcv(3, 100, { skip: [17] }),
    })
    const { view } = await getApy(fetcher)
    expect(view.byPool?.[0]!.monthlyPct).toBeNull()
    // (0.4*10 + 0.1*30) / 0.5 = 14
    expect(view.monthlyPct).toBe(14)
    expect(view.monthlySource).toBe('Plan pools (2 of 3 with data, reweighted), 30-day fee APR · GeckoTerminal')
  })

  test('no reserve, no monthly figure: candles alone do not make an APR', async () => {
    const { fetcher } = fakeFetch({ [`${STABLE}/ohlcv`]: ohlcv(3, 100) })
    const { view } = await getApy(fetcher)
    expect(view.byPool?.[0]).toEqual({ pool: 'pool:USDC/USDT/100', weight: 5000, currentPct: null, monthlyPct: null })
  })

  test('renormalizes over pools with data and says so in the source', async () => {
    // Stables pool has no data anywhere.
    const { fetcher } = fakeFetch(pools({ [BTC]: 5, [RISK]: 10 }, { [BTC]: 4, [RISK]: 9 }))
    const { view } = await getApy(fetcher)
    // (0.4*5 + 0.1*10) / 0.5 = 6 ; (0.4*4 + 0.1*9) / 0.5 = 5
    expect(view.currentPct).toBe(6)
    expect(view.monthlyPct).toBe(5)
    expect(view.currentSource).toBe('Plan pools (2 of 3 with data, reweighted), fee APR · GeckoTerminal')
    expect(view.monthlySource).toBe('Plan pools (2 of 3 with data, reweighted), 30-day fee APR · GeckoTerminal')
  })

  test('every source down returns nulls with the source, never a made-up number', async () => {
    const { fetcher } = fakeFetch({ [`${BTC}/ohlcv`]: 'not json shape' })
    const { res, view } = await getApy(fetcher)
    expect(res.status).toBe(200)
    expect(view.currentPct).toBeNull()
    expect(view.monthlyPct).toBeNull()
    expect(view.currentSource).toBe('Plan pool data unavailable')
    expect(view.monthlySource).toBe('Plan pool data unavailable')
  })

  test('caches successes, not failures, and keeps the last good GeckoTerminal value for a day', async () => {
    const all = pools({ [STABLE]: 2, [BTC]: 5, [RISK]: 20 }, { [STABLE]: 2, [BTC]: 5, [RISK]: 20 })
    const cache = memoryCache()
    const ok = fakeFetch(all)
    await getApy(ok.fetcher, cache)
    await getApy(ok.fetcher, cache)
    // Per pool, once: the pool for the current APR, the pool and the candles for the monthly one.
    expect(ok.calls.length).toBe(9)

    const down = fakeFetch({})
    const cold = memoryCache()
    await getApy(down.fetcher, cold)
    await getApy(down.fetcher, cold)
    expect(down.calls.length).toBe(18)

    // Fresh current entries expire but last-good survives: GeckoTerminal down, value still served.
    const stale = memoryCache()
    await getApy(fakeFetch(all).fetcher, stale)
    for (const a of [STABLE, BTC, RISK]) await stale.put(`https://apy.mamoru.internal/current/${a}`, new Response('null'))
    const { view } = await getApy(fakeFetch({}).fetcher, stale)
    expect(view.currentPct).toBe(5)
  })
})
