import { describe, expect, test } from 'bun:test'
import type { ApyView } from '@mamoru/domain'
import { LLAMA_POOL_IDS, LLAMA_VAULT_IDS, planPools, type ApyCache, type Fetcher } from '../../src/api/apy/source.ts'
import { harness } from './helpers.ts'

// conservador-live-v2: 50% USDC/USDT 0.01%, 40% USDC/cbBTC 0.05%, 10% WETH/USDC 0.3%.
const STABLE = '0xD56da2B74bA826f19015E6B7Dd9Dae1903E85DA1'
const BTC = '0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef'
const RISK = '0x6c561B446416E1A00E8E93E221854d6eA4171372'
const ID = { [STABLE]: LLAMA_POOL_IDS['pool:USDC/USDT/100']!, [BTC]: LLAMA_POOL_IDS['pool:USDC/cbBTC/500']!, [RISK]: LLAMA_POOL_IDS['pool:WETH/USDC/3000']! }
const NOW = new Date('2026-09-26T18:00:00Z')
// otto/mamoru#210: the stables vaults, rated at their base APY (rewards on top must not count).
const VAULTS = { [LLAMA_VAULT_IDS['vault:gtUSDCp']!]: { status: 'success', data: [{ timestamp: new Date(NOW.getTime() - 86_400_000).toISOString(), apy: 6, apyBase: 4.8 }] }, [LLAMA_VAULT_IDS['vault:waBasUSDC']!]: { status: 'success', data: [{ timestamp: new Date(NOW.getTime() - 86_400_000).toISOString(), apy: 5.9, apyBase: 4.5 }] } }
const NO_VAULT_RATES = [
  { pool: 'vault:gtUSDCp', weight: 0, currentPct: null, monthlyPct: null },
  { pool: 'vault:waBasUSDC', weight: 0, currentPct: null, monthlyPct: null },
]
const day = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()

/** GeckoTerminal body whose 24h fee APR is exactly `pct` for a pool with the given fee tier. */
function gecko(pct: number, feeTier: number, h1 = '999999999') {
  const reserve = 1_000_000
  const h24 = ((pct / 100) * reserve) / ((feeTier / 1_000_000) * 365)
  return { data: { attributes: { reserve_in_usd: String(reserve), volume_usd: { h1, h24: String(h24) } } } }
}
const llama = (...points: { d: number; apy: number; apyBase?: number }[]) => ({
  status: 'success',
  data: points.map((p) => ({ timestamp: day(p.d), apy: p.apy, apyBase: p.apyBase ?? p.apy })),
})

