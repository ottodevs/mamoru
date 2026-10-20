import { describe, expect, test } from 'bun:test'
import { conservadorLabGeometryV1, conservadorLiveV2, grantKey, type PolicyVersion, type SkewRule, type VolWidthRule } from '@mamoru/policy'
import { baseRegistry, address, entry } from '@mamoru/registry'
import { rangeAround, sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { decide, edgeBpsOf, rangeFor, realizedVolOf, regimeOf, rerangeOf, skewedRange, volWidthTicks, widenEarly, widthFor, type Observation, type PoolGeometryObs, type PoolObs, type PositionObs } from '../index.ts'

const USDC = 1_000_000n
const STABLE_POOL = 'pool:USDC/USDT/100'
const BTC_POOL = 'pool:USDC/cbBTC/500'
const ETH_POOL = 'pool:WETH/USDC/3000'
const BTC_TICK = -69_080
const ETH_TICK = -193_380
const LAB = conservadorLabGeometryV1

function pool(name: string, tick: number): PoolObs {
  const e = entry(name, baseRegistry)
  return {
    name, address: e.address, token0: e.token0!, token1: e.token1!, fee: e.fee!, tickSpacing: e.tickSpacing!,
    sqrtPriceX96: sqrtRatioAtTick(tick), tick, liquidity: 10n ** 18n, twapTick: tick,
    identity: { factoryPool: e.address, token0: address(e.token0!, baseRegistry), token1: address(e.token1!, baseRegistry), fee: e.fee!, tickSpacing: e.tickSpacing! },
  }
}
const BTC = pool(BTC_POOL, BTC_TICK)
const ETH = pool(ETH_POOL, ETH_TICK)
const STABLE = pool(STABLE_POOL, 1)

function obs(over: Partial<Observation> = {}): Observation {
  return {
    chainId: 8453,
    block: { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: 1_000_000n },
    safeBlock: { number: 98n, hash: `0x${'22'.repeat(32)}` },
    account: { address: '0x00000000000000000000000000000000000000aa', deployed: true, nonceKey: 0n, nonce: 0n },
    sessions: LAB.session.grants.filter((g) => !g.perPosition).map((g, i) => ({ grant: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(2, '0').repeat(32)}` as const, validUntil: 10_000_000, active: true })),
    native: 10n ** 17n,
    balances: { USDC: 20n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n },
    positions: [],
    pools: [STABLE, BTC, ETH],
    ethPrice: { pool: ETH_POOL, sqrtPriceX96: sqrtRatioAtTick(ETH_TICK), token0: 'WETH' },
    gas: { maxFeePerGas: 2_000_000n, opGasUnits: 5_100_000n },
    deposits: [],
    intents: { paused: false, exitRequested: false },
    slot: null,
    ...over,
  }
}

const SKEW: SkewRule = { belowShareBps: 8_000, regime: 'ret24h', fallBps: 400, mirror: false }
const VOL: VolWidthRule = { k: 2, horizonSeconds: 86_400, minTicks: 600, maxTicks: 6_000, earlyRatio: 2 }
const skewed: PolicyVersion = { ...LAB, policyId: 'test-skew', geometry: { skew: SKEW } }
const volWide: PolicyVersion = { ...LAB, policyId: 'test-vol', geometry: { volWidth: VOL } }
const none: PoolGeometryObs = { twap24hAgoTick: null, emaTick: null, vol1hBps: null, vol24hBps: null, vol7dBps: null }
// cbBTC is token1: its price falls when the tick rises. 600 ticks up in 24 h is a 5.8% fall of cbBTC.
const btcFell = (ticks: number): PoolGeometryObs => ({ ...none, twap24hAgoTick: BTC_TICK - ticks })
const hist = (pools: Record<string, PoolGeometryObs>) => ({ geometry: { pools } })

describe('skewedRange', () => {
  test('5000 bps is rangeAround exactly', () => {
    for (const [tick, width, spacing] of [[BTC_TICK, 2_000, 10], [ETH_TICK, 2_000, 60], [7, 40, 1], [-13, 999, 10]] as const) {
      for (const v0 of [true, false]) expect(skewedRange(tick, width, spacing, 5_000, v0)).toEqual(rangeAround(tick, width, spacing))
    }
  })
  test('80% below the price, in the volatile token terms, whichever side it is', () => {
    // WETH is token0: a lower WETH price is a lower tick, so 80% of the width sits under the tick.
    const e = skewedRange(ETH_TICK, 2_000, 60, 8_000, true)
    expect(e.tickUpper - e.tickLower).toBe(rangeAround(ETH_TICK, 2_000, 60).tickUpper - rangeAround(ETH_TICK, 2_000, 60).tickLower)
    expect((ETH_TICK - e.tickLower) / (e.tickUpper - e.tickLower)).toBeCloseTo(0.8, 1)
    // cbBTC is token1: a lower cbBTC price is a higher tick, so 80% of the width sits over the tick.
    const b = skewedRange(BTC_TICK, 2_000, 10, 8_000, false)
    expect((b.tickUpper - BTC_TICK) / (b.tickUpper - b.tickLower)).toBeCloseTo(0.8, 1)
    for (const r of [e, b]) expect(Math.abs(r.tickLower % 10)).toBe(0)
  })
})

describe('regimeOf', () => {
  test('ret24h: fall, rally, flat and missing history', () => {
    expect(regimeOf(obs(hist({ [BTC_POOL]: btcFell(600) })), skewed, BTC)).toBe('fall')
    expect(regimeOf(obs(hist({ [BTC_POOL]: btcFell(-600) })), skewed, BTC)).toBe('rally')
    expect(regimeOf(obs(hist({ [BTC_POOL]: btcFell(200) })), skewed, BTC)).toBe('flat')
    expect(regimeOf(obs(hist({ [BTC_POOL]: none })), skewed, BTC)).toBeNull()
    expect(regimeOf(obs(), skewed, BTC)).toBeNull()
    // WETH is token0: its price falls with the tick.
    expect(regimeOf(obs(hist({ [ETH_POOL]: { ...none, twap24hAgoTick: ETH_TICK + 600 } })), skewed, ETH)).toBe('fall')
  })
  test('ema7d: under the EMA is a fall, over it a rally', () => {
    const ema: PolicyVersion = { ...LAB, geometry: { skew: { ...SKEW, regime: 'ema7d' } } }
    expect(regimeOf(obs(hist({ [BTC_POOL]: { ...none, emaTick: BTC_TICK - 10 } })), ema, BTC)).toBe('fall')
    expect(regimeOf(obs(hist({ [BTC_POOL]: { ...none, emaTick: BTC_TICK + 10 } })), ema, BTC)).toBe('rally')
  })
  test('the stables pool keeps its geometry', () => {
    expect(regimeOf(obs(hist({ [STABLE_POOL]: { ...none, twap24hAgoTick: -2_000 } })), skewed, STABLE)).toBeNull()
  })
})

describe('rangeFor', () => {
  test('without policy.geometry: the centred policy width, history or not', () => {
    const o = obs(hist({ [BTC_POOL]: { ...btcFell(600), vol24hBps: 9_000 } }))
    expect(rangeFor(o, conservadorLiveV2, BTC)).toEqual(rangeAround(BTC_TICK, 2_000, 10))
    expect(rangeFor(o, conservadorLiveV2, STABLE)).toEqual(rangeAround(1, 40, 1))
  })
  test('skew in a fall, centred otherwise; mirrored upward in a rally only with mirror', () => {
    expect(rangeFor(obs(hist({ [BTC_POOL]: btcFell(600) })), skewed, BTC)).toEqual(skewedRange(BTC_TICK, 2_000, 10, 8_000, false))
    expect(rangeFor(obs(hist({ [BTC_POOL]: btcFell(-600) })), skewed, BTC)).toEqual(rangeAround(BTC_TICK, 2_000, 10))
    const mirror: PolicyVersion = { ...LAB, geometry: { skew: { ...SKEW, mirror: true } } }
    expect(rangeFor(obs(hist({ [BTC_POOL]: btcFell(-600) })), mirror, BTC)).toEqual(skewedRange(BTC_TICK, 2_000, 10, 2_000, false))
  })
})

describe('volatility width', () => {
  test('k sigma sqrt(H) in ticks, clamped', () => {
    // 60% a year over one day, k = 2: 2 * 0.6 * sqrt(1/365) / ln(1.0001) = 628 ticks.
    expect(volWidthTicks(VOL, 6_000)).toBe(628)
    expect(volWidthTicks({ ...VOL, horizonSeconds: 3 * 86_400 }, 6_000)).toBe(1_088)
    expect(volWidthTicks(VOL, 1_000)).toBe(600)
    expect(volWidthTicks(VOL, 100_000)).toBe(6_000)
  })
  test('the stables pool keeps 40 ticks; missing history keeps the policy width', () => {
    const o = obs(hist({ [STABLE_POOL]: { ...none, vol24hBps: 9_000 }, [BTC_POOL]: { ...none, vol24hBps: 9_000 } }))
    expect(widthFor(o, volWide, STABLE)).toBe(40)
    expect(widthFor(o, volWide, BTC)).toBe(volWidthTicks(VOL, 9_000))
    expect(widthFor(obs(), volWide, BTC)).toBe(2_000)
  })
  test('a spike (1 h vol over r times the 7-day one) widens with the 1 h figure, and only then', () => {
    const calm = { ...none, vol1hBps: 8_000, vol24hBps: 5_000, vol7dBps: 5_000 }
    const spike = { ...calm, vol1hBps: 15_000 }
    expect(widthFor(obs(hist({ [BTC_POOL]: calm })), volWide, BTC)).toBe(volWidthTicks(VOL, 5_000))
    expect(widthFor(obs(hist({ [BTC_POOL]: spike })), volWide, BTC)).toBe(volWidthTicks(VOL, 15_000))
    // A 600-tick position: re-ranged early in the spike (target over 1.5 times its width), not in calm.
    expect(widenEarly(obs(hist({ [BTC_POOL]: spike })), volWide, BTC, 600)).toBe(true)
    expect(widenEarly(obs(hist({ [BTC_POOL]: calm })), volWide, BTC, 600)).toBe(false)
    expect(widenEarly(obs(hist({ [BTC_POOL]: spike })), { ...volWide, geometry: { volWidth: { ...VOL, earlyRatio: 0 } } }, BTC, 600)).toBe(false)
  })
})

describe('realizedVolOf', () => {
  const now = 1_000_000
  test('flat: zero; a constant step per segment: that step annualized', () => {
    expect(realizedVolOf(now, 86_400, 600, (t) => ({ time: t, tickCumulative: BigInt(t) * 7n }))).toBe(0)
    // Mean of each 600 s segment moves 10 ticks: cumulative 10 t^2 / (2 * 600).
    const at = (t: number) => ({ time: t, tickCumulative: BigInt(Math.round((10 * t * t) / 1_200)) })
    const want = Math.round(10 * Math.log(1.0001) * Math.sqrt((365 * 86_400) / 600) * 10_000)
    expect(Math.abs(realizedVolOf(now, 86_400, 600, at)! - want)).toBeLessThanOrEqual(1)
  })
  test('thin history abstains; a few missing points do not', () => {
    const flat = (t: number) => ({ time: t, tickCumulative: 0n })
    expect(realizedVolOf(now, 86_400, 600, (t) => (t < now - 3_600 ? null : flat(t)))).toBeNull()
    expect(realizedVolOf(now, 86_400, 600, (t) => (t === now - 6_000 ? null : flat(t)))).toBe(0)
    expect(realizedVolOf(now, 1_200, 600, flat)).toBeNull()
  })
})

describe('re-range edges with a skew rule', () => {
  const position = (tickLower: number, tickUpper: number): PositionObs => ({ tokenId: 5n, pool: BTC_POOL, tickLower, tickUpper, liquidity: 10n ** 12n, collectable0: 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: true })
  const deep: PolicyVersion = { ...LAB, geometry: { skew: { ...SKEW, belowShareBps: 9_500 } } }
  test('the edge a fall placement sits near gets half the short side', () => {
    // cbBTC is token1: a higher cbBTC price is a lower tick.
    expect(edgeBpsOf(deep, BTC, 1_000)).toEqual({ lower: 250, upper: 1_000 })
    expect(edgeBpsOf(deep, ETH, 1_000)).toEqual({ lower: 1_000, upper: 250 })
    expect(edgeBpsOf({ ...deep, geometry: { skew: { ...SKEW, belowShareBps: 9_500, mirror: true } } }, BTC, 1_000)).toEqual({ lower: 250, upper: 250 })
    expect(edgeBpsOf(conservadorLiveV2, BTC, 1_000)).toEqual({ lower: 1_000, upper: 1_000 })
  })
  test('a 95% placement is not re-ranged at once; the same range without the rule is', () => {
    const r = skewedRange(BTC_TICK, 2_000, 10, 9_500, false)
    const p = position(r.tickLower, r.tickUpper)
    expect(rerangeOf(obs(), deep, p, BTC).proposal).toBeNull()
    expect(rerangeOf(obs(), LAB, p, BTC).proposal).toMatchObject({ kind: 'rerange' })
  })
  test('a spike re-ranges a narrow in-range position early', () => {
    const p = position(BTC_TICK - 300, BTC_TICK + 300)
    const spike = hist({ [BTC_POOL]: { ...none, vol1hBps: 15_000, vol24hBps: 5_000, vol7dBps: 5_000 } })
    expect(rerangeOf(obs(spike), volWide, p, BTC).proposal).toMatchObject({ kind: 'rerange' })
    expect(rerangeOf(obs(spike), LAB, p, BTC).proposal).toBeNull()
  })
})

describe('decide with geometry (#101)', () => {
  test('without policy.geometry the decision ignores geometry history', () => {
    const plain = decide(obs(), LAB)
    expect(decide(obs(hist({ [BTC_POOL]: { ...btcFell(600), vol24hBps: 9_000 } })), LAB)).toEqual(plain)
  })
  test('with the rule and no history: the decision of the plain policy (it abstains)', () => {
    const a = decide(obs(), LAB)
    const b = decide(obs(), skewed)
    expect(b.proposal).toEqual(a.proposal)
    expect(b.buckets).toEqual(a.buckets)
  })
  test('a fresh account in a cbBTC fall buys less cbBTC: the skewed range is mostly savings', () => {
    const fell = obs(hist({ [BTC_POOL]: btcFell(600) }))
    const only = (p: PolicyVersion): PolicyVersion => ({ ...p, buckets: p.buckets.filter((b) => b.id === 'btc-usdc') })
    const a = decide(fell, only(LAB)).proposal
    const b = decide(fell, only(skewed)).proposal
    expect(a).toMatchObject({ kind: 'enter_swap', pool: BTC_POOL, tokenIn: 'USDC' })
    expect(b).toMatchObject({ kind: 'enter_swap', pool: BTC_POOL, tokenIn: 'USDC' })
    if (a?.kind !== 'enter_swap' || b?.kind !== 'enter_swap') throw new Error('want swaps')
    // About 20% of the bucket in cbBTC instead of 50%.
    expect(Number(b.amountIn) / Number(a.amountIn)).toBeGreaterThan(0.3)
    expect(Number(b.amountIn) / Number(a.amountIn)).toBeLessThan(0.5)
  })
  test('the mint takes the skewed range', () => {
    // Bucket btc-usdc alone, with savings and enough idle cbBTC for the skewed split.
    const btcOnly: PolicyVersion = { ...skewed, buckets: skewed.buckets.filter((b) => b.id === 'btc-usdc') }
    const o = obs({ ...hist({ [BTC_POOL]: btcFell(600) }), balances: { USDC: 16n * USDC, USDT: 0n, cbBTC: 4_000n, WETH: 0n } })
    const d = decide(o, btcOnly)
    expect(d.proposal).toMatchObject({ kind: 'enter_mint', pool: BTC_POOL, ...skewedRange(BTC_TICK, 2_000, 10, 8_000, false) })
  })
})
