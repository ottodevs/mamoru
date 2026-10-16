import { describe, expect, test } from 'bun:test'
import { conservadorLabGuardsV1, conservadorLiveV2 } from '@mamoru/policy'
import { syntheticDataset } from './fixtures.ts'
import { marketOfDataset, moveOf } from './market.ts'
import { runBacktest } from './run.ts'
import { aggregate, applyOverrides, cellMetrics, markdown, overridesFromAssignments, policyOf, sortCells, worstDayBps, type Cell, type CellMetrics } from './sweep.ts'
import { blockAt, LAB_WINDOWS, windowBlocks } from './windows.ts'

const H = 3600
const SLOW = 60_000

describe('worst day', () => {
  test('the largest fall from a high of the previous 24 hours', () => {
    // 100 -> 120 -> 90 inside one day: 25% from the high, not 10% from the start.
    expect(worstDayBps([0, H, 2 * H], [100n, 120n, 90n])).toBe(2500)
  })
  test('a high older than 24 hours does not count', () => {
    expect(worstDayBps([0, 25 * H, 26 * H], [200n, 100n, 95n])).toBe(500)
  })
  test('a high exactly 24 hours old still counts', () => {
    expect(worstDayBps([0, 24 * H], [200n, 100n])).toBe(5000)
  })
  test('a rising series has no worst day', () => {
    expect(worstDayBps([0, H, 2 * H], [1n, 2n, 3n])).toBe(0)
  })
  test('matches the quadratic definition on a noisy series', () => {
    const time: number[] = []
    const value: bigint[] = []
    let v = 1_000_000n
    for (let i = 0; i < 600; i++) {
      v += BigInt(((i * 7919) % 2001) - 1000) * 50n
      time.push(i * 600)
      value.push(v)
    }
    let worst = 0
    for (let i = 0; i < value.length; i++)
      for (let k = 0; k < i; k++) if (time[i]! - time[k]! <= 86_400 && value[k]! > value[i]!) worst = Math.max(worst, Number(((value[k]! - value[i]!) * 1_000_000n) / value[k]!) / 100)
    expect(worstDayBps(time, value)).toBe(worst)
  })
})

describe('market summary', () => {
  test('move, drawdown, worst day and volatility of a log-price path', () => {
    const lp = [0, Math.log(1.1), Math.log(0.88), Math.log(0.99)]
    const m = moveOf([0, H, 2 * H, 3 * H], lp)
    expect(m.move).toBeCloseTo(-0.01, 10)
    expect(m.maxDrawdown).toBeCloseTo(0.2, 10)
    expect(m.worstDay).toBeCloseTo(-0.2, 10)
    expect(m.vol).toBeGreaterThan(0)
  })
  test('a constant price has zero volatility and no drawdown', () => {
    const m = moveOf([0, 1, 2], [1, 1, 1])
    expect(m).toEqual({ move: 0, maxDrawdown: 0, worstDay: 0, vol: 0 })
  })
  test('the tick direction follows which token is priced', () => {
    // cbBTC is token1 of USDC/cbBTC: its tick falling means cbBTC rising. WETH is token0 of WETH/USDC.
    const ds = syntheticDataset({ samples: 3, tick: (k, i) => (k === 0 ? 0 : k === 1 ? -1000 * i : 1000 * i) })
    const m = marketOfDataset(ds)
    expect(m.btc!.move).toBeCloseTo(1.0001 ** 2000 - 1, 8)
    expect(m.eth!.move).toBeCloseTo(1.0001 ** 2000 - 1, 8)
    expect(m.usdtMaxOffPegBps!).toBeCloseTo((1 - 1.0001 ** -9) * 10_000, 6)
  })
})