/** Fake upstream keyed by pool address (GeckoTerminal) or DefiLlama id; missing keys answer 503. */
function fakeFetch(bodies: Record<string, unknown>) {
  const calls: string[] = []
  const fetcher: Fetcher = async (url) => {
    calls.push(url)
    const body = bodies[url.split('/').at(-1)!]
    if (body === undefined) return new Response('upstream down', { status: 503 })
    return Response.json(body)
  }
  return { fetcher, calls }
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
    const { fetcher, calls } = fakeFetch({
      [STABLE]: gecko(2, 100),
      [BTC]: gecko(5, 500),
      [RISK]: gecko(20, 3000),
      [ID[STABLE]]: llama({ d: 40, apy: 99 }, { d: 20, apy: 2 }, { d: 1, apy: 4 }),
      [ID[BTC]]: llama({ d: 1, apy: 10 }),
      [ID[RISK]]: llama({ d: 2, apy: 30 }),
      ...VAULTS,
    })
    const { res, view } = await getApy(fetcher)
    expect(res.status).toBe(200)
    expect(view).toEqual({
      pool: 'conservador-live-v2',
      // 0.5*2 + 0.4*5 + 0.1*20 = 5; the h1 figure is ignored.
      currentPct: 5,
      currentWindow: '24h',
      currentSource: 'Plan pools, fee APR · GeckoTerminal/DefiLlama',
      // 0.5*mean(2,4) + 0.4*10 + 0.1*30 = 8.5; the 40-day-old point is out of the window.
      monthlyPct: 8.5,
      monthlySource: 'Plan pools, 30-day mean · DefiLlama',
      byPool: [
        { pool: 'pool:USDC/USDT/100', weight: 5000, currentPct: 2, monthlyPct: 3 },
        { pool: 'pool:USDC/cbBTC/500', weight: 4000, currentPct: 5, monthlyPct: 10 },
        { pool: 'pool:WETH/USDC/3000', weight: 1000, currentPct: 20, monthlyPct: 30 },
        // Weight 0: a vault rates its own position, never the reference blend above (5 and 8.5 without them).
        { pool: 'vault:gtUSDCp', weight: 0, currentPct: 4.8, monthlyPct: 4.8 },
        { pool: 'vault:waBasUSDC', weight: 0, currentPct: 4.5, monthlyPct: 4.5 },
      ],
      asOf: NOW.toISOString(),
    })
    expect(calls.filter((u) => u.includes('geckoterminal')).length).toBe(3)
  })

  test('exposes the figure behind each pool, not only the blend', async () => {
    const { fetcher } = fakeFetch({
      [STABLE]: gecko(2, 100),
      // BTC has no GeckoTerminal data; falls back to DefiLlama's latest apyBase.
      [ID[STABLE]]: llama({ d: 1, apy: 2 }),
      [ID[BTC]]: llama({ d: 1, apy: 9, apyBase: 7 }),
      [ID[RISK]]: llama({ d: 1, apy: 50 }),
    })
    const { view } = await getApy(fetcher)
    expect(view.byPool).toEqual([
      { pool: 'pool:USDC/USDT/100', weight: 5000, currentPct: 2, monthlyPct: 2 },
      { pool: 'pool:USDC/cbBTC/500', weight: 4000, currentPct: 7, monthlyPct: 9 },
      // RISK has no GeckoTerminal data either; its current falls back to DefiLlama's latest apyBase (50).
      { pool: 'pool:WETH/USDC/3000', weight: 1000, currentPct: 50, monthlyPct: 50 },
      ...NO_VAULT_RATES,
    ])
  })

  test('falls back per pool to DefiLlama latest apyBase when GeckoTerminal fails', async () => {
    const { fetcher } = fakeFetch({
      [STABLE]: gecko(2, 100),
      [BTC]: gecko(5, 500),
      // RISK has no GeckoTerminal data.
      [ID[STABLE]]: llama({ d: 1, apy: 2 }),
      [ID[BTC]]: llama({ d: 1, apy: 5 }),
      [ID[RISK]]: llama({ d: 2, apy: 99 }, { d: 1, apy: 50, apyBase: 40 }),
    })
    const { view } = await getApy(fetcher)
    // 0.5*2 + 0.4*5 + 0.1*40 = 7
    expect(view.currentPct).toBe(7)
    expect(view.currentSource).toBe('Plan pools, fee APR · GeckoTerminal/DefiLlama')
  })

  test('renormalizes over pools with data and says so in the source', async () => {
    const { fetcher } = fakeFetch({
      // Stables pool has no data anywhere.
      [BTC]: gecko(5, 500),
      [RISK]: gecko(10, 3000),
      [ID[BTC]]: llama({ d: 1, apy: 4 }),
      [ID[RISK]]: llama({ d: 1, apy: 9 }),
    })
    const { view } = await getApy(fetcher)
    // (0.4*5 + 0.1*10) / 0.5 = 6 ; (0.4*4 + 0.1*9) / 0.5 = 5
    expect(view.currentPct).toBe(6)
    expect(view.monthlyPct).toBe(5)
    expect(view.currentSource).toBe('Plan pools (2 of 3 with data, reweighted), fee APR · GeckoTerminal/DefiLlama')
    expect(view.monthlySource).toBe('Plan pools (2 of 3 with data, reweighted), 30-day mean · DefiLlama')
  })

  test('every source down returns nulls with the source, never a made-up number', async () => {
    const { fetcher } = fakeFetch({ [ID[BTC]]: 'not json shape' })
    const { res, view } = await getApy(fetcher)
    expect(res.status).toBe(200)
    expect(view.currentPct).toBeNull()
    expect(view.monthlyPct).toBeNull()
    expect(view.currentSource).toBe('Plan pool data unavailable')
    expect(view.monthlySource).toBe('Plan pool data unavailable')
  })

  test('caches successes, not failures, and keeps the last good GeckoTerminal value for a day', async () => {
    const all = {
      [STABLE]: gecko(2, 100),
      [BTC]: gecko(5, 500),
      [RISK]: gecko(20, 3000),
      [ID[STABLE]]: llama({ d: 1, apy: 2 }),
      [ID[BTC]]: llama({ d: 1, apy: 5 }),
      [ID[RISK]]: llama({ d: 1, apy: 20 }),
      ...VAULTS,
    }
    const cache = memoryCache()
    const ok = fakeFetch(all)
    await getApy(ok.fetcher, cache)
    await getApy(ok.fetcher, cache)
    // Three pools (GeckoTerminal + DefiLlama monthly) and two vaults (DefiLlama current + monthly), then all from cache.
    expect(ok.calls.length).toBe(10)

    const down = fakeFetch({})
    const cold = memoryCache()
    await getApy(down.fetcher, cold)
    await getApy(down.fetcher, cold)
    // Per pool and request: GeckoTerminal, DefiLlama for the current fallback, DefiLlama for the monthly mean; per vault two.
    expect(down.calls.length).toBe(26)

    // Fresh current entries expire but last-good survives: GeckoTerminal down, value still served.
    const stale = memoryCache()
    await getApy(fakeFetch(all).fetcher, stale)
    for (const a of [STABLE, BTC, RISK]) await stale.put(`https://apy.mamoru.internal/current/${a}`, new Response('null'))
    const { view } = await getApy(fakeFetch({}).fetcher, stale)
    expect(view.currentPct).toBe(5)
  })
})
