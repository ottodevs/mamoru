import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PoolStatsCache, parseGeckoOhlcv, parseGeckoPool, parseLlamaChart } from '../src/pool-stats.ts'

const fx = (n: string): unknown => JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/pool-stats', n), 'utf8'))
const LLAMA = fx('llama-usdc-usdt-100.json')
const OHLCV = fx('gecko-ohlcv-usdc-usdt-100.json')
const POOL = fx('gecko-pool-usdc-usdt-100.json')
// 2026-10-31T05:46Z: the day the fixtures were taken (the first OHLCV row is 2026-10-31, in progress).
const NOW = Date.parse('2026-10-31T05:46:00Z')
const NOW_S = Math.floor(NOW / 1000)
const P = { name: 'pool:USDC/USDT/100', address: '0xD56da2B74bA826f19015E6B7Dd9Dae1903E85DA1', llamaId: 'ca2132ac-cd06-4b04-8130-ff2cd07ab934' }

type Res = { ok: boolean; status: number; json(): Promise<unknown> }
const okRes = (v: unknown): Res => ({ ok: true, status: 200, json: async () => v })

function fetcher(mode: { fail?: boolean; hang?: boolean } = {}) {
  const urls: string[] = []
  const headers: Record<string, string>[] = []
  const f = async (url: string, init: { headers: Record<string, string>; signal: AbortSignal }): Promise<Res> => {
    urls.push(url)
    headers.push(init.headers)
    if (mode.hang) return await new Promise<Res>((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))
    if (mode.fail) return { ok: false, status: 429, json: async () => ({}) }
    if (url.startsWith('https://yields.llama.fi/chart/')) return okRes(LLAMA)
    if (url.endsWith('/ohlcv/day?limit=29')) return okRes(OHLCV)
    return okRes(POOL)
  }
  return { f, urls, headers }
}

describe('parsers on real payloads', () => {
  test('DefiLlama chart: TVL 1d / 7d / 30d before now', () => {
    const p = parseLlamaChart(LLAMA, NOW_S)
    expect(p.tvl1dAgoUsd).toBeGreaterThan(0)
    expect(p.tvl7dAgoUsd).toBeGreaterThan(0)
    expect(p.tvl30dAgoUsd).toBeGreaterThan(0)
    // The latest fixture point is 2026-10-31T03:02Z (TVL 214,024): the 1d value is the point nearest 2026-10-30T03:02Z.
    const pts = (LLAMA as { data: { timestamp: string; tvlUsd: number }[] }).data
    const near = (days: number) => {
      const target = Date.parse(pts[pts.length - 1]!.timestamp) - days * 86_400_000
      return pts.reduce((a, b) => (Math.abs(Date.parse(b.timestamp) - target) < Math.abs(Date.parse(a.timestamp) - target) ? b : a)).tvlUsd
    }
    expect(p.tvl1dAgoUsd).toBe(near(1))
    expect(p.tvl7dAgoUsd).toBe(near(7))
    expect(p.tvl30dAgoUsd).toBe(near(30))
  })

  test('DefiLlama chart: anchored on now, so a series that stopped days ago has no 1d value (never an older point labelled 1d); no data is null', () => {
    const late = parseLlamaChart(LLAMA, NOW_S + 3 * 86_400)
    expect(late.tvl1dAgoUsd).toBeNull()
    // 7d before (now + 3d) is 4 days before the fixture's day: that point exists and is the one used.
    expect(late.tvl7dAgoUsd).toBeGreaterThan(0)
    expect(parseLlamaChart({ data: [] }, NOW_S).tvl7dAgoUsd).toBeNull()
    expect(parseLlamaChart('x', NOW_S).tvl7dAgoUsd).toBeNull()
  })

  test('GeckoTerminal ohlcv: the day in progress is dropped; 7d sum, last full day, 28d average', () => {
    const rows = ((OHLCV as { data: { attributes: { ohlcv_list: number[][] } } }).data.attributes.ohlcv_list)
    const complete = rows.filter((r) => r[0]! < Math.floor(NOW_S / 86_400) * 86_400).map((r) => r[5]!)
    const v = parseGeckoOhlcv(OHLCV, NOW_S)
    expect(v.volumeLastDayUsd).toBeCloseTo(complete[0]!, 6)
    expect(v.volume7dUsd).toBeCloseTo(complete.slice(0, 7).reduce((a, b) => a + b, 0), 6)
    expect(v.volume28dAvgUsd).toBeCloseTo(complete.slice(0, 28).reduce((a, b) => a + b, 0) / 28, 6)
  })

  test('GeckoTerminal ohlcv: a short history (young pool) has no 28d average; junk is null', () => {
    const short = { data: { attributes: { ohlcv_list: (OHLCV as { data: { attributes: { ohlcv_list: number[][] } } }).data.attributes.ohlcv_list.slice(0, 9) } } }
    const v = parseGeckoOhlcv(short, NOW_S)
    expect(v.volume7dUsd).not.toBeNull()
    expect(v.volume28dAvgUsd).toBeNull()
    expect(parseGeckoOhlcv({}, NOW_S)).toEqual({ volume7dUsd: null, volumeLastDayUsd: null, volume28dAvgUsd: null })
    // yesterday missing: the last day is unknown, not shifted
    const gap = { data: { attributes: { ohlcv_list: (OHLCV as { data: { attributes: { ohlcv_list: number[][] } } }).data.attributes.ohlcv_list.filter((_, i) => i !== 1) } } }
    expect(parseGeckoOhlcv(gap, NOW_S).volumeLastDayUsd).toBeNull()
    // a day missing inside the 7d window: unread, never summed as zero volume
    const inner = { data: { attributes: { ohlcv_list: (OHLCV as { data: { attributes: { ohlcv_list: number[][] } } }).data.attributes.ohlcv_list.filter((_, i) => i !== 4) } } }
    const v4 = parseGeckoOhlcv(inner, NOW_S)
    expect(v4.volumeLastDayUsd).not.toBeNull()
    expect(v4.volume7dUsd).toBeNull()
    expect(v4.volume28dAvgUsd).toBeNull()
  })

  test('GeckoTerminal pool: reserve_in_usd as a number', () => {
    expect(parseGeckoPool(POOL)).toBe(Number((POOL as { data: { attributes: { reserve_in_usd: string } } }).data.attributes.reserve_in_usd))
    expect(parseGeckoPool({})).toBeNull()
  })
})

