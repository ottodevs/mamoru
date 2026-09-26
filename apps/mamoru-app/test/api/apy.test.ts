import { describe, expect, test } from 'bun:test'
import type { ApyView } from '@mamoru/domain'
import type { ApyCache, Fetcher } from '../../src/api/apy/source.ts'
import { harness } from './helpers.ts'

const POOL = '0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef'
const NOW = new Date('2026-09-26T18:00:00Z')
const day = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()

function gecko(volume: { h1?: string; h24?: string }, reserve = '8760000') {
  return { data: { attributes: { reserve_in_usd: reserve, volume_usd: volume } } }
}

/** Fake upstream: routes by host, counts calls, can fail either source. */
function fakeFetch(bodies: { gecko?: unknown; llama?: unknown }) {
  const calls: string[] = []
  const fetcher: Fetcher = async (url) => {
    calls.push(url)
    const body = url.includes('geckoterminal') ? bodies.gecko : bodies.llama
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
  test('current APR from last-hour volume and 30-day mean from DefiLlama, no session needed', async () => {
    const { fetcher, calls } = fakeFetch({
      // 100k/h * 0.0005 * 8760 / 8.76M = 5%
      gecko: gecko({ h1: '100000', h24: '1' }),
      llama: { status: 'success', data: [{ timestamp: day(40), apy: 99 }, { timestamp: day(20), apy: 10 }, { timestamp: day(1), apy: 20 }] },
    })
    const { res, view } = await getApy(fetcher)
    expect(res.status).toBe(200)
    expect(view).toEqual({
      pool: POOL,
      currentPct: 5,
      currentWindow: '1h',
      currentSource: 'Pool fees, last hour · GeckoTerminal',
      monthlyPct: 15,
      monthlySource: '30-day mean · DefiLlama',
      asOf: NOW.toISOString(),
    })
    expect(calls.some((u) => u.endsWith(`/networks/base/pools/${POOL}`))).toBe(true)
    expect(calls.some((u) => u.endsWith('/chart/9c3c95ef-5e04-4c75-b7ec-6a59a9ea904b'))).toBe(true)
  })

  test('falls back to 24h volume and to the 7-day mean, and says so', async () => {
    const { fetcher } = fakeFetch({
      // 2.4M/day * 0.0005 * 365 / 8.76M = 5%
      gecko: gecko({ h1: '0', h24: '2400000' }),
      llama: { data: [{ timestamp: day(45), apy: 30, apyBase7d: 7.5 }] },
    })
    const { view } = await getApy(fetcher)
    expect(view.currentPct).toBe(5)
    expect(view.currentWindow).toBe('24h')
    expect(view.currentSource).toBe('Pool fees, last 24h · GeckoTerminal')
    expect(view.monthlyPct).toBe(7.5)
    expect(view.monthlySource).toBe('7-day mean · DefiLlama')
  })

  test('upstream failure returns nulls with the source, never a made-up number', async () => {
    const { fetcher } = fakeFetch({ llama: 'not json shape' })
    const { res, view } = await getApy(fetcher)
    expect(res.status).toBe(200)
    expect(view.currentPct).toBeNull()
    expect(view.currentSource).toBe('Pool fee data unavailable')
    expect(view.monthlyPct).toBeNull()
    expect(view.monthlySource).toBe('DefiLlama unavailable')
  })

  test('falls back to DefiLlama daily base APY when GeckoTerminal fails', async () => {
    const { fetcher } = fakeFetch({ llama: { data: [{ timestamp: day(1), apy: 12, apyBase: 10.5 }] } })
    const { view } = await getApy(fetcher)
    expect(view.currentPct).toBe(10.5)
    expect(view.currentSource).toBe('Pool fees, last 24h · DefiLlama')
  })

  test('caches successes and does not cache failures', async () => {
    const cache = memoryCache()
    const ok = fakeFetch({ gecko: gecko({ h1: '100000' }), llama: { data: [{ timestamp: day(1), apy: 12 }] } })
    await getApy(ok.fetcher, cache)
    await getApy(ok.fetcher, cache)
    expect(ok.calls.length).toBe(2)

    const down = fakeFetch({})
    const cold = memoryCache()
    await getApy(down.fetcher, cold)
    await getApy(down.fetcher, cold)
    // Each request tries GeckoTerminal, DefiLlama for the current fallback, and DefiLlama for the monthly mean.
    expect(down.calls.length).toBe(6)
  })
})
