import { describe, expect, test } from 'bun:test'
import { conservadorLabV1, conservadorLiveV1 } from '@mamoru/policy'
import { address, entry } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { decide, type Observation, type PoolObs, type PositionObs } from '../index.ts'

const POOL = 'pool:USDC/cbBTC/500'
const TICK = 69_000
const live = conservadorLiveV1

function pool(tick = TICK): PoolObs {
  const e = entry(POOL)
  return {
    name: POOL,
    address: e.address,
    token0: 'USDC',
    token1: 'cbBTC',
    fee: 500,
    tickSpacing: 10,
    sqrtPriceX96: sqrtRatioAtTick(tick),
    tick,
    liquidity: 10n ** 18n,
    twapTick: tick,
    identity: { factoryPool: e.address, token0: address('USDC'), token1: address('cbBTC'), fee: 500, tickSpacing: 10 },
  }
}

const session = (grant: string, i: number) => ({ grant, permissionId: `0x${String(i).padStart(2, '0').repeat(32)}` as const, validUntil: 1_000_000, active: true })

function obs(over: Partial<Observation> = {}): Observation {
  return {
    chainId: 8453,
    block: { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: 10_000n },
    safeBlock: { number: 98n, hash: `0x${'22'.repeat(32)}` },
    account: { address: '0x00000000000000000000000000000000000000aa', deployed: true, nonceKey: 0n, nonce: 0n },
    sessions: [session('enter-swap', 1), session('enter-mint', 2), session('manage-any', 3), session('convert-any', 4)],
    native: 10n ** 17n,
    balances: { USDC: 0n, cbBTC: 0n, WETH: 0n },
    positions: [],
    pools: [pool()],
    ethPrice: { pool: 'pool:WETH/USDC/3000', sqrtPriceX96: sqrtRatioAtTick(-197_000), token0: 'WETH' },
    gas: { maxFeePerGas: 2_000_000n, opGasUnits: 5_100_000n },
    deposits: [],
    intents: { paused: false, exitRequested: false },
    slot: null,
    ...over,
  }
}

/** Range 68000..70000, width 2000; `managed: false` as the live engine observes it (no per-id grant). */
function position(over: Partial<PositionObs> = {}): PositionObs {
  return { tokenId: 7n, pool: POOL, tickLower: TICK - 1000, tickUpper: TICK + 1000, liquidity: 10n ** 12n, collectable0: 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: false, ...over }
}

/** Idle USDC that keeps the btc-usdc bucket near its 40% target, so only the range matters. */
const BALANCED = { USDC: 4_645_000_000n, cbBTC: 0n, WETH: 0n }

describe('rerange (manage-any)', () => {
  test('out of range: rerange the whole position with manage-any', () => {
    const d = decide(obs({ balances: BALANCED, positions: [position()], pools: [pool(TICK + 1500)] }), live)
    expect(d.kind).toBe('rerange')
    expect(d.code).toBe('DECIDE_RANGE_ADJUST')
    expect(d.proposal).toEqual({ kind: 'rerange', grant: 'manage-any', pool: POOL, tokenId: 7n, liquidity: 10n ** 12n })
    expect(d.positions[0]!.codes).toContain('OBS_POSITION_OUT_OF_RANGE')
    expect(d.trail.at(-1)).toEqual({ gate: 'ehg', verdict: 'GO', reason: 'EHG_OK' })
  })

  test('in range but within 10% of the width from an edge: rerange', () => {
    const d = decide(obs({ balances: BALANCED, positions: [position()], pools: [pool(TICK + 850)] }), live)
    expect(d.kind).toBe('rerange')
    expect(d.positions[0]!.codes).not.toContain('OBS_POSITION_OUT_OF_RANGE')
  })

  test('centred in range: hold', () => {
    const d = decide(obs({ balances: BALANCED, positions: [position()] }), live)
    expect(d.kind).toBe('hold')
    expect(d.reason).toBe('DECIDE_IN_RANGE')
  })

  test('cooldown not passed: hold with DECIDE_RANGE_COOLDOWN; passed: rerange', () => {
    const o = obs({ balances: BALANCED, positions: [position()], pools: [pool(TICK - 1500)], lastRerangeAt: 10_000n - 600n })
    const held = decide(o, live)
    expect(held.kind).toBe('hold')
    expect(held.positions[0]!.codes).toContain('DECIDE_RANGE_COOLDOWN')
    expect(live.range.cooldownSeconds).toBe(900)
    expect(decide({ ...o, lastRerangeAt: 10_000n - 900n }, live).kind).toBe('rerange')
  })

  test('without the manage-any session the proposal drops at the EHG', () => {
    const d = decide(obs({ balances: BALANCED, positions: [position()], pools: [pool(TICK + 1500)], sessions: [session('enter-swap', 1)] }), live)
    expect(d.proposal).toBeNull()
    expect(d.reason).toBe('SESSION_MISSING')
  })

  test('a policy without manage-any never reranges (lab/spec scenarios unchanged)', () => {
    const d = decide(obs({ balances: BALANCED, positions: [position({ managed: true })], pools: [pool(TICK + 1500)] }), conservadorLabV1)
    expect(d.kind).toBe('hold')
    expect(d.reason).toBe('OBS_POSITION_OUT_OF_RANGE')
  })

  test('after a rerange: volatile-heavy and no savings, convert the excess with convert-any', () => {
    const d = decide(obs({ balances: { USDC: 0n, cbBTC: 1_000_000_000n, WETH: 0n } }), live)
    expect(d.kind).toBe('enter_swap')
    expect(d.proposal).toMatchObject({ grant: 'convert-any', tokenIn: 'cbBTC', tokenOut: 'USDC' })
    expect((d.proposal as { amountIn: bigint }).amountIn).toBeLessThan(1_000_000_000n)
  })

  test('re-entry mints with manage-any', () => {
    const d = decide(obs({ balances: { USDC: 1_000_000_000n, cbBTC: 247_750_000_000n, WETH: 0n } }), live)
    expect(d.kind).toBe('enter_mint')
    expect(d.proposal).toMatchObject({ grant: 'manage-any' })
  })

  test('harvest under manage-any uses convert-any', () => {
    const p = position({ collectable0: 50_000_000n, collectable1: 50_000_000_000n })
    const d = decide(obs({ balances: BALANCED, positions: [p] }), live)
    expect(d.kind).toBe('harvest')
    expect(d.proposal).toMatchObject({ grant: 'convert-any', tokenId: 7n })
  })
})

describe('reduce (manage-any)', () => {
  test('bucket more than 5pp over its target: partial decrease of the excess', () => {
    const d = decide(obs({ positions: [position()] }), live)
    expect(d.kind).toBe('reduce')
    expect(d.code).toBe('STRATEGY_PREFERENCE_DEVIATION')
    const p = d.proposal as { grant: string; liquidity: bigint; tokenId: bigint }
    expect(p.grant).toBe('manage-any')
    expect(p.tokenId).toBe(7n)
    // 100% in the bucket against a 40% target: give back about 60% of the liquidity.
    expect(p.liquidity).toBeGreaterThan(55n * 10n ** 10n)
    expect(p.liquidity).toBeLessThan(65n * 10n ** 10n)
  })

  test('within 5pp of target: no reduce', () => {
    expect(decide(obs({ balances: BALANCED, positions: [position()] }), live).kind).toBe('hold')
  })
})