describe('overrides', () => {
  test('nested parameters merge, the rest of the policy is kept', () => {
    const p = applyOverrides(conservadorLiveV2, { range: { cooldownSeconds: 3600 } })
    expect(p.range.cooldownSeconds).toBe(3600)
    expect(p.range.widthTicks).toBe(conservadorLiveV2.range.widthTicks)
    expect(p.range.widthTicksByPool).toEqual(conservadorLiveV2.range.widthTicksByPool)
    expect(p.buckets).toBe(conservadorLiveV2.buckets)
  })
  test('a typo is refused, not run as the baseline under a new name', () => {
    expect(() => applyOverrides(conservadorLiveV2, { range: { cooldownSecond: 3600 } })).toThrow('range.cooldownSecond')
  })
  test('lab guard thresholds can be changed per bucket and new buckets added', () => {
    const p = applyOverrides(conservadorLabGuardsV1, { guards: { byBucket: { risk: { fallFreeze: { fallBps: 500 } }, stables: { fallFreeze: { fallBps: 1, volBps: 1 } } } } })
    expect(p.guards!.byBucket.risk!.fallFreeze).toEqual({ fallBps: 500, volBps: 10_000 })
    expect(p.guards!.byBucket.stables!.fallFreeze).toEqual({ fallBps: 1, volBps: 1 })
    expect(p.guards!.byBucket['btc-usdc']).toEqual(conservadorLabGuardsV1.guards!.byBucket['btc-usdc'])
  })
  test('typos under guards are refused too', () => {
    expect(() => applyOverrides(conservadorLabGuardsV1, { guards: { byBuckt: {} } })).toThrow('guards.byBuckt')
    expect(() => applyOverrides(conservadorLabGuardsV1, { guards: { byBucket: { risk: { fallFreez: {} } } } })).toThrow('fallFreez')
    expect(() => applyOverrides(conservadorLabGuardsV1, { guards: { byBucket: { risk: { fallFreeze: { fallBp: 500 } } } } })).toThrow('fallBp')
    expect(() => applyOverrides(conservadorLabGuardsV1, { guards: { byBucket: { riks: {} } } })).toThrow('riks')
    expect(() => applyOverrides(conservadorLiveV2, { guards: { byBucket: { risk: { fallFreeze: { fallBps: 1, volBp: 1 } } } } })).toThrow('volBp')
  })
  test('a rule the base policy lacks must be given whole', () => {
    expect(() => applyOverrides(conservadorLiveV2, { guards: { byBucket: { risk: { fallFreeze: { fallBps: 500 } } } } })).toThrow('volBps')
    expect(applyOverrides(conservadorLiveV2, { guards: { byBucket: { risk: { fallFreeze: { fallBps: 500, volBps: 1 } } } } }).guards).toEqual({ byBucket: { risk: { fallFreeze: { fallBps: 500, volBps: 1 } } } })
  })
  test('a new pool width is accepted', () => {
    expect(applyOverrides(conservadorLiveV2, { range: { widthTicksByPool: { 'pool:WETH/USDC/3000': 4000 } } }).range.widthTicksByPool).toEqual({ 'pool:USDC/USDT/100': 40, 'pool:WETH/USDC/3000': 4000 })
  })
  test('"123n" from JSON becomes a bigint', () => {
    expect(applyOverrides(conservadorLiveV2, { minEntry: '5000000n' }).minEntry).toBe(5_000_000n)
  })
  test('--set assignments parse JSON values', () => {
    expect(overridesFromAssignments(['range.cooldownSeconds=3600', 'allocation=target-weights', 'range.widthTicksByPool={"pool:USDC/USDT/100":20}'])).toEqual({
      range: { cooldownSeconds: 3600, widthTicksByPool: { 'pool:USDC/USDT/100': 20 } },
      allocation: 'target-weights',
    })
  })
  test('a variant gets its own policy id; the baseline keeps the live one', () => {
    expect(policyOf({ name: 'conservador-live-v2', policy: 'conservador-live-v2' })).toBe(conservadorLiveV2)
    expect(policyOf({ name: 'cd1h', policy: 'conservador-live-v2', overrides: { range: { cooldownSeconds: 3600 } } }).policyId).toBe('conservador-live-v2+cd1h')
  })
})

describe('cell metrics', () => {
  test(
    'come from the run: return, vs hold, drawdown, ops, gas, fees, time out of range',
    () => {
      const ds = syntheticDataset({ samples: 400, tick: (k, i) => (k === 0 ? 0 : -Math.round(800 * Math.sin(i / 40))), growth: [1n << 100n, 1n << 100n, 1n << 100n] })
      const r = runBacktest(ds, conservadorLiveV2, { deposit: 1_000_000_000n })
      const m = cellMetrics(r, 6)
      expect(m.returnPct).toBe(r.metrics.returnBps / 100)
      expect(m.end).toBeCloseTo(Number(r.metrics.end) / 1e6, 9)
      expect(m.vsHoldPct).toBeCloseTo((Number(r.metrics.vsHodl) / Number(r.metrics.start)) * 100, 3)
      expect(m.maxDrawdownPct).toBe(r.metrics.maxDrawdownBps / 100)
      expect(m.worstDayPct).toBeLessThanOrEqual(m.maxDrawdownPct)
      expect(m.ops).toBe(Object.values(r.metrics.operations).reduce((a, b) => a + b, 0))
      expect(m.ops).toBeGreaterThan(0)
      expect(m.gas).toBeCloseTo(Number(r.metrics.gas) / 1e6, 9)
      expect(m.fees).toBeCloseTo(Number(r.metrics.fees) / 1e6, 9)
      expect(m.outOfRangePct).toBe((10_000 - r.metrics.timeInRangeBps) / 100)
      expect(cellMetrics(runBacktest(ds, conservadorLiveV2, { deposit: 1_000_000_000n }), 6)).toEqual(m)
    },
    SLOW,
  )
})

