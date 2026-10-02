import { describe, expect, test } from 'bun:test'
import { conservadorLiveV2, grantKey } from '@mamoru/policy'
import { address, entry } from '@mamoru/registry'
import { quoteMint, sqrtRatioAtTick, token0InToken1, token1InToken0 } from '@mamoru/uniswap-v3/quote'
import { allocate, decide, type Observation, type PoolObs, type PositionObs } from './index.ts'

const V2 = conservadorLiveV2
const USDC = 1_000_000n

function pool(name: string, tick: number): PoolObs {
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
    liquidity: 10n ** 18n,
    twapTick: tick,
    identity: { factoryPool: e.address, token0: address(e.token0!), token1: address(e.token1!), fee: e.fee!, tickSpacing: e.tickSpacing! },
  }
}

// USDT ~1.0, BTC ~100k USD (cbBTC 8 decimals over USDC 6), ETH ~4000 USD (WETH 18 decimals is token0).
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

/** Applies a proposal the way the chain would (no fees): swaps at slot0, mints what quoteMint uses. */
function apply(o: Observation, nextId: bigint): Observation {
  const d = decide(o, V2)
  const p = d.proposal
  if (!p) return o
  const balances = { ...o.balances }
  const pl = o.pools.find((x) => x.name === p.pool)!
  if (p.kind === 'enter_swap') {
    const out = pl.token0 === p.tokenIn ? token0InToken1(p.amountIn, pl.sqrtPriceX96) : token1InToken0(p.amountIn, pl.sqrtPriceX96)
    balances[p.tokenIn] = balances[p.tokenIn]! - p.amountIn
    balances[p.tokenOut] = (balances[p.tokenOut] ?? 0n) + out
    return { ...o, balances }
  }
  if (p.kind !== 'enter_mint') throw new Error(`unexpected ${p.kind}`)
  const q = quoteMint({ sqrtPriceX96: pl.sqrtPriceX96, tickLower: p.tickLower, tickUpper: p.tickUpper, amount0Desired: p.amount0Desired, amount1Desired: p.amount1Desired, slippageBps: 50 })
  balances[pl.token0] = balances[pl.token0]! - q.amount0
  balances[pl.token1] = balances[pl.token1]! - q.amount1
  const pos: PositionObs = { tokenId: nextId, pool: pl.name, tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: q.liquidity, collectable0: 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: true }
  return { ...o, balances, positions: [...o.positions, pos] }
}

