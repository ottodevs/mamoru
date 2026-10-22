import { describe, expect, test } from 'bun:test'
import type { ApyView, FundingView } from '@mamoru/domain'
import { fixtureFunding } from '../../src/web/fixtures/client.ts'
import { split } from '../../src/web/lib/money.ts'
import { bucketOf, currentRate, idleReason, monthlyRate, positionRates, sourceName } from '../../src/web/lib/rates.ts'

// otto/mamoru#193: the dashboard's rates and the idle/working split.

const apy: ApyView = {
  pool: 'conservador-live-v2',
  currentPct: 6.4,
  currentWindow: '24h',
  currentSource: 'Plan pools, fee APR · GeckoTerminal/DefiLlama',
  monthlyPct: 5.9,
  monthlySource: 'Plan pools, 30-day mean · DefiLlama',
  byPool: [
    { pool: 'pool:USDC/USDT/100', weight: 5000, currentPct: 3.0, monthlyPct: 4.5 },
    { pool: 'pool:USDC/cbBTC/500', weight: 4000, currentPct: 7.3, monthlyPct: 18.9 },
    { pool: 'pool:WETH/USDC/3000', weight: 1000, currentPct: 20, monthlyPct: 55.1 },
  ],
  asOf: '2026-10-22T00:00:00.000Z',
}

const pos = (tokenId: string, pool: string, valueUsdc: string, inRange = true): FundingView['positions'][number] => ({ tokenId, pool, liquidity: '1', inRange, amountUsdc: '0', amountCbbtc: '0', valueUsdc })

// The mockup's account: 50.12 Stable, 39.80 Balanced, 9.97 Growth paused, 0.11 USDC idle.
const placed: FundingView = {
  ...fixtureFunding,
  active: true,
  usdc: '110000',
  idle: [{ token: 'USDC', amount: '110000', decimals: 6, valueUsdc: '110000' }],
  engine: { placing: false, nextReviewAt: null },
  positions: [pos('1', 'pool:USDC/USDT/100', '50120000'), pos('2', 'pool:USDC/cbBTC/500', '39800000'), pos('3', 'pool:WETH/USDC/3000', '9970000', false)],
}

describe('rates per position', () => {
  test('bucket, share and the pool rates; a paused position earns 0% today', () => {
    const rows = positionRates(placed, apy)
    expect(rows.map((r) => r.bucket)).toEqual(['Stable', 'Balanced', 'Growth'])
    expect(rows.map((r) => Math.round(r.sharePct!))).toEqual([50, 40, 10])
    expect(rows.map((r) => r.currentPct)).toEqual([3.0, 7.3, 0])
    expect(rows.map((r) => r.monthlyPct)).toEqual([4.5, 18.9, 55.1])
  })
  test('a pool given by address resolves to its plan pool and bucket', () => {
    expect(bucketOf('0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef')).toBe('Balanced')
    const rows = positionRates({ ...placed, positions: [pos('1', '0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef', '1000000')] }, apy)
    expect(rows[0]!.currentPct).toBe(7.3)
  })
  test('a pool with no rate source is null (n/a), not a guess', () => {
    const rows = positionRates({ ...placed, positions: [pos('1', 'pool:WETH/USDC/500', '1000000')] }, apy)
    expect(rows[0]!.currentPct).toBeNull()
    expect(rows[0]!.monthlyPct).toBeNull()
  })
})

describe('current rate', () => {
  test('leaves paused positions out and weights the rest by USDC value', () => {
    const r = currentRate(positionRates(placed, apy), apy)
    // (50.12 * 3.0 + 39.80 * 7.3) / 89.92 = 4.9
    expect(r.pct).toBeCloseTo(4.9, 1)
    expect(r.gap).toBeNull()
    expect([r.covered, r.of]).toEqual([2, 2])
  })
  test('a large paused position does not drag the rate down', () => {
    const big = { ...placed, positions: [pos('1', 'pool:USDC/USDT/100', '10000000'), pos('2', 'pool:WETH/USDC/3000', '90000000', false)] }
    expect(currentRate(positionRates(big, apy), apy).pct).toBe(3)
  })
  test('n/a with a reason: loading, nothing placed, everything paused, no data', () => {
    expect(currentRate([], undefined).gap).toBe('loading')
    expect(currentRate([], apy).gap).toBe('no-positions')
    const paused = { ...placed, positions: [pos('1', 'pool:USDC/USDT/100', '1000000', false)] }
    expect(currentRate(positionRates(paused, apy), apy)).toMatchObject({ pct: null, gap: 'all-paused' })
    const noData = { ...apy, byPool: [] }
    expect(currentRate(positionRates(placed, noData), noData)).toMatchObject({ pct: null, gap: 'no-data' })
  })
  test('a position without a rate is left out and counted', () => {
    const mixed = { ...placed, positions: [pos('1', 'pool:USDC/USDT/100', '1000000'), pos('2', 'pool:WETH/USDC/500', '1000000')] }
    expect(currentRate(positionRates(mixed, apy), apy)).toMatchObject({ pct: 3, covered: 1, of: 2 })
  })
  test('a cbBTC position with no price is not weighted on a guess', () => {
    const old = { ...placed, positions: [{ tokenId: '1', pool: 'pool:USDC/cbBTC/500', liquidity: '1', inRange: true, amountUsdc: '1000000', amountCbbtc: '1000' }] }
    expect(currentRate(positionRates(old, apy, null), apy)).toMatchObject({ pct: null, gap: 'no-value' })
    expect(currentRate(positionRates(old, apy, 100_000_000_000n), apy).pct).toBe(7.3)
  })
})

describe('monthly rate', () => {
  test('every position, paused ones included, weighted by USDC value', () => {
    // (50.12 * 4.5 + 39.80 * 18.9 + 9.97 * 55.1) / 99.89 = 15.3
    expect(monthlyRate(positionRates(placed, apy), apy).pct).toBeCloseTo(15.3, 1)
  })
  test('before any position: the plan pools figure, marked as such', () => {
    expect(monthlyRate([], apy)).toMatchObject({ pct: 5.9, plan: true, gap: null })
  })
  test('the source is the name after the last dot', () => {
    expect(sourceName(apy.monthlySource)).toBe('DefiLlama')
    expect(sourceName(apy.currentSource)).toBe('GeckoTerminal/DefiLlama')
    expect(sourceName(undefined)).toBeNull()
  })
})

describe('idle and working split', () => {
  test('working is every position, paused included; idle is what sits outside', () => {
    const s = split(placed, null)
    expect(s.working).toBe(99_890_000n)
    expect(s.idle).toBe(110_000n)
    expect(s.total).toBe(100_000_000n)
    expect(idleReason(placed, s)).toBe('waiting to be placed')
  })
  test('the reason follows the engine', () => {
    const placing = { ...placed, engine: { placing: true, nextReviewAt: null } }
    expect(idleReason(placing, split(placing, null))).toBe('being placed')
    const stopped = { ...placed, active: false }
    expect(idleReason(stopped, split(stopped, null))).toBe('Mamoru is stopped')
    const dust = { ...placed, usdc: '300', idle: [{ token: 'USDC', amount: '300', decimals: 6, valueUsdc: '300' }] }
    expect(idleReason(dust, split(dust, null))).toBe('nothing idle')
  })
})