describe('PoolStatsCache', () => {
  test('first read starts a refresh; stats arrive from memory; User-Agent set, no keys', async () => {
    const { f, urls, headers } = fetcher()
    const c = new PoolStatsCache([P], { fetch: f, now: () => NOW, gapMs: 0 })
    // nothing yet: an all-null entry, so the rule reports the pool unread instead of staying silent
    expect(c.get()[P.name]).toMatchObject({ tvlUsd: null, tvl7dAgoUsd: null, volume7dUsd: null, asOf: 0 })
    await c.settled()
    const s = c.get()[P.name]!
    expect(s.tvlUsd).toBeGreaterThan(0)
    expect(s.tvl7dAgoUsd).toBeGreaterThan(0)
    expect(s.volume7dUsd).toBeGreaterThan(0)
    expect(s.asOf).toBe(Math.floor(NOW / 1000))
    expect(urls).toHaveLength(3)
    expect(headers.every((h) => h['user-agent']?.startsWith('mamoru-operator/') && !('authorization' in h) && !('x-cg-pro-api-key' in h))).toBe(true)
  })

  test('at most one refresh per hour per pool', async () => {
    let t = NOW
    const { f, urls } = fetcher()
    const c = new PoolStatsCache([P], { fetch: f, now: () => t, gapMs: 0 })
    await c.settled()
    t += 59 * 60_000
    c.get()
    await c.settled()
    expect(urls).toHaveLength(3)
    t += 2 * 60_000
    await c.settled()
    expect(urls).toHaveLength(6)
  })

  test('a failed refresh keeps the last good value until the staleness limit, then null', async () => {
    let t = NOW
    let mode: { fail?: boolean } = {}
    const good = fetcher()
    const bad = fetcher({ fail: true })
    const c = new PoolStatsCache([P], { fetch: (u, i) => (mode.fail ? bad.f(u, i) : good.f(u, i)), now: () => t, gapMs: 0, staleMs: 6 * 3_600_000 })
    await c.settled()
    const before = c.get()[P.name]!
    mode = { fail: true }
    t += 3_700_000
    await c.settled()
    expect(c.get()[P.name]).toEqual(before) // kept
    t += 3 * 3_600_000
    await c.settled()
    expect(c.get()[P.name]).toEqual(before) // 2h50m... still within 6h of the good fetch
    t += 4 * 3_600_000
    await c.settled()
    const stale = c.get()[P.name]!
    expect(stale.tvlUsd).toBeNull()
    expect(stale.volume7dUsd).toBeNull()
    expect(stale.tvl7dAgoUsd).toBeNull()
  })

  test('each source goes stale on its own: OHLCV failing every hour does not keep old volumes alive behind a fresh pool read', async () => {
    let t = NOW
    let ohlcvFails = false
    const good = fetcher()
    const c = new PoolStatsCache([P], {
      fetch: (u, i) => (ohlcvFails && u.endsWith('/ohlcv/day?limit=29') ? Promise.resolve({ ok: false, status: 429, json: async () => ({}) }) : good.f(u, i)),
      now: () => t,
      gapMs: 0,
      staleMs: 6 * 3_600_000,
    })
    await c.settled()
    ohlcvFails = true
    for (let h = 0; h < 7; h++) {
      t += 3_700_000
      await c.settled()
    }
    const s = c.get()[P.name]!
    expect(s.tvlUsd).toBeGreaterThan(0)
    expect(s.tvl7dAgoUsd).toBeGreaterThan(0)
    expect(s.volume7dUsd).toBeNull()
    expect(s.volumeLastDayUsd).toBeNull()
  })

  test('own TVL series: with DefiLlama gone (paid from 2026-11-13), hourly samples carry the 1d and 7d lookbacks', async () => {
    let t = NOW
    let tvl = 300_000
    const good = fetcher()
    const c = new PoolStatsCache([P], {
      fetch: (u, i) => {
        if (u.startsWith('https://yields.llama.fi/')) return Promise.resolve({ ok: false, status: 402, json: async () => ({}) })
        if (!u.endsWith('/ohlcv/day?limit=29')) return Promise.resolve(okRes({ data: { attributes: { reserve_in_usd: String(tvl) } } }))
        return good.f(u, i)
      },
      now: () => t,
      gapMs: 0,
      staleMs: 6 * 3_600_000,
    })
    await c.settled()
    expect(c.get()[P.name]!.tvl1dAgoUsd).toBeNull() // no history yet
    for (let h = 0; h < 7 * 24; h++) {
      t += 3_600_000
      tvl -= 1_000
      await c.settled()
    }
    const s = c.get()[P.name]!
    expect(s.tvlUsd).toBe(tvl)
    expect(s.tvl1dAgoUsd).toBe(tvl + 24_000)
    expect(s.tvl7dAgoUsd).toBe(300_000)
    expect(s.tvl30dAgoUsd).toBeNull()
  })

  test('an OHLCV payload with a gap replaces older volumes: the gap reads unread, yesterday still counts', async () => {
    let t = NOW
    let gap = false
    const good = fetcher()
    const rows = (OHLCV as { data: { attributes: { ohlcv_list: number[][] } } }).data.attributes.ohlcv_list
    const c = new PoolStatsCache([P], {
      fetch: (u, i) => (gap && u.endsWith('/ohlcv/day?limit=29') ? Promise.resolve(okRes({ data: { attributes: { ohlcv_list: rows.filter((_, k) => k !== 4) } } })) : good.f(u, i)),
      now: () => t,
      gapMs: 0,
    })
    await c.settled()
    expect(c.get()[P.name]!.volume7dUsd).not.toBeNull()
    gap = true
    t += 3_700_000
    await c.settled()
    const s = c.get()[P.name]!
    expect(s.volume7dUsd).toBeNull()
    expect(s.volumeLastDayUsd).not.toBeNull()
  })

  test('a timeout keeps the last good value and never throws', async () => {
    let t = NOW
    let hang = false
    const good = fetcher()
    const slow = fetcher({ hang: true })
    const c = new PoolStatsCache([P], { fetch: (u, i) => (hang ? slow.f(u, i) : good.f(u, i)), now: () => t, gapMs: 0, timeoutMs: 20 })
    await c.settled()
    const before = c.get()[P.name]!
    hang = true
    t += 3_700_000
    await c.settled()
    expect(c.get()[P.name]).toEqual(before)
  })

  test('first fetch fails: nothing cached, then a null entry (unread) rather than silence', async () => {
    const c = new PoolStatsCache([P], { fetch: fetcher({ fail: true }).f, now: () => NOW, gapMs: 0 })
    await c.settled()
    expect(c.get()[P.name]).toMatchObject({ tvlUsd: null, volume7dUsd: null, tvl30dAgoUsd: null })
  })

  test('a source that failed is tried again after retryMs, not after the hour', async () => {
    let t = NOW
    let fail = true
    const good = fetcher()
    const bad = fetcher({ fail: true })
    const c = new PoolStatsCache([P], { fetch: (u, i) => (fail ? bad.f(u, i) : good.f(u, i)), now: () => t, gapMs: 0, retryMs: 300_000 })
    await c.settled()
    fail = false
    t += 200_000
    await c.settled()
    expect(c.get()[P.name]!.tvlUsd).toBeNull()
    t += 150_000
    await c.settled()
    expect(c.get()[P.name]!.tvlUsd).toBeGreaterThan(0)
  })

  test('a throwing fetch function is contained', async () => {
    const c = new PoolStatsCache([P], { fetch: () => { throw new Error('boom') }, now: () => NOW, gapMs: 0 })
    await c.settled()
    expect(() => c.get()).not.toThrow()
  })

  test('state file: written atomically, a new cache resumes from it without fetching inside the hour', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pool-stats-'))
    const stateFile = join(dir, 'pool-stats.json')
    const a = new PoolStatsCache([P], { fetch: fetcher().f, now: () => NOW, gapMs: 0, stateFile })
    await a.settled()
    expect(existsSync(stateFile)).toBe(true)
    expect(existsSync(`${stateFile}.tmp`)).toBe(false)
    const { f, urls } = fetcher()
    const b = new PoolStatsCache([P], { fetch: f, now: () => NOW + 60_000, gapMs: 0, stateFile })
    expect(b.get()[P.name]).toEqual(a.get()[P.name])
    expect((JSON.parse(readFileSync(stateFile, 'utf8')) as { cache: Record<string, { own?: unknown[] }> }).cache[P.name]!.own).toHaveLength(1)
    await b.settled()
    expect(urls).toHaveLength(0)
  })
})
