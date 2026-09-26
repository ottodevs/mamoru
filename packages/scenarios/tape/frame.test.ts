import { describe, expect, test } from 'bun:test'
import type { ScenarioTape, TapeFrame } from '@mamoru/domain'
import { decide, type Observation } from '@mamoru/decide'
import { POLICIES } from '@mamoru/policy'
import { address, entry } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { amountToTick, buildFrame, checkTape, priceDec, toDec } from './frame.ts'

const policy = POLICIES['conservador-lab-v1']!
const POOL = 'pool:USDC/cbBTC/500'
const Q96 = 1n << 96n

describe('toDec', () => {
  test('raw units to trimmed decimals', () => {
    expect(toDec(1_234_500n, 6)).toBe('1.2345')
    expect(toDec(5n, 6)).toBe('0.000005')
    expect(toDec(0n, 6)).toBe('0')
    expect(toDec(10_000_000_000n, 6)).toBe('10000')
    expect(toDec(-1_500_000n, 6)).toBe('-1.5')
  })
  test('rounds down to the requested places', () => {
    expect(toDec(123_456_789n, 9, 4)).toBe('0.1234')
    expect(toDec(100_000_000n, 9, 4)).toBe('0.1')
  })
})

describe('priceDec', () => {
  const pool = { token0: 'USDC', token1: 'cbBTC' }
  test('volatile token1 priced in the savings token0', () => {
    // tick -67346 on USDC(6)/cbBTC(8): 1 cbBTC ~ 84,000 USDC.
    const p = Number(priceDec(sqrtRatioAtTick(-67346), pool, 'USDC'))
    expect(p).toBeGreaterThan(84_000)
    expect(p).toBeLessThan(84_300)
  })
  test('a lower tick is a higher volatile price when the savings asset is token0', () => {
    expect(Number(priceDec(sqrtRatioAtTick(-68350), pool, 'USDC'))).toBeGreaterThan(Number(priceDec(sqrtRatioAtTick(-66340), pool, 'USDC')))
  })
})

describe('amountToTick', () => {
  test('down needs token0 in, up needs token1 in', () => {
    const s = sqrtRatioAtTick(0)
    expect(amountToTick(s, 10n ** 18n, -100).zeroForOne).toBe(true)
    expect(amountToTick(s, 10n ** 18n, 100).zeroForOne).toBe(false)
  })
  test('token1 in is liquidity times the sqrt price move', () => {
    const s = Q96
    const target = sqrtRatioAtTick(100)
    expect(amountToTick(s, Q96, 100).amountIn).toBe(target - s)
  })
})

function observation(tick: number, over: Partial<{ collectable0: bigint; managed: boolean; baseFee: bigint }> = {}): Observation {
  const e = entry(POOL)
  const sqrt = sqrtRatioAtTick(tick)
  return {
    chainId: 31337,
    block: { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: 1_000n },
    safeBlock: { number: 100n, hash: `0x${'11'.repeat(32)}` },
    account: { address: '0x0000000000000000000000000000000000000001', deployed: true, nonceKey: 0n, nonce: 0n },
    sessions: [{ grant: 'manage:7', permissionId: `0x${'22'.repeat(32)}`, tokenId: 7n, validUntil: 2 ** 40, active: true }],
    native: 10n ** 18n,
    balances: {},
    positions: [
      { tokenId: 7n, pool: POOL, tickLower: tick - 1000, tickUpper: tick + 1000, liquidity: 10n ** 12n, collectable0: over.collectable0 ?? 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: over.managed ?? true },
    ],
    pools: [
      {
        name: POOL,
        address: e.address,
        token0: 'USDC',
        token1: 'cbBTC',
        fee: 500,
        tickSpacing: 10,
        sqrtPriceX96: sqrt,
        tick,
        liquidity: 10n ** 15n,
        twapTick: tick,
        identity: { factoryPool: e.address, token0: address('USDC'), token1: address('cbBTC'), fee: 500, tickSpacing: 10 },
      },
    ],
    ethPrice: { pool: 'pool:WETH/USDC/3000', sqrtPriceX96: sqrtRatioAtTick(-196_000), token0: 'WETH' },
    gas: { maxFeePerGas: (over.baseFee ?? 100_000_000n) * 2n + 1_000_000n, opGasUnits: 5_100_000n },
    deposits: [],
    intents: { paused: false, exitRequested: false },
    slot: null,
  }
}

