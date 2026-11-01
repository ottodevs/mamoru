import { describe, expect, test } from 'bun:test'
import { conservadorLabV1, conservadorLiveV2, type PolicyVersion } from '@mamoru/policy'
import { address, baseRegistry, entry } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { canonicalJson, decide, eelOf, impactAt, PACKAGING_EEL_RULES, poolDepthShadowRisk, type Observation, type PoolDepthObs, type PoolObs, type PositionObs } from './index.ts'
import { amountsForLiquidity, inSavings } from './value.ts'

const STABLES = 'pool:USDC/USDT/100'
const BTC = 'pool:USDC/cbBTC/500'
const RISK = 'pool:WETH/USDC/3000'
const POOLS = new Set([STABLES, BTC, RISK])

// Per pool: its tokens, fee, the price tick, and a range the price is outside of, so the position holds only the non-USDC leg.
const SPEC: Record<string, { t0: string; t1: string; fee: number; tick: number; lower: number; upper: number }> = {
  [STABLES]: { t0: 'USDC', t1: 'USDT', fee: 100, tick: 0, lower: -100, upper: -10 },
  [BTC]: { t0: 'USDC', t1: 'cbBTC', fee: 500, tick: -69_080, lower: -70_000, upper: -69_500 },
  [RISK]: { t0: 'WETH', t1: 'USDC', fee: 3000, tick: -194_700, lower: -194_100, upper: -193_500 },
}

function pool(name: string): PoolObs {
  const s = SPEC[name]!
  const e = entry(name, baseRegistry)
  return {
    name, address: e.address, token0: s.t0, token1: s.t1, fee: s.fee, tickSpacing: 10,
    sqrtPriceX96: sqrtRatioAtTick(s.tick), tick: s.tick, liquidity: 10n ** 18n, twapTick: s.tick,
    identity: { factoryPool: e.address, token0: address(s.t0, baseRegistry), token1: address(s.t1, baseRegistry), fee: s.fee, tickSpacing: 10 },
  }
}

/** A position with only the non-USDC leg (the price is outside its range), worth about `usd`. */
function position(name: string, usd: number, id = 1n): PositionObs {
  const s = SPEC[name]!
  const p = pool(name)
  const L0 = 10n ** 12n
  const a = amountsForLiquidity(p.sqrtPriceX96, s.lower, s.upper, L0)
  const v0 = Number(inSavings(p, p.token0, a.amount0, 'USDC') + inSavings(p, p.token1, a.amount1, 'USDC')) / 1e6
  const liquidity = BigInt(Math.round((Number(L0) * usd) / v0))
  return { tokenId: id, pool: name, tickLower: s.lower, tickUpper: s.upper, liquidity, collectable0: 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: true }
}

/** The position valued the way the rule does. */
function valueOf(name: string, pos: PositionObs): number {
  const p = pool(name)
  const a = amountsForLiquidity(p.sqrtPriceX96, pos.tickLower, pos.tickUpper, pos.liquidity)
  return Number(inSavings(p, p.token0, a.amount0, 'USDC') + inSavings(p, p.token1, a.amount1, 'USDC')) / 1e6
}

function obs(pools: string[], poolDepth?: Record<string, PoolDepthObs>, positions: PositionObs[] = []): Observation {
  return {
    chainId: 31337,
    block: { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: 1_000n },
    safeBlock: { number: 98n, hash: `0x${'22'.repeat(32)}` },
    account: { address: '0x00000000000000000000000000000000000000aa', deployed: true, nonceKey: 0n, nonce: 0n },
    sessions: [], native: 10n ** 17n, balances: { USDC: 0n, cbBTC: 0n, WETH: 0n, USDT: 0n }, positions, pools: pools.map(pool),
    ethPrice: { pool: 'pool:WETH/USDC/3000', sqrtPriceX96: sqrtRatioAtTick(-197_000), token0: 'WETH' },
    gas: { maxFeePerGas: 2_000_000n, opGasUnits: 5_100_000n },
    deposits: [], intents: { paused: false, exitRequested: false }, slot: null,
    ...(poolDepth ? { poolDepth } : {}),
  }
}

