import { describe, expect, test } from 'bun:test'
import { conservadorLiveV2, grantKey } from '@mamoru/policy'
import { address, baseRegistry, entry } from '@mamoru/registry'
import { quoteMint, sqrtRatioAtTick, token0InToken1, token1InToken0 } from '@mamoru/uniswap-v3/quote'
import { capRoomOf, decide, placedOf, withinCap, type Observation, type PoolObs, type PositionObs } from './index.ts'

// otto/mamoru#212: the engine places new savings only within the account's cap, counted across chains.
const V2 = conservadorLiveV2
const USDC = 1_000_000n

function pool(name: string, tick: number): PoolObs {
  const e = entry(name, baseRegistry)
  return {
    name,
    address: e.address,
    token0: e.token0!,
    token1: e.token1!,
    fee: e.fee!,
    tickSpacing: e.tickSpacing!,
    sqrtPriceX96: sqrtRatioAtTick(tick),
    tick,
    liquidity: 10n ** 24n,
    twapTick: tick,
    twapLiquidity: 10n ** 24n,
    identity: { factoryPool: e.address, token0: address(e.token0!, baseRegistry), token1: address(e.token1!, baseRegistry), fee: e.fee!, tickSpacing: e.tickSpacing! },
  }
}

const POOLS = [pool('pool:USDC/USDT/100', 1), pool('pool:USDC/cbBTC/500', -69_080), pool('pool:WETH/USDC/3000', -193_380)]