function frameOf(obs: Observation, t0 = 1_000n): TapeFrame {
  return buildFrame({ obs, decision: decide(obs, policy), policy, pool: POOL, t0, maxPriorityFeePerGas: 1_000_000n }, { key: true, title: 'x', note: 'y' })
}

describe('buildFrame', () => {
  test('a quiet in-range position holds, figures in human units', () => {
    const f = frameOf(observation(-67346))
    expect(f.t).toBe(0)
    expect(f.block).toBe(100)
    expect(f.decision).toMatchObject({ kind: 'hold', code: 'DECIDE_HOLD', reason: 'DECIDE_IN_RANGE' })
    expect(f.cost.baseFeeGwei).toBe('0.1')
    expect(f.cost.factorBps).toBe(30000)
    expect(Number(f.cost.threshold)).toBeCloseTo(Number(f.cost.opCost) * 3, 4)
    expect(f.position).toMatchObject({ tokenId: '7', inRange: true, feesValue: '0' })
    expect(Number(f.position!.lowerPrice)).toBeLessThan(Number(f.pool.price))
    expect(Number(f.position!.upperPrice)).toBeGreaterThan(Number(f.pool.price))
    expect(f.pool.name).toBe('USDC/cbBTC/500')
    expect(f.tx).toBeNull()
  })
  test('fees above three times the cost make decide harvest', () => {
    const f = frameOf(observation(-67346, { collectable0: 1_000_000_000n }))
    expect(f.position!.feesValue).toBe('1000')
    expect(f.decision).toMatchObject({ kind: 'harvest', code: 'DECIDE_HARVEST' })
    expect(f.decision.decisionId).toMatch(/^0x[0-9a-f]{64}$/)
  })
  test('an unmanaged position is not shown as the managed one', () => {
    expect(frameOf(observation(-67346, { managed: false })).position).toBeNull()
  })
})

describe('checkTape', () => {
  const tape = (frames: TapeFrame[], chainId = 31337): ScenarioTape => ({ id: 'TAPE-HARVEST', title: 't', summary: 's', savingsAsset: 'USDC', chainId, forkOf: 'Base', forkBlock: 1, recordedAt: '', frames })
  const f = frameOf(observation(-67346))
  test('accepts a well-formed tape', () => {
    expect(checkTape(tape([f, { ...f, t: 10, block: 101 }, { ...f, t: 20, block: 102, key: false }]))).toEqual([])
  })
  test('refuses Base chain ids, too few frames and time going back', () => {
    expect(checkTape(tape([f, f, f], 8453)).join()).toContain('Base')
    expect(checkTape(tape([f])).join()).toContain('1 frames')
    expect(checkTape(tape([f, { ...f, t: 10, block: 101 }, { ...f, t: 5, block: 102 }])).join()).toContain('back in time')
  })
})

describe('recorded tapes', () => {
  for (const file of ['harvest', 'out-of-range', 'pool-shock']) {
    test(`${file}.json is a lab-chain tape with keyframes`, async () => {
      const tape = (await Bun.file(`${import.meta.dir}/../../../apps/mamoru-app/src/web/lab/tapes/${file}.json`).json()) as ScenarioTape
      expect(checkTape(tape)).toEqual([])
      expect(tape.forkOf).toBe('Base')
      expect(tape.frames.length).toBeGreaterThanOrEqual(10)
    })
  }
})