const D = (sizesUsd: number[], impactBps: (number | null)[], feeBps = 5): PoolDepthObs => ({ sizesUsd, impactBps, feeBps, asOf: 1 })
/** The live ladder with a linear impact of `perMillion` bps per 1M USD. */
const LADDER = [1_000, 3_000, 10_000, 30_000, 100_000, 300_000, 1_000_000, 3_000_000, 10_000_000]
const ladder = (f: (s: number) => number | null, feeBps = 5) => D(LADDER, LADDER.map(f), feeBps)
const live: PolicyVersion = { ...conservadorLiveV2, shadow: [...new Set([...conservadorLiveV2.shadow, 'packaging:eel'])] }
const run = (name: string, d: PoolDepthObs | undefined, positions: PositionObs[] = [], policy = live) =>
  poolDepthShadowRisk(obs([name], d ? { [name]: d } : {}, positions), policy, POOLS)
const codes = (r: { code: string }[]) => r.map((x) => x.code)
const BUCKET: Record<string, string> = { [STABLES]: 'stables', [BTC]: 'btc-usdc', [RISK]: 'risk' }

describe('curve maths', () => {
  test('EEL interpolates linearly in size between ladder points, with impact 0 at size 0', () => {
    expect(eelOf([{ s: 1000, i: 50 }, { s: 10_000, i: 350 }], true, 200).usd).toBeCloseTo(1000 + (150 * 9000) / 300, 6)
    // first point already over the limit: from the origin
    expect(eelOf([{ s: 1000, i: 400 }], true, 200).usd).toBeCloseTo(500, 6)
    // a point exactly at the limit is within it
    expect(eelOf([{ s: 1000, i: 100 }, { s: 5000, i: 200 }, { s: 9000, i: 900 }], true, 200).usd).toBe(5000)
  })

  test('EEL: ladder ended by a null is the last good size; all nine within is 10M', () => {
    expect(eelOf([{ s: 1000, i: 10 }, { s: 3000, i: 20 }], false, 200)).toEqual({ usd: 3000, atCap: false })
    expect(eelOf([{ s: 1000, i: 10 }, { s: 10_000_000, i: 20 }], true, 200)).toEqual({ usd: 10_000_000, atCap: true })
  })

  test('impactAt: linear from the origin, null beyond the last point', () => {
    const pts = [{ s: 1000, i: 10 }, { s: 3000, i: 50 }]
    expect(impactAt(pts, 500)).toBe(5)
    expect(impactAt(pts, 2000)).toBe(30)
    expect(impactAt(pts, 3000)).toBe(50)
    expect(impactAt(pts, 3001)).toBeNull()
  })
})