describe('report', () => {
  const metrics = (returnPct: number): CellMetrics => ({ returnPct, vsHoldPct: 0, end: 0, hold: 0, maxDrawdownPct: -returnPct, worstDayPct: 1, ops: 2, opsByKind: {}, refused: 0, gas: 0.5, fees: 1, outOfRangePct: 0, samples: 10, gaps: 0, resultHash: '0x' })
  const cell = (window: string, split: 'train' | 'test', variant: string, deposit: number, ret: number): Cell => ({ window, split, regime: 'calm', deposit, variant, policyId: variant, status: 'ok', metrics: metrics(ret) })
  const windows = LAB_WINDOWS
  const variants = [{ name: 'a', policy: 'p' }, { name: 'b', policy: 'p' }]
  test('cells come out in Lab order whatever order they finished in', () => {
    const cells = [cell('apr2025', 'test', 'b', 1000, 1), cell('sep2026', 'train', 'b', 1000, 1), cell('sep2026', 'train', 'a', 100000, 1), cell('sep2026', 'train', 'a', 1000, 1)]
    expect(sortCells(cells, windows, variants, [1000, 100000]).map((c) => `${c.window}/${c.variant}/${c.deposit}`)).toEqual(['sep2026/a/1000', 'sep2026/a/100000', 'sep2026/b/1000', 'apr2025/b/1000'])
  })
  test('TRAIN and TEST are aggregated apart; skipped cells do not count', () => {
    const cells: Cell[] = [cell('sep2026', 'train', 'a', 1000, 2), cell('oct2025', 'train', 'a', 1000, -4), cell('apr2025', 'test', 'a', 1000, -1), { window: 'aug2024', split: 'train', regime: 'crash', deposit: 1000, variant: 'a', policyId: 'a', status: 'skipped', reason: 'no data' }]
    const aggs = aggregate(cells)
    const train = aggs.find((a) => a.split === 'train')!
    expect(train).toMatchObject({ cells: 2, meanReturnPct: -1, worstReturnPct: -4, worstDrawdownPct: 4, ops: 4, gas: 1 })
    expect(aggs.find((a) => a.split === 'test')).toMatchObject({ cells: 1, meanReturnPct: -1 })
    const md = markdown(cells, aggs)
    expect(md).toContain('### TRAIN')
    expect(md).toContain('### TEST')
    expect(md).toContain('skipped: no data')
  })
})

describe('windows', () => {
  test('block numbers from time match the recorded datasets', () => {
    // base-2025-02-crash-10m starts at block 25,702,800, 2025-01-29 23:55:47 UTC.
    expect(blockAt('2025-01-29T23:55:47Z')).toBe(25_702_800)
    expect(windowBlocks(LAB_WINDOWS.find((w) => w.id === 'sep2026')!)).toEqual({ fromBlock: 50_757_600, toBlock: 52_053_600 })
  })
  test('ids and files are unique, both splits exist, TEST has a crash, a rally and a calm window', () => {
    expect(new Set(LAB_WINDOWS.map((w) => w.id)).size).toBe(LAB_WINDOWS.length)
    expect(new Set(LAB_WINDOWS.map((w) => w.file)).size).toBe(LAB_WINDOWS.length)
    const test = LAB_WINDOWS.filter((w) => w.split === 'test')
    for (const r of ['crash', 'rally', 'calm']) expect(test.some((w) => w.regime === r)).toBe(true)
  })
  test('no two windows overlap', () => {
    const spans = LAB_WINDOWS.map((w) => [Date.parse(w.from), Date.parse(w.to)] as const).sort((a, b) => a[0] - b[0])
    for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBeGreaterThanOrEqual(spans[i - 1]![1])
  })
})