describe('allocate (conservador-live-v2, target weights)', () => {
  test('a fresh 20 USDC account swaps into the stables pool first, with the per-pair grant', () => {
    const d = decide(obs({ balances: { USDC: 20n * USDC } }), V2)
    expect(d.code).toBe('DECIDE_ENTER')
    expect(d.proposal).toMatchObject({ kind: 'enter_swap', grant: 'enter-swap:pool:USDC/USDT/100', pool: 'pool:USDC/USDT/100', tokenIn: 'USDC', tokenOut: 'USDT', fee: 100 })
    const amountIn = (d.proposal as { amountIn: bigint }).amountIn
    expect(amountIn > 4n * USDC && amountIn < 6n * USDC).toBe(true)
    expect(d.buckets.map((b) => b.code)).toEqual(['STRATEGY_PREFERENCE_DEVIATION', 'STRATEGY_PREFERENCE', 'STRATEGY_PREFERENCE'])
    expect(d.trail.at(-1)).toEqual({ gate: 'ehg', verdict: 'GO', reason: 'EHG_OK' })
  })

  test('the stable pool mints a narrow range around 1.0 (+-0.2%)', () => {
    const btc = { tokenId: 2n, pool: 'pool:USDC/cbBTC/500', tickLower: -69_100, tickUpper: -69_050, liquidity: 0n, collectable0: 8n * USDC, collectable1: 0n, principalOwed0: 8n * USDC, principalOwed1: 0n, managed: true }
    const risk = { ...btc, tokenId: 3n, pool: 'pool:WETH/USDC/3000', collectable0: 0n, collectable1: 2n * USDC, principalOwed0: 0n, principalOwed1: 2n * USDC }
    const d = decide(obs({ balances: { USDC: 5_600_000n, USDT: 5n * USDC }, positions: [btc, risk] }), V2)
    expect(d.proposal?.kind).toBe('enter_mint')
    if (d.proposal?.kind !== 'enter_mint') throw new Error('unreachable')
    expect(d.proposal.grant).toBe('enter-mint:pool:USDC/USDT/100')
    expect(d.proposal.tickUpper - d.proposal.tickLower).toBe(41)
    expect(d.proposal.amount1Desired).toBe(5n * USDC)
  })

  test('the risk pool mints on its 60-tick spacing with WETH as token0', () => {
    const weth = token1InToken0(1n * USDC, POOLS[2]!.sqrtPriceX96)
    const stable = { tokenId: 1n, pool: 'pool:USDC/USDT/100', tickLower: -19, tickUpper: 22, liquidity: 0n, collectable0: 10n * USDC, collectable1: 0n, principalOwed0: 10n * USDC, principalOwed1: 0n, managed: true }
    const btc = { ...stable, tokenId: 2n, pool: 'pool:USDC/cbBTC/500', collectable0: 8n * USDC, principalOwed0: 8n * USDC }
    const d = decide(obs({ balances: { USDC: 1n * USDC, WETH: weth }, positions: [stable, btc] }), V2)
    expect(d.proposal?.kind).toBe('enter_mint')
    if (d.proposal?.kind !== 'enter_mint') throw new Error('unreachable')
    expect(d.proposal.pool).toBe('pool:WETH/USDC/3000')
    expect(Math.abs(d.proposal.tickLower % 60)).toBe(0)
    expect(d.proposal.amount0Desired).toBe(weth)
  })

  test('20 USDC ends ~100% invested near 50/40/10, then holds', () => {
    let o = obs({ balances: { USDC: 20n * USDC } })
    let steps = 0
    for (let id = 1n; steps < 20; steps++, id++) {
      const next = apply(o, id)
      if (next === o) break
      o = next
    }
    const d = decide(o, V2)
    expect(d.proposal).toBeNull()
    const a = allocate(o, V2, false)
    const w = a.buckets.map((b) => b.weightBps)
    expect(Math.abs(w[0]! - 5000)).toBeLessThan(150)
    expect(Math.abs(w[1]! - 4000)).toBeLessThan(150)
    expect(Math.abs(w[2]! - 1000)).toBeLessThan(150)
    expect(a.free < 3n * V2.minEntry!).toBe(true)
    expect(o.positions.map((p) => p.pool)).toEqual(['pool:USDC/USDT/100', 'pool:USDC/cbBTC/500', 'pool:WETH/USDC/3000'])
    expect(steps).toBeLessThanOrEqual(9)
  })

  test('a new deposit after allocation is re-invested toward the most under-weight bucket', () => {
    let o = obs({ balances: { USDC: 20n * USDC } })
    for (let id = 1n; id < 20n; id++) {
      const next = apply(o, id)
      if (next === o) break
      o = next
    }
    // A withdraw emptied most of btc: the next review tops it up from the new idle USDC.
    const positions = o.positions.map((p) => (p.pool === 'pool:USDC/cbBTC/500' ? { ...p, liquidity: p.liquidity / 4n } : p))
    const d = decide({ ...o, positions, balances: { ...o.balances, USDC: o.balances.USDC! + 5n * USDC } }, V2)
    expect(d.proposal).toMatchObject({ kind: 'enter_swap', pool: 'pool:USDC/cbBTC/500', grant: 'enter-swap:pool:USDC/cbBTC/500' })
  })

  /** A 20 USDC account taken to its resting state: three positions, nothing left to do. */
  function invested(): { o: Observation; id: bigint } {
    let o = obs({ balances: { USDC: 20n * USDC } })
    let id = 1n
    for (; id < 20n; id++) {
      const next = apply(o, id)
      if (next === o) break
      o = next
    }
    return { o, id }
  }

  /** Reviews until `decide` holds. Returns every proposal on the way, as `kind:pool:tokenOut`. */
  function settle(start: Observation, id: bigint, max = 24): { o: Observation; steps: string[] } {
    let o = start
    const steps: string[] = []
    for (let n = 0; n < max; n++, id++) {
      const p = decide(o, V2).proposal
      if (!p) return { o, steps }
      steps.push(`${p.kind}:${p.pool}${p.kind === 'enter_swap' ? `:${p.tokenOut}` : ''}`)
      o = apply(o, id)
    }
    throw new Error(`still proposing after ${max} reviews: ${steps.join(' | ')}`)
  }

  const idleValue = (o: Observation) => (['USDT', 'cbBTC', 'WETH'] as const).reduce((n, t, k) => n + (POOLS[k]!.token0 === t ? token0InToken1(o.balances[t] ?? 0n, POOLS[k]!.sqrtPriceX96) : token1InToken0(o.balances[t] ?? 0n, POOLS[k]!.sqrtPriceX96)), 0n)

  test('a top-up of an invested account is swapped once per bucket and minted, never sold back', () => {
    const { o: base, id } = invested()
    expect(base.positions).toHaveLength(3)
    // 10 USDC more: every bucket is short by its share, the risk bucket by 1 USDC (3% of the account).
    const { o, steps } = settle({ ...base, balances: { ...base.balances, USDC: base.balances.USDC! + 10n * USDC } }, id)
    // The loop this guards against: buy the volatile token, then sell it back with convert-any at the next review.
    expect(steps.filter((k) => k.endsWith(':USDC'))).toEqual([])
    expect(steps.filter((k) => k.startsWith('enter_mint'))).toHaveLength(3)
    expect(steps.filter((k) => k.startsWith('enter_swap')).length).toBeLessThanOrEqual(3)
    expect(allocate(o, V2, false).free < 3n * V2.minEntry!).toBe(true)
    expect(o.positions).toHaveLength(6)
  })

  test('top-ups of any size settle: every swap toward a bucket is followed by its mint, nothing is left bought and unminted', () => {
    for (const cents of [30n, 65n, 100n, 300n, 1_000n, 5_000n, 20_000n]) {
      const { o: base, id } = invested()
      const { o, steps } = settle({ ...base, balances: { ...base.balances, USDC: base.balances.USDC! + cents * 10_000n } }, id)
      const bought = steps.filter((k) => k.startsWith('enter_swap') && !k.endsWith(':USDC')).map((k) => k.split(':').slice(1, 3).join(':'))
      const minted = steps.filter((k) => k.startsWith('enter_mint')).map((k) => k.split(':').slice(1, 3).join(':'))
      // One purchase per bucket at most, and each one ends in a position.
      expect(new Set(bought).size).toBe(bought.length)
      for (const pool of bought) expect(minted).toContain(pool)
      expect(steps.filter((k) => k.endsWith(':USDC'))).toEqual([])
      // What stays idle in volatile tokens is mint dust, far under the smallest entry.
      expect(idleValue(o) < V2.minEntry!).toBe(true)
    }
  }, 60_000)

  test('the same top-up settles when the pool price sits away from its average', () => {
    const { o: base, id } = invested()
    // The two volatile pools trade 30 ticks (0.3%) above their 30-minute average; the stable pool stays on it.
    const moved = { ...base, pools: base.pools.map((p, k) => (k === 0 ? p : { ...p, twapTick: p.tick - 30 })), balances: { ...base.balances, USDC: base.balances.USDC! + 10n * USDC } }
    const { steps } = settle(moved, id)
    expect(steps.filter((k) => k.startsWith('enter_mint')).length).toBeGreaterThanOrEqual(3)
    const sells = steps.filter((k) => k.endsWith(':USDC'))
    expect(sells.length).toBeLessThanOrEqual(1)
  })

  test('one-sided volatile and no savings to pair it: the excess is sold once, the rest is minted', () => {
    // What a re-range leaves when the price sat at the top of the range: all cbBTC, no USDC.
    const { o: base, id } = invested()
    const cbbtc = token0InToken1(800_000n, POOLS[1]!.sqrtPriceX96)
    const oneSided = { ...base, balances: { ...base.balances, USDC: 0n, cbBTC: (base.balances.cbBTC ?? 0n) + cbbtc } }
    const first = decide(oneSided, V2).proposal
    expect(first).toMatchObject({ kind: 'enter_swap', grant: 'convert-any:pool:USDC/cbBTC/500', tokenIn: 'cbBTC', tokenOut: 'USDC' })
    // Part of it, not all: the rest is the volatile side of the mint.
    expect((first as { amountIn: bigint }).amountIn < cbbtc).toBe(true)
    const { o, steps } = settle(oneSided, id)
    expect(steps.filter((k) => k === 'enter_swap:pool:USDC/cbBTC/500:USDC')).toHaveLength(1)
    expect(steps).toContain('enter_mint:pool:USDC/cbBTC/500')
    expect(steps.filter((k) => k.startsWith('enter_swap:pool:USDC/cbBTC/500:cbBTC'))).toEqual([])
    expect(idleValue(o) < V2.minEntry!).toBe(true)
  })

  test('idle volatile of a bucket that is not short has no mint to wait for and is sold back, once', () => {
    const { o: base, id } = invested()
    const cbbtc = token0InToken1(200_000n, POOLS[1]!.sqrtPriceX96)
    const idle = { ...base, balances: { ...base.balances, USDC: 0n, cbBTC: (base.balances.cbBTC ?? 0n) + cbbtc } }
    expect(allocate(idle, V2, false).pendingMint).toEqual([])
    const { steps } = settle(idle, id)
    expect(steps).toEqual(['enter_swap:pool:USDC/cbBTC/500:USDC'])
  })

  test('a bucket that holds part of its volatile and must buy the rest keeps what it holds', () => {
    // Stables bucket emptied, 2 USDT already in the account, 10 USDC free: the next step is a purchase of more USDT.
    const { o: base } = invested()
    const positions = base.positions.filter((p) => p.pool !== 'pool:USDC/USDT/100')
    const o = { ...base, positions, balances: { ...base.balances, USDC: 10n * USDC, USDT: 2n * USDC } }
    expect(allocate(o, V2, false).pendingMint).toContain('pool:USDC/USDT/100')
    const p = decide(o, V2).proposal
    expect(p).toMatchObject({ kind: 'enter_swap', pool: 'pool:USDC/USDT/100', tokenIn: 'USDC', tokenOut: 'USDT' })
  })

  /** The btc bucket a little short (inside the 5-point drift, outside the 3% band), the other two a little over: only btc has an entry. */
  let settled: Observation | undefined
  function btcShort(usdc: bigint, cbbtcValue: bigint, others = 104n): Observation {
    const base = (settled ??= invested().o)
    const scale = (pool: string) => (pool === 'pool:USDC/cbBTC/500' ? 90n : others)
    const positions = base.positions.map((p) => ({ ...p, liquidity: (p.liquidity * scale(p.pool!)) / 100n }))
    return { ...base, positions, balances: { ...base.balances, USDC: usdc, cbBTC: token0InToken1(cbbtcValue, POOLS[1]!.sqrtPriceX96) } }
  }

  test('with no live session for the mint, the idle token is not held back for it', () => {
    const o = btcShort(400_000n, 400_000n)
    expect(allocate(o, V2, false).pendingMint).toEqual(['pool:USDC/cbBTC/500'])
    expect(decide(o, V2).proposal).toMatchObject({ kind: 'enter_mint', pool: 'pool:USDC/cbBTC/500' })
    // The same account without the enter-mint session of that pool: the mint cannot go, so the token is free to convert.
    const noMint = { ...o, sessions: o.sessions.filter((s) => s.grant !== 'enter-mint:pool:USDC/cbBTC/500') }
    expect(decide(noMint, V2).proposal).toMatchObject({ kind: 'enter_swap', grant: 'convert-any:pool:USDC/cbBTC/500', tokenIn: 'cbBTC', tokenOut: 'USDC' })
  })

  test('a mint asks for no more of the idle token than its split needs', () => {
    // More cbBTC than the mint needs, over a range of free savings: wherever the entry is a mint of that pool,
    // it asks for a balanced pair and not for the whole idle balance (the session cap counts what is asked for).
    let mints = 0
    for (let cents = 40n; cents <= 400n; cents += 40n) {
      const o = btcShort(cents * 10_000n, 2_400_000n, 124n)
      const p = allocate(o, V2, false).proposal
      if (p?.kind !== 'enter_mint' || p.pool !== 'pool:USDC/cbBTC/500') continue
      mints++
      const asked = token1InToken0(p.amount1Desired, POOLS[1]!.sqrtPriceX96)
      expect(p.amount1Desired <= o.balances.cbBTC!).toBe(true)
      expect(asked <= (p.amount0Desired * 12n) / 10n).toBe(true)
      expect(asked >= (p.amount0Desired * 8n) / 10n).toBe(true)
    }
    expect(mints).toBeGreaterThan(2)
  }, 60_000)

  test('token dust next to a short bucket is not minted: the proposal could never be built', () => {
    // Free savings spent, a few raw units of USDT left by the last mint, and the stables bucket short of its target.
    const { o: base } = invested()
    const positions = base.positions.map((p) => (p.pool === 'pool:USDC/USDT/100' ? { ...p, liquidity: (p.liquidity * 8n) / 10n } : p))
    const d = decide({ ...base, positions, balances: { ...base.balances, USDC: 40n, USDT: 3n } }, V2)
    expect(d.proposal).toBeNull()
    expect(allocate({ ...base, positions, balances: { ...base.balances, USDC: 40n, USDT: 3n } }, V2, false).pendingMint).toEqual([])
  })

  test('dust below the minimum entry holds', () => {
    const d = decide(obs({ balances: { USDC: 90_000n } }), V2)
    expect(d.proposal).toBeNull()
  })

  test('an unsafe deposit holds', () => {
    const d = decide(obs({ balances: { USDC: 20n * USDC }, deposits: [{ token: 'USDC', amount: 20n * USDC, block: 99n, txHash: `0x${'33'.repeat(32)}`, logIndex: 0, safe: false }] }), V2)
    expect(d.proposal).toBeNull()
    expect(d.reason).toBe('OBS_DEPOSIT_UNSAFE')
  })
})