describe('packaging:eel shadow (otto/mamoru#101 phase 1c)', () => {
  test('healthy depth and no positions: nothing', () => {
    for (const name of POOLS) expect(run(name, ladder((s) => s / 1_000_000))).toEqual([])
  })

  test('B. EEL under the bucket minimum: at the minimum does not fire, just under does (each bucket)', () => {
    for (const name of POOLS) {
      const r = PACKAGING_EEL_RULES[BUCKET[name]!]!
      // The impact limit is reached exactly at the minimum size.
      const at = D([r.eelMinUsd, r.eelMinUsd * 10], [r.impactLimitBps, r.impactLimitBps * 3])
      expect(run(name, at)).toEqual([])
      // 1% steeper: the same limit is reached just before the minimum.
      const past = D([r.eelMinUsd, r.eelMinUsd * 10], [r.impactLimitBps * 1.01, r.impactLimitBps * 3])
      const hit = run(name, past)
      expect(hit.map((x) => [x.code, x.pool])).toEqual([['RISK_POOL_EEL_LOW', name]])
      expect(Number(hit[0]!.threshold)).toBe(r.eelMinUsd * 1e6)
      expect(Number(hit[0]!.metric)).toBeLessThan(r.eelMinUsd * 1e6)
      expect(hit[0]!.label).toContain('EEL')
    }
  })

  test('the constants are the doc numbers', () => {
    expect(PACKAGING_EEL_RULES).toEqual({
      stables: { impactLimitBps: 200, eelMinUsd: 600_000, exitSlippageBps: 300, positionRatioBps: 1000 },
      'btc-usdc': { impactLimitBps: 200, eelMinUsd: 350_000, exitSlippageBps: 300, positionRatioBps: 1000 },
      risk: { impactLimitBps: 500, eelMinUsd: 75_000, exitSlippageBps: 600, positionRatioBps: 500 },
    })
  })

  test('a ladder that ends in nulls: EEL is the last good size; all nine within reads >=10M', () => {
    const cut = run(STABLES, ladder((s) => (s <= 100_000 ? s / 10_000_000 : null)))
    expect(cut.map((x) => x.code)).toEqual(['RISK_POOL_EEL_LOW'])
    expect(cut[0]!.metric).toBe('100000000000')
    expect(cut[0]!.label).toContain('100k')
    // sell leg beyond the last read point exceeds
    const big = run(STABLES, ladder((s) => (s <= 100_000 ? 1 : null)), [position(STABLES, 500_000)])
    expect(codes(big)).toContain('RISK_EXIT_SLIPPAGE')
    const all = run(RISK, ladder(() => 1))
    expect(all).toEqual([])
    // all nine within and a position: the ratio reads against 10M
    const q = run(RISK, ladder(() => 1), [position(RISK, 400_000)])
    expect(q).toEqual([]) // 400k / 10M = 400 bps < 500
    const q2 = run(RISK, ladder(() => 1), [position(RISK, 600_000)])
    expect(q2.map((x) => x.code)).toEqual(['RISK_POSITION_RATIO'])
    expect(q2[0]!.label).toContain('>=10.00M')
  })

  test('E. exit slippage = interpolated impact + pool fee: at the limit fires, one bps under does not (each bucket)', () => {
    for (const name of POOLS) {
      const r = PACKAGING_EEL_RULES[BUCKET[name]!]!
      const fee = 5
      // Flat impact beyond the first point, so a 50k exit reads it exactly.
      const flat = (impact: number) => D([1_000, 10_000_000], [impact, impact], fee)
      const pos = [position(name, 50_000)]
      const at = run(name, flat(r.exitSlippageBps - fee), pos).filter((x) => x.code === 'RISK_EXIT_SLIPPAGE')
      expect(at).toHaveLength(1)
      expect(at[0]).toMatchObject({ pool: name, threshold: String(r.exitSlippageBps), metric: String(r.exitSlippageBps) })
      expect(run(name, flat(r.exitSlippageBps - fee - 1), pos).filter((x) => x.code === 'RISK_EXIT_SLIPPAGE')).toEqual([])
    }
  })

  test('E. a position with no sell leg (all USDC) has no exit slippage; the worst of several positions counts', () => {
    const flat = D([1_000, 10_000_000], [1000, 1000])
    const usdcOnly: PositionObs = { ...position(BTC, 50_000), tickLower: -60_000, tickUpper: -59_000 } // price below range: all token0 (USDC)
    expect(run(BTC, flat, [usdcOnly]).filter((x) => x.code === 'RISK_EXIT_SLIPPAGE')).toEqual([])
    const steep = D([1_000, 100_000, 10_000_000], [0, 400, 900])
    const small = position(BTC, 5_000, 1n)
    const large = position(BTC, 90_000, 2n)
    const one = run(BTC, steep, [small, large]).filter((x) => x.code === 'RISK_EXIT_SLIPPAGE')
    expect(one).toHaveLength(1)
    expect(Number(one[0]!.metric)).toBeGreaterThan(350) // the 90k position's interpolated impact (about 360) plus the fee; the 5k one alone would not fire
  })

  test('E. a sell size past the last read point fires and is labelled; no metric (it is not a number)', () => {
    const r = run(BTC, D([1_000, 10_000], [1, 2]), [position(BTC, 100_000)]).filter((x) => x.code === 'RISK_EXIT_SLIPPAGE')
    expect(r).toHaveLength(1)
    expect(r[0]!.metric).toBeUndefined()
    expect(r[0]!.label).toContain('beyond ladder')
  })

  test('Position ratio Q/EEL: over the limit fires, at it does not (each bucket)', () => {
    for (const name of POOLS) {
      const r = PACKAGING_EEL_RULES[BUCKET[name]!]!
      // EEL exactly 1,000,000 (impact reaches the limit there, and 10M further out).
      const d = D([1_000, 1_000_000, 10_000_000], [0, r.impactLimitBps, r.impactLimitBps * 3], 0)
      const limitQ = (1_000_000 * r.positionRatioBps) / 10_000
      const under = position(name, limitQ * 0.999)
      const over = position(name, limitQ * 1.001)
      expect(valueOf(name, under)).toBeLessThan(limitQ)
      expect(valueOf(name, over)).toBeGreaterThan(limitQ)
      expect(run(name, d, [under]).filter((x) => x.code === 'RISK_POSITION_RATIO')).toEqual([])
      const hit = run(name, d, [over]).filter((x) => x.code === 'RISK_POSITION_RATIO')
      expect(hit).toHaveLength(1)
      expect(hit[0]).toMatchObject({ pool: name, threshold: String(r.positionRatioBps) })
      expect(Number(hit[0]!.metric)).toBeGreaterThan(r.positionRatioBps)
    }
  })

  test('the ratio counts every position of the account in the pool; another pool\'s positions are not counted', () => {
    const d = D([1_000, 1_000_000, 10_000_000], [0, 200, 600], 0)
    const half = (id: bigint) => position(BTC, 60_000, id)
    expect(run(BTC, d, [half(1n)]).filter((x) => x.code === 'RISK_POSITION_RATIO')).toEqual([])
    expect(run(BTC, d, [half(1n), half(2n)]).filter((x) => x.code === 'RISK_POSITION_RATIO')).toHaveLength(1)
    expect(run(BTC, d, [half(1n), { ...half(2n), pool: STABLES }]).filter((x) => x.code === 'RISK_POSITION_RATIO')).toEqual([])
  })

  test('unread: no entry, all-null curve or a malformed one is RISK_POOL_DEPTH_UNREAD and nothing else, never an exit', () => {
    const pos = [position(BTC, 5_000_000)]
    for (const d of [undefined, ladder(() => null), D([1_000, 500], [1, 1]), D([1_000], [1, 2]), D([1_000], [Number.NaN]), D([1_000], [1], Number.NaN), D([], [])]) {
      const r = run(BTC, d, pos)
      expect(r.map((x) => [x.code, x.pool, x.threshold])).toEqual([['RISK_POOL_DEPTH_UNREAD', BTC, '0']])
    }
  })

  test('no poolDepth in the observation, a policy without packaging:eel, or savings other than USDC: nothing', () => {
    const bad = ladder(() => 9_000)
    expect(poolDepthShadowRisk(obs([BTC]), live, POOLS)).toEqual([])
    const plain: PolicyVersion = { ...live, shadow: live.shadow.filter((s) => s !== 'packaging:eel') }
    expect(decide(obs([BTC], { [BTC]: bad }, [position(BTC, 1e6)]), plain).shadowRisk).toBeUndefined()
    expect(poolDepthShadowRisk(obs([BTC], { [BTC]: bad }), { ...live, savingsAsset: 'WETH' } as PolicyVersion, POOLS)).toEqual([])
    // a pool the observation did not price
    expect(poolDepthShadowRisk(obs([], { [BTC]: bad }), live, POOLS)).toEqual([])
  })

  test('decide: entries reach Decision.shadowRisk; premiseHash, decisionId and the rest of the decision never move with any depth', () => {
    const lab: PolicyVersion = { ...conservadorLabV1, shadow: [...new Set([...conservadorLabV1.shadow, 'packaging:eel'])] }
    const ref = decide(obs([BTC]), lab)
    const variants: (Record<string, PoolDepthObs> | undefined)[] = [
      { [BTC]: ladder((s) => s / 1_000_000) },
      { [BTC]: ladder((s) => s / 1_000) },
      { [BTC]: ladder(() => null) },
      { [BTC]: D([1_000], [1]) },
      {},
    ]
    for (const v of variants) {
      const d = decide(obs([BTC], v), lab)
      expect(d.premiseHash).toBe(ref.premiseHash)
      expect(d.decisionId).toBe(ref.decisionId)
      const { shadowRisk: _r, ...rest } = d
      expect(canonicalJson(rest)).toBe(canonicalJson(ref))
    }
    expect(decide(obs([BTC], { [BTC]: ladder((s) => s / 1_000) }), lab).shadowRisk?.map((r) => r.code)).toContain('RISK_POOL_EEL_LOW')
    expect(decide(obs([BTC], { [BTC]: ladder((s) => s / 1_000_000) }), lab).shadowRisk).toBeUndefined()
    expect(decide(obs([BTC], { [BTC]: ladder(() => null) }), lab).shadowRisk?.map((r) => r.code)).toEqual(['RISK_POOL_DEPTH_UNREAD'])
  })

  test('decide: tvl and eel entries combine, each behind its own gate', () => {
    const only = (shadow: string[]): PolicyVersion => ({ ...conservadorLabV1, shadow })
    const o = obs([BTC], { [BTC]: ladder(() => null) })
    expect(decide(o, only(['packaging:eel'])).shadowRisk?.map((r) => r.code)).toEqual(['RISK_POOL_DEPTH_UNREAD'])
    expect(decide(o, only(['packaging:tvl']))).not.toHaveProperty('shadowRisk', expect.arrayContaining([expect.objectContaining({ code: 'RISK_POOL_DEPTH_UNREAD' })]))
  })
})