function obs(over: Partial<Observation> = {}): Observation {
  return {
    chainId: 8453,
    block: { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: 1_000n },
    safeBlock: { number: 98n, hash: `0x${'22'.repeat(32)}` },
    account: { address: '0x00000000000000000000000000000000000000aa', deployed: true, nonceKey: 0n, nonce: 0n },
    sessions: V2.session.grants.filter((g) => !g.perPosition).map((g, i) => ({ grant: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(2, '0').repeat(32)}` as const, validUntil: 10_000, active: true })),
    native: 10n ** 17n,
    balances: { USDC: 0n, USDT: 0n, cbBTC: 0n, WETH: 0n },
    positions: [],
    pools: POOLS,
    ethPrice: { pool: 'pool:WETH/USDC/3000', sqrtPriceX96: sqrtRatioAtTick(-193_380), token0: 'WETH' },
    gas: { maxFeePerGas: 2_000_000n, opGasUnits: 5_100_000n },
    deposits: [],
    intents: { paused: false, exitRequested: false },
    slot: null,
    ...over,
  }
}

/** Applies the decision's entry the way the chain would (no fees). Null when it holds or proposes anything else. */
function apply(o: Observation, nextId: bigint): Observation | null {
  const p = decide(o, V2).proposal
  if (!p || (p.kind !== 'enter_swap' && p.kind !== 'enter_mint')) return null
  const balances = { ...o.balances }
  const pl = o.pools.find((x) => x.name === p.pool)!
  if (p.kind === 'enter_swap') {
    const out = pl.token0 === p.tokenIn ? token0InToken1(p.amountIn, pl.sqrtPriceX96) : token1InToken0(p.amountIn, pl.sqrtPriceX96)
    balances[p.tokenIn] = balances[p.tokenIn]! - p.amountIn
    balances[p.tokenOut] = (balances[p.tokenOut] ?? 0n) + out
    return { ...o, balances }
  }
  const q = quoteMint({ sqrtPriceX96: pl.sqrtPriceX96, tickLower: p.tickLower, tickUpper: p.tickUpper, amount0Desired: p.amount0Desired, amount1Desired: p.amount1Desired, slippageBps: 50 })
  balances[pl.token0] = balances[pl.token0]! - q.amount0
  balances[pl.token1] = balances[pl.token1]! - q.amount1
  const pos: PositionObs = { tokenId: nextId, pool: pl.name, tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: q.liquidity, collectable0: 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: true }
  return { ...o, balances, positions: [...o.positions, pos] }
}

/** Every entry the engine would make, one review after the other, until it holds. */
function settle(o: Observation): Observation {
  let cur = o
  for (let i = 1n; i < 60n; i++) {
    const next = apply(cur, i)
    if (!next) return cur
    cur = next
  }
  throw new Error('did not settle')
}

describe('otto/mamoru#212: placing within the cap', () => {
  test('without a cap the observation and the decision are unchanged', () => {
    const o = obs({ balances: { USDC: 5_000n * USDC } })
    expect(withinCap(o, V2)).toBe(o)
    expect(capRoomOf(o, V2)).toBeNull()
  })

  test('placedOf counts positions and idle tokens other than the savings asset, never idle USDC', () => {
    const o = obs({ balances: { USDC: 300n * USDC, USDT: 50n * USDC } })
    // USDT at ~1.0: about 50 USDC placed (bought for an entry), the 300 idle USDC not.
    const placed = placedOf(o, V2)
    expect(placed > 49n * USDC && placed < 51n * USDC).toBe(true)
    const settled = settle(obs({ balances: { USDC: 400n * USDC } }))
    const p = placedOf(settled, V2)
    // What went into positions (and is left of the volatile side) is placed; what is idle USDC is not.
    expect(p + settled.balances.USDC! > 399n * USDC && p + settled.balances.USDC! <= 400n * USDC).toBe(true)
    expect(settled.positions.length).toBeGreaterThan(0)
  })

  test('over the cap, an entry is sized as if the account held only its room', () => {
    const capped = obs({ balances: { USDC: 5_000n * USDC }, cap: { capUsdc: 1_000n * USDC, elsewhereUsdc: 0n } })
    const plain = obs({ balances: { USDC: 1_000n * USDC } })
    expect(decide(capped, V2).proposal).toEqual(decide(plain, V2).proposal)
  })

  test('the engine places up to the cap and leaves the rest idle', () => {
    const end = settle(obs({ balances: { USDC: 5_000n * USDC }, cap: { capUsdc: 1_000n * USDC, elsewhereUsdc: 0n } }))
    const placed = placedOf(end, V2)
    expect(placed <= 1_000n * USDC).toBe(true)
    expect(placed > 950n * USDC).toBe(true)
    expect(end.balances.USDC! >= 4_000n * USDC).toBe(true)
  })

  test('what the other chains placed comes off the room', () => {
    const end = settle(obs({ balances: { USDC: 1_000n * USDC }, cap: { capUsdc: 1_000n * USDC, elsewhereUsdc: 900n * USDC } }))
    expect(placedOf(end, V2) <= 100n * USDC).toBe(true)
    expect(end.balances.USDC! >= 900n * USDC).toBe(true)
  })

  test('another chain that could not be read: nothing new is placed (fail closed)', () => {
    const o = obs({ balances: { USDC: 500n * USDC }, cap: { capUsdc: 1_000n * USDC, elsewhereUsdc: null } })
    expect(capRoomOf(o, V2)).toBe(0n)
    const d = decide(o, V2)
    expect(d.proposal).toBeNull()
    expect(d.kind).toBe('hold')
  })

  test('placed above the cap (the market rose): nothing new goes in, nothing is sold, an out-of-range position is still re-ranged', () => {
    const placed = settle(obs({ balances: { USDC: 2_000n * USDC } }))
    const over = { ...placed, balances: { ...placed.balances, USDC: placed.balances.USDC! + 3_000n * USDC }, cap: { capUsdc: 1_000n * USDC, elsewhereUsdc: 0n } }
    expect(capRoomOf(over, V2)).toBe(0n)
    const d = decide(over, V2)
    // No entry and no sale of what is placed: the decision holds.
    expect(d.proposal).toBeNull()
    // The cbBTC price leaves the range of the position there: the re-range of money already placed is unaffected.
    const btc = over.positions.find((p) => p.pool === 'pool:USDC/cbBTC/500')!
    const moved = { ...over, pools: over.pools.map((p) => (p.name === btc.pool ? { ...p, tick: btc.tickUpper + 500, twapTick: btc.tickUpper + 500, sqrtPriceX96: sqrtRatioAtTick(btc.tickUpper + 500) } : p)) }
    expect(decide(moved, V2).proposal).toMatchObject({ kind: 'rerange', pool: 'pool:USDC/cbBTC/500', tokenId: btc.tokenId })
  })
})
