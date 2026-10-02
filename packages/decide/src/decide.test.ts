import { describe, expect, test } from 'bun:test'
import { conservadorLabV1, conservadorV1, type PolicyVersion } from '@mamoru/policy'
import { address, baseRegistry, entry, monadRegistry, type Registry } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { purgaIdentity, registryOf } from './gates/index.ts'
import { allocate, canonicalJson, decide, type Observation, type PoolObs, type PositionObs } from './index.ts'

const POOL = 'pool:USDC/cbBTC/500'
const ACCOUNT = '0x00000000000000000000000000000000000000aa'
const TICK = 69_000

function pool(over: Partial<PoolObs> = {}): PoolObs {
  const e = entry(POOL, baseRegistry)
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
    identity: { factoryPool: e.address, token0: address('USDC', baseRegistry), token1: address('cbBTC', baseRegistry), fee: 500, tickSpacing: 10 },
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

  test('fees above cost propose a harvest that only collects (otto/mamoru#140)', () => {
    const manage = { grant: 'manage:7', permissionId: `0x${'03'.repeat(32)}` as const, tokenId: 7n, validUntil: 10_000, active: true }
    const d = decide(obs({ sessions: [manage], positions: [position({ collectable0: 5_000_000n, collectable1: 9_000n, principalOwed1: 1_000n })] }), conservadorLabV1)
    expect(d.code).toBe('DECIDE_HARVEST')
    expect(d.proposal).toMatchObject({ kind: 'harvest', grant: 'manage:7', tokenId: 7n, fees0: 5_000_000n, fees1: 8_000n, convert: null })
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

  test('#149: a grant with no uses left is refused with its own reason, before anything is built', () => {
    const spent = [
      { grant: 'enter-swap', permissionId: `0x${'01'.repeat(32)}` as const, validUntil: 10_000, active: true, usesLeft: 0 },
      { grant: 'enter-mint', permissionId: `0x${'02'.repeat(32)}` as const, validUntil: 10_000, active: true, usesLeft: 5 },
    ]
    const d = decide(obs({ sessions: spent, balances: { USDC: 10_000_000_000n } }), conservadorLabV1)
    expect(d.proposal).toBeNull()
    expect(d.reason).toBe('SESSION_USAGE_SPENT')
    // One use left is enough.
    const one = decide(obs({ sessions: spent.map((x) => ({ ...x, usesLeft: 1 })), balances: { USDC: 10_000_000_000n } }), conservadorLabV1)
    expect(one.proposal?.kind).toBe('enter_swap')
  })

  test('a busy slot holds', () => {
    const d = decide(obs({ slot: { opId: 'op-1', state: 'submitted' }, balances: { USDC: 10_000_000_000n } }), conservadorLabV1)
    expect(d.reason).toBe('DECIDE_SLOT_BUSY')
    expect(d.proposal).toBeNull()
  })

  test('a Base observation that names its registry decides byte for byte like one that does not', () => {
    const o = obs({ balances: { USDC: 10_000_000_000n, cbBTC: 0n }, deposits: [deposit(true)] })
    expect(canonicalJson(decide({ ...o, registry: baseRegistry }, conservadorLabV1))).toBe(canonicalJson(decide(o, conservadorLabV1)))
  })
})

// The registry travels with the observation. Monad pools are compared with monad.json and never with base.json.
const MONAD_POOL = 'pool:WMON/USDC/3000'
const MONAD_TICK = -260_000

function monadPool(registry: Registry = monadRegistry, over: Partial<PoolObs> = {}): PoolObs {
  const e = entry(MONAD_POOL, monadRegistry)
  return {
    name: MONAD_POOL,
    address: e.address,
    token0: e.token0!,
    token1: e.token1!,
    fee: e.fee!,
    tickSpacing: e.tickSpacing!,
    sqrtPriceX96: sqrtRatioAtTick(MONAD_TICK),
    tick: MONAD_TICK,
    liquidity: 10n ** 18n,
    twapTick: MONAD_TICK,
    identity: { factoryPool: e.address, token0: address(e.token0!, registry), token1: address(e.token1!, registry), fee: e.fee!, tickSpacing: e.tickSpacing! },
    ...over,
  }
}

/** A scenario policy over the Monad candidate pool. The real one arrives with the Monad session policies. */
const monadPolicy: PolicyVersion = {
  ...conservadorLabV1,
  allocation: 'target-weights',
  minEntry: 100_000n,
  buckets: conservadorLabV1.buckets.map((b) => (b.pools.length ? { ...b, pools: [MONAD_POOL] } : b)),
}

function monadObs(over: Partial<Observation> = {}): Observation {
  return obs({
    registry: monadRegistry,
    balances: { USDC: 10_000_000_000n, WMON: 0n },
    pools: [monadPool()],
    ethPrice: { pool: MONAD_POOL, sqrtPriceX96: sqrtRatioAtTick(MONAD_TICK), token0: 'WMON' },
    ...over,
  })
}

describe('the registry of the observation', () => {
  test('registryOf is the observation registry, and Base while the default exists', () => {
    expect(registryOf(monadObs())).toBe(monadRegistry)
    expect(registryOf(obs())).toBe(baseRegistry)
  })

  test('Purga accepts a Monad pool against monad.json', () => {
    expect(purgaIdentity(monadPool(), monadRegistry)).toEqual({ gate: 'purga', verdict: 'GO', reason: 'PURGA_OK' })
  })

  test('Purga refuses a Monad pool whose chain tokens are the Base ones', () => {
    const baseTokens = monadPool(monadRegistry, { identity: { ...monadPool().identity, token1: address('USDC', baseRegistry) } })
    expect(purgaIdentity(baseTokens, monadRegistry)).toEqual({ gate: 'purga', verdict: 'NO_GO', reason: 'PURGA_IDENTITY_MISMATCH' })
  })

  test('a Monad pool against the Base registry fails loudly, never with a Base lookup', () => {
    expect(() => purgaIdentity(monadPool(), baseRegistry)).toThrow('POLICY_TARGET_NOT_IN_REGISTRY')
    expect(() => purgaIdentity(monadPool())).toThrow('POLICY_TARGET_NOT_IN_REGISTRY')
    expect(() => allocate(monadObs({ registry: undefined }), monadPolicy, false)).toThrow('POLICY_TARGET_NOT_IN_REGISTRY')
  })

  test('allocate on a Monad observation gates the pool with monad.json and proposes the Monad entry', () => {
    const a = allocate(monadObs(), monadPolicy, false)
    expect(a.trail).toEqual([])
    expect(a.proposal).toMatchObject({ kind: 'enter_swap', pool: MONAD_POOL, tokenIn: 'USDC', tokenOut: 'WMON', fee: 3000 })
    expect(a.buckets.find((b) => b.pool === MONAD_POOL)?.code).toBe('STRATEGY_PREFERENCE_DEVIATION')
  })

  test('allocate on a Monad observation refuses a pool whose identity is not the registry one', () => {
    const bad = monadPool(monadRegistry, { identity: { ...monadPool().identity, fee: 500 } })
    const a = allocate(monadObs({ pools: [bad] }), monadPolicy, false)
    expect(a.proposal).toBeNull()
    expect(a.trail).toEqual([{ gate: 'purga', verdict: 'NO_GO', reason: 'PURGA_IDENTITY_MISMATCH' }])
    expect(a.buckets.find((b) => b.pool === MONAD_POOL)?.code).toBe('PURGA_IDENTITY_MISMATCH')
  })
})
