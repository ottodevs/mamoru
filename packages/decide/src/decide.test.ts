import { describe, expect, test } from 'bun:test'
import { conservadorLabV1, conservadorV1 } from '@mamoru/policy'
import { address, entry } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { canonicalJson, decide, type Observation, type PoolObs, type PositionObs } from './index.ts'

const POOL = 'pool:USDC/cbBTC/500'
const ACCOUNT = '0x00000000000000000000000000000000000000aa'
const TICK = 69_000

function pool(over: Partial<PoolObs> = {}): PoolObs {
  const e = entry(POOL)
  return {
    name: POOL,
    address: e.address,
    token0: 'USDC',
    token1: 'cbBTC',
    fee: 500,
    tickSpacing: 10,
    sqrtPriceX96: sqrtRatioAtTick(TICK),
    tick: TICK,
    liquidity: 10n ** 18n,
    twapTick: TICK,
    identity: { factoryPool: e.address, token0: address('USDC'), token1: address('cbBTC'), fee: 500, tickSpacing: 10 },
    ...over,
  }
}

function obs(over: Partial<Observation> = {}): Observation {
  return {
    chainId: 31337,
    block: { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: 1_000n },
    safeBlock: { number: 98n, hash: `0x${'22'.repeat(32)}` },
    account: { address: ACCOUNT, deployed: true, nonceKey: 0n, nonce: 0n },
    sessions: [
      { grant: 'enter-swap', permissionId: `0x${'01'.repeat(32)}`, validUntil: 10_000, active: true },
      { grant: 'enter-mint', permissionId: `0x${'02'.repeat(32)}`, validUntil: 10_000, active: true },
    ],
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

const deposit = (safe: boolean) => ({ token: 'USDC', amount: 10_000_000_000n, block: 99n, txHash: `0x${'33'.repeat(32)}` as const, logIndex: 0, safe })

function position(over: Partial<PositionObs> = {}): PositionObs {
  return { tokenId: 7n, pool: POOL, tickLower: TICK - 1000, tickUpper: TICK + 1010, liquidity: 10n ** 12n, collectable0: 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: true, ...over }
}

describe('decide', () => {
  test('no capital: hold, one code per bucket', () => {
    const d = decide(obs(), conservadorLabV1)
    expect(d.kind).toBe('hold')
    expect(d.code).toBe('DECIDE_HOLD')
    expect(d.reason).toBe('DECIDE_NO_CAPITAL')
    expect(d.buckets).toEqual([
      { bucket: 'stables', code: 'PLAN_BUCKET_NO_EXECUTABLE_POOL' },
      { bucket: 'btc-usdc', code: 'DECIDE_NO_CAPITAL' },
      { bucket: 'risk', code: 'PLAN_BUCKET_NO_EXECUTABLE_POOL' },
    ])
    expect(d.observationCodes).toEqual(['OBS_OK'])
  })

  test('is deterministic byte for byte', () => {
    const o = obs({ balances: { USDC: 10_000_000_000n, cbBTC: 0n }, deposits: [deposit(true)] })
    expect(canonicalJson(decide(o, conservadorLabV1))).toBe(canonicalJson(decide(structuredClone(o), conservadorLabV1)))
  })

  test('an unsafe deposit holds without an operation', () => {
    const d = decide(obs({ balances: { USDC: 10_000_000_000n }, deposits: [deposit(false)] }), conservadorLabV1)
    expect(d.observationCodes).toContain('OBS_DEPOSIT_UNSAFE')
    expect(d.proposal).toBeNull()
    expect(d.reason).toBe('OBS_DEPOSIT_UNSAFE')
  })

  test('a safe deposit enters with a swap sized by preference', () => {
    const d = decide(obs({ balances: { USDC: 10_000_000_000n, cbBTC: 0n }, deposits: [deposit(true)] }), conservadorLabV1)
    expect(d.observationCodes).toContain('OBS_DEPOSIT_DETECTED')
    expect(d.code).toBe('DECIDE_ENTER')
    expect(d.proposal).toMatchObject({ kind: 'enter_swap', grant: 'enter-swap', tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn: 2_000_000_000n })
    expect(d.buckets.find((b) => b.bucket === 'btc-usdc')?.code).toBe('STRATEGY_PREFERENCE')
    expect(d.shadow.map((s) => s.code)).toEqual(['ENY_SHADOW'])
    expect(d.trail.at(-1)).toEqual({ gate: 'ehg', verdict: 'GO', reason: 'EHG_OK' })
  })

  test('with both tokens, mints on the pool spacing', () => {
    const p = pool()
    const cbbtc = (2_000_000_000n * p.sqrtPriceX96 * p.sqrtPriceX96) >> 192n
    const d = decide(obs({ balances: { USDC: 8_000_000_000n, cbBTC: cbbtc } }), conservadorLabV1)
    expect(d.proposal?.kind).toBe('enter_mint')
    if (d.proposal?.kind !== 'enter_mint') throw new Error('unreachable')
    expect(d.proposal.tickLower % 10).toBe(0)
    expect(d.proposal.tickUpper % 10).toBe(0)
    expect(d.proposal.amount1Desired).toBe(cbbtc)
  })

  test('a fresh managed position holds in range, below cost', () => {
    const d = decide(obs({ balances: { USDC: 6_000_000_000n }, positions: [position()] }), conservadorLabV1)
    expect(d.reason).toBe('DECIDE_IN_RANGE')
    expect(d.positions).toEqual([{ tokenId: 7n, codes: ['DECIDE_HARVEST_BELOW_COST'] }])
  })

  test('fees above cost propose a harvest that converts only the fees', () => {
    const manage = { grant: 'manage:7', permissionId: `0x${'03'.repeat(32)}` as const, tokenId: 7n, validUntil: 10_000, active: true }
    const d = decide(obs({ sessions: [manage], positions: [position({ collectable0: 5_000_000n, collectable1: 9_000n, principalOwed1: 1_000n })] }), conservadorLabV1)
    expect(d.code).toBe('DECIDE_HARVEST')
    expect(d.proposal).toMatchObject({ kind: 'harvest', grant: 'manage:7', tokenId: 7n, fees0: 5_000_000n, fees1: 8_000n, convert: { token: 'cbBTC', amount: 8_000n } })
    expect(d.positions[0]!.codes).toEqual(['OBS_FEES_ABOVE_COST', 'DECIDE_HARVEST'])
  })

  test('an unmanaged position never gets a proposal', () => {
    const d = decide(obs({ positions: [position({ managed: false, collectable0: 5_000_000n })] }), conservadorLabV1)
    expect(d.proposal).toBeNull()
    expect(d.positions[0]!.codes).toContain('OBS_UNMANAGED_ASSET')
  })

  test('a position outside the policy pools is unmanaged', () => {
    const d = decide(obs({ positions: [position({ pool: null })] }), conservadorV1)
    expect(d.positions[0]!.codes).toEqual(['OBS_UNMANAGED_ASSET'])
  })

  test('Purga refuses a pool whose identity does not match', () => {
    const bad = pool({ identity: { ...pool().identity, fee: 3000 } })
    const d = decide(obs({ pools: [bad], balances: { USDC: 10_000_000_000n } }), conservadorLabV1)
    expect(d.proposal).toBeNull()
    expect(d.buckets.find((b) => b.bucket === 'btc-usdc')?.code).toBe('PURGA_IDENTITY_MISMATCH')
  })

  test('the preliminary gate drops an entry on TWAP divergence', () => {
    const d = decide(obs({ pools: [pool({ twapTick: TICK - 500 })], balances: { USDC: 10_000_000_000n } }), conservadorLabV1)
    expect(d.proposal).toBeNull()
    expect(d.reason).toBe('EHG_PRICE_DIVERGENCE')
  })

  test('the preliminary gate needs a live session for the grant', () => {
    const d = decide(obs({ sessions: [], balances: { USDC: 10_000_000_000n } }), conservadorLabV1)
    expect(d.reason).toBe('SESSION_MISSING')
  })

  test('a busy slot holds', () => {
    const d = decide(obs({ slot: { opId: 'op-1', state: 'submitted' }, balances: { USDC: 10_000_000_000n } }), conservadorLabV1)
    expect(d.reason).toBe('DECIDE_SLOT_BUSY')
    expect(d.proposal).toBeNull()
  })
})
