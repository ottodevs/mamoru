import { describe, expect, test } from 'bun:test'
import { conservadorLiveV2, grantKey, type PolicyVersion } from '@mamoru/policy'
import { address, entry } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { decide, type Observation, type PoolObs } from './index.ts'
import { depthOf, twapFloor } from './depth/index.ts'

const USDC = 1_000_000n
const DEPTH: PolicyVersion = { ...conservadorLiveV2, depth: { maxImpactBps: 30, maxShareBps: 500, maxImpactBpsByPool: { 'pool:USDC/USDT/100': 5 } } }

function pool(name: string, tick: number, liquidity: bigint): PoolObs {
  const e = entry(name)
  return {
    name,
    address: e.address,
    token0: e.token0!,
    token1: e.token1!,
    fee: e.fee!,
    tickSpacing: e.tickSpacing!,
    sqrtPriceX96: sqrtRatioAtTick(tick),
    tick,
    liquidity,
    twapTick: tick,
    twapLiquidity: liquidity,
    identity: { factoryPool: e.address, token0: address(e.token0!), token1: address(e.token1!), fee: e.fee!, tickSpacing: e.tickSpacing! },
  }
}

function obs(stablesL: bigint, usdc: bigint, otherL: bigint = 10n ** 18n): Observation {
  return {
    chainId: 8453,
    block: { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: 1_000n },
    safeBlock: { number: 98n, hash: `0x${'22'.repeat(32)}` },
    account: { address: '0x00000000000000000000000000000000000000aa', deployed: true, nonceKey: 0n, nonce: 0n },
    sessions: conservadorLiveV2.session.grants.filter((g) => !g.perPosition).map((g, i) => ({ grant: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(2, '0').repeat(32)}` as const, validUntil: 10_000, active: true })),
    native: 10n ** 17n,
    balances: { USDC: usdc, USDT: 0n, cbBTC: 0n, WETH: 0n },
    positions: [],
    pools: [pool('pool:USDC/USDT/100', 1, stablesL), pool('pool:USDC/cbBTC/500', -69_080, otherL), pool('pool:WETH/USDC/3000', -193_380, otherL)],
    ethPrice: { pool: 'pool:WETH/USDC/3000', sqrtPriceX96: sqrtRatioAtTick(-193_380), token0: 'WETH' },
    gas: { maxFeePerGas: 2_000_000n, opGasUnits: 5_100_000n },
    deposits: [],
    intents: { paused: false, exitRequested: false },
    slot: null,
  }
}

describe('depth sizing (otto/mamoru#127)', () => {
  test('without a depth policy the decision is the same as before, byte for byte', () => {
    const o = obs(10n ** 18n, 20n * USDC)
    const a = decide(o, conservadorLiveV2)
    const b = decide(o, { ...conservadorLiveV2 })
    expect(b.premiseHash).toBe(a.premiseHash)
    expect(a.waiting).toBeUndefined()
    expect('waiting' in a).toBe(false)
  })

  test('the impact room of a USDC sale follows the linearised constant-liquidity move', () => {
    const p = pool('pool:USDC/USDT/100', 1, 10n ** 12n)
    const d = depthOf(obs(10n ** 12n, 0n), DEPTH, p, 40)!
    // USDC is token0 here: Δ0 = b·L/√P, half the 5 bps budget for sizing, √P ≈ 1 at tick 1 (6 and 6 decimals).
    const expected = (5n * 10n ** 12n) / 20_000n
    expect(Math.abs(Number(d.swapRoom - expected)) / Number(expected)).toBeLessThan(0.001)
    expect(d.shareRoom > 0n).toBe(true)
  })

  test('a deep pool takes the whole entry, as without depth sizing', () => {
    const o = obs(10n ** 20n, 1_000n * USDC)
    const a = decide(o, conservadorLiveV2)
    const b = decide(o, DEPTH)
    expect(b.proposal).toEqual(a.proposal)
    expect(b.buckets.find((x) => x.bucket === 'stables')!.code).toBe('STRATEGY_PREFERENCE_DEVIATION')
  })

  test('a thin pool takes only what fits: the swap is smaller than without depth sizing', () => {
    // Active liquidity sized so 5 bps of impact allows a few hundred USDC, under the 50% of 10,000 the bucket wants.
    const o = obs(6n * 10n ** 11n, 10_000n * USDC)
    const a = decide(o, conservadorLiveV2)
    const b = decide(o, DEPTH)
    expect(a.proposal?.kind).toBe('enter_swap')
    expect(b.proposal?.kind).toBe('enter_swap')
    const ai = (a.proposal as { amountIn: bigint }).amountIn
    const bi = (b.proposal as { amountIn: bigint }).amountIn
    expect(bi < ai).toBe(true)
    expect(bi <= depthOf(o, DEPTH, o.pools[0]!, 40)!.swapRoom).toBe(true)
  })

  test('a pool with no room makes the bucket wait with its amount, and the next bucket goes', () => {
    const o = obs(1_000n, 10_000n * USDC)
    const d = decide(o, DEPTH)
    const stables = d.buckets.find((x) => x.bucket === 'stables')!
    expect(stables.code).toBe('DECIDE_WAIT_DEPTH')
    expect(d.waiting?.find((w) => w.bucket === 'stables')).toMatchObject({ code: 'DECIDE_WAIT_DEPTH' })
    expect(d.waiting!.find((w) => w.bucket === 'stables')!.amount).toBeGreaterThan(4_000n * USDC)
    expect(d.proposal?.pool).toBe('pool:USDC/cbBTC/500')
  })

  test('the share limit counts the positions the account already holds in range', () => {
    const o = obs(10n ** 15n, 1_000n * USDC)
    const p = o.pools[0]!
    const empty = depthOf(o, DEPTH, p, 40)!
    const held = depthOf({ ...o, positions: [{ tokenId: 1n, pool: p.name, tickLower: -20, tickUpper: 20, liquidity: (p.liquidity * 500n) / 10_000n, collectable0: 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: true }] }, DEPTH, p, 40)!
    expect(empty.shareRoom > 0n).toBe(true)
    expect(held.shareRoom).toBe(0n)
  })

  test('what waits is reported beside the decision: amounts move, the premise does not', () => {
    const a = decide(obs(1_000n, 10_000n * USDC, 1_000n), DEPTH)
    const b = decide(obs(1_000n, 12_000n * USDC, 1_000n), DEPTH)
    expect(a.proposal).toBeNull()
    expect(b.premiseHash).toBe(a.premiseHash)
    expect(b.waiting!.reduce((s, w) => s + w.amount, 0n)).toBeGreaterThan(a.waiting!.reduce((s, w) => s + w.amount, 0n))
  })

  test('a partial entry reports the part that does not fit', () => {
    const o = obs(6n * 10n ** 11n, 10_000n * USDC)
    const d = decide(o, DEPTH)
    expect(d.proposal?.pool).toBe('pool:USDC/USDT/100')
    const w = d.waiting?.find((x) => x.bucket === 'stables')
    expect(w?.code).toBe('DECIDE_WAIT_DEPTH')
    expect(w!.amount).toBeGreaterThan(4_000n * USDC)
  })

  test('depth never makes a sale of idle volatile larger, and caps it at the pool room', () => {
    // 100 USDC of idle USDT, no free USDC, a thin pool: the bucket keeps what an unsized entry needs, sells the rest.
    const o = { ...obs(6n * 10n ** 11n, 0n), balances: { USDC: 0n, USDT: 100n * USDC, cbBTC: 0n, WETH: 0n } }
    const plain = decide(o, conservadorLiveV2)
    const sized = decide(o, DEPTH)
    const amt = (d: typeof plain) => (d.proposal?.kind === 'enter_swap' && d.proposal.tokenIn === 'USDT' ? d.proposal.amountIn : 0n)
    expect(amt(sized) <= amt(plain)).toBe(true)
    expect(amt(sized) <= depthOf(o, DEPTH, o.pools[0]!, 40)!.sellRoom).toBe(true)
  })

  test('waiting buckets together never hold more than the free savings', () => {
    const o = obs(1_000n, 100n * USDC, 1_000n)
    const d = decide(o, DEPTH)
    const total = (d.waiting ?? []).reduce((s, w) => s + w.amount, 0n)
    expect(total <= 100n * USDC).toBe(true)
    expect(total > 0n).toBe(true)
  })

  describe('manipulation: spot moved inside the block we read', () => {
    test('a spot far from the TWAP holds the entry (EHG), whatever depth says', () => {
      const o = obs(10n ** 18n, 1_000n * USDC)
      // Every pool's slot0 pushed 2,000 ticks (about 20%) away inside the block, the TWAPs unchanged.
      const pushed = { ...o, pools: o.pools.map((p) => ({ ...p, tick: p.tick + 2_000, sqrtPriceX96: sqrtRatioAtTick(p.tick + 2_000) })) }
      const plain = decide(o, DEPTH)
      expect(plain.proposal).not.toBeNull()
      const d = decide(pushed, DEPTH)
      expect(d.proposal).toBeNull()
      expect(d.reason).toBe('EHG_PRICE_DIVERGENCE')
    })

    test('room is read at the TWAP price: a pushed spot does not change it', () => {
      const o = obs(10n ** 15n, 1_000n * USDC)
      const p = o.pools[0]!
      const pushed = { ...p, tick: p.tick + 50, sqrtPriceX96: sqrtRatioAtTick(p.tick + 50) }
      expect(depthOf(o, DEPTH, pushed, 40)).toEqual(depthOf(o, DEPTH, p, 40))
    })

    test('liquidity added just for this block does not add room: the smaller of spot and window mean counts', () => {
      const o = obs(10n ** 15n, 1_000n * USDC)
      const p = o.pools[0]!
      const flash = { ...p, liquidity: p.liquidity * 1_000n }
      expect(depthOf(o, DEPTH, flash, 40)).toEqual(depthOf(o, DEPTH, p, 40))
    })

    test('without the window mean or the TWAP there is no room at all', () => {
      const o = obs(10n ** 15n, 1_000n * USDC)
      const p = o.pools[0]!
      expect(depthOf(o, DEPTH, { ...p, twapLiquidity: null }, 40)).toEqual({ shareRoom: 0n, swapRoom: 0n, sellRoom: 0n })
      expect(depthOf(o, DEPTH, { ...p, twapTick: null }, 40)).toEqual({ shareRoom: 0n, swapRoom: 0n, sellRoom: 0n })
    })
  })
})

describe('twapFloor (engine minimum out, otto/mamoru#127)', () => {
  test('a quote from a pool pushed inside the block is under the floor and refused; the TWAP price passes', () => {
    // USDC (token0) into USDT at tick 0 (1:1), 1 bp fee, 5 bps limit.
    const amountIn = 10_000n * USDC
    const floor = twapFloor(amountIn, 100, 0, true, 5)
    const fair = (amountIn * 9_999n) / 10_000n
    expect(fair >= floor).toBe(true)
    // An attacker moves the price 1% against us before our read: the quote drops by ~1%, under the floor.
    const manipulated = (fair * 9_900n) / 10_000n
    expect(manipulated < floor).toBe(true)
    // The floor sits exactly the limit under the fee-adjusted TWAP output.
    expect(floor).toBe((fair * 9_995n) / 10_000n)
  })

  test('it follows the token order of the pool', () => {
    // cbBTC (token1, 8 decimals) priced around tick -69,080 against USDC (token0, 6): selling USDC is token0 in.
    const a = twapFloor(1_000n * USDC, 500, -69_080, true, 30)
    const b = twapFloor(1_000n * USDC, 500, -69_080 + 100, true, 30)
    expect(b > a).toBe(true)
  })
})
