import { describe, expect, test } from 'bun:test'
import { conservadorLabV1, conservadorV1, grantKeyFor, liveWmonUsdcMonadV6, type PolicyVersion } from '@mamoru/policy'
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

// otto/mamoru#251, found by the two-chain e2e: the Monad v6 Safe has one session, the pool's manage-any under
// MamoruActionPolicyV3 alone, and no enter-swap/enter-mint grants. Its entries must ask for that session, not for a
// plain 'enter-swap' no session carries (the engine held SESSION_MISSING for ever with the bridged USDC on the Safe).
describe('the Monad v6 Safe enters under its one manage-any session', () => {
  const anyGrant = grantKeyFor(liveWmonUsdcMonadV6, 'manage-any', MONAD_POOL)
  const session = { grant: anyGrant, permissionId: `0x${'03'.repeat(32)}` as const, validUntil: 10_000, active: true }

  test('the entry swap names the manage-any key and passes the gate', () => {
    expect(grantKeyFor(liveWmonUsdcMonadV6, 'enter-swap', MONAD_POOL)).toBe(anyGrant)
    const d = decide(monadObs({ sessions: [session], native: 3n * 10n ** 18n, balances: { USDC: 1_880_874n, WMON: 0n } }), liveWmonUsdcMonadV6)
    expect(d.proposal).toMatchObject({ kind: 'enter_swap', grant: anyGrant, pool: MONAD_POOL })
    expect(d.reason).not.toBe('SESSION_MISSING')
  })

  test('without that session it still holds on SESSION_MISSING', () => {
    const d = decide(monadObs({ sessions: [], native: 3n * 10n ** 18n, balances: { USDC: 1_880_874n, WMON: 0n } }), liveWmonUsdcMonadV6)
    expect(d.proposal).toBeNull()
    expect(d.reason).toBe('SESSION_MISSING')
  })
})

// otto/mamoru#278: a remote Safe asked by its home account to send savings back frees them and bridges them home.
describe('release: the remote Safe sends savings home', () => {
  const anyGrant = grantKeyFor(liveWmonUsdcMonadV6, 'manage-any', MONAD_POOL)
  const sessions = [
    { grant: anyGrant, permissionId: `0x${'03'.repeat(32)}` as const, validUntil: 10_000, active: true },
    { grant: 'bridge-out', permissionId: `0x${'03'.repeat(32)}` as const, validUntil: 10_000, active: true },
  ]
  const live = (over: Partial<Observation>) => monadObs({ sessions, native: 3n * 10n ** 18n, ...over })
  const held = position({ pool: MONAD_POOL, tickLower: MONAD_TICK - 6_000, tickUpper: MONAD_TICK + 6_000, liquidity: 10n ** 15n })

  test('the savings are there: bridges exactly the amount home, and places nothing else', () => {
    const d = decide(live({ balances: { USDC: 10_000_000n, WMON: 0n }, release: { amount: 4_000_000n, chainId: 8453 } }), liveWmonUsdcMonadV6)
    expect(d.proposal).toEqual({ kind: 'bridge_out', grant: 'bridge-out', bucket: 'risk', chainId: 8453, pool: MONAD_POOL, amount: 4_000_000n })
    expect(d.reason).toBe('DECIDE_RELEASE')
  })

  test('without the release the same Safe enters the pool as before', () => {
    const d = decide(live({ balances: { USDC: 10_000_000n, WMON: 0n } }), liveWmonUsdcMonadV6)
    expect(d.proposal?.kind).toBe('enter_swap')
  })

  test('idle WMON and too little USDC: sells the WMON first', () => {
    const d = decide(live({ balances: { USDC: 1_000_000n, WMON: 10n ** 22n }, release: { amount: 4_000_000n, chainId: 8453 } }), liveWmonUsdcMonadV6)
    expect(d.proposal).toMatchObject({ kind: 'enter_swap', grant: anyGrant, pool: MONAD_POOL, tokenIn: 'WMON', tokenOut: 'USDC' })
    expect(d.reason).toBe('DECIDE_RELEASE')
  })

  test('review r1: a small shortfall sells only what is missing plus 1 %, not the whole WMON balance', () => {
    const lots = 10n ** 30n
    const d = decide(live({ balances: { USDC: 3_000_000n, WMON: lots }, release: { amount: 4_000_000n, chainId: 8453 } }), liveWmonUsdcMonadV6)
    expect(d.proposal).toMatchObject({ kind: 'enter_swap', tokenIn: 'WMON' })
    const sold = (d.proposal as { amountIn: bigint }).amountIn
    expect(sold > 0n && sold < lots / 1_000n).toBe(true)
  })

  test('missing less than one op is worth: sends what is there instead of a dust sale', () => {
    const d = decide(live({ balances: { USDC: 3_999_999n, WMON: 10n ** 30n }, release: { amount: 4_000_000n, chainId: 8453 } }), liveWmonUsdcMonadV6)
    expect(d.proposal).toMatchObject({ kind: 'bridge_out', chainId: 8453, amount: 3_999_999n })
  })

  test('the value sits in the position: reduces what is missing plus 1 %, never more than the position', () => {
    const d = decide(live({ balances: { USDC: 0n, WMON: 0n }, positions: [held], release: { amount: 1_000n, chainId: 8453 } }), liveWmonUsdcMonadV6)
    expect(d.proposal).toMatchObject({ kind: 'reduce', grant: anyGrant, pool: MONAD_POOL, tokenId: held.tokenId })
    const part = (d.proposal as { liquidity: bigint }).liquidity
    expect(part > 0n && part < held.liquidity).toBe(true)
    const all = decide(live({ balances: { USDC: 0n, WMON: 0n }, positions: [held], release: { amount: 10n ** 15n, chainId: 8453 } }), liveWmonUsdcMonadV6)
    expect(all.proposal).toMatchObject({ kind: 'reduce', liquidity: held.liquidity })
  })

  test('nothing more to free: bridges what there is; nothing at all: holds on DECIDE_RELEASE_EMPTY', () => {
    const some = decide(live({ balances: { USDC: 900_000n, WMON: 0n }, release: { amount: 4_000_000n, chainId: 8453 } }), liveWmonUsdcMonadV6)
    expect(some.proposal).toMatchObject({ kind: 'bridge_out', chainId: 8453, amount: 900_000n })
    const none = decide(live({ balances: { USDC: 0n, WMON: 0n }, release: { amount: 4_000_000n, chainId: 8453 } }), liveWmonUsdcMonadV6)
    expect(none.proposal).toBeNull()
    expect(none.reason).toBe('DECIDE_RELEASE_EMPTY')
  })

  test('no bridge session: holds on SESSION_MISSING instead of entering', () => {
    const d = decide(live({ sessions: [sessions[0]!], balances: { USDC: 10_000_000n, WMON: 0n }, release: { amount: 4_000_000n, chainId: 8453 } }), liveWmonUsdcMonadV6)
    expect(d.proposal).toBeNull()
    expect(d.reason).toBe('SESSION_MISSING')
  })

  test('review r2: a remainder below one op with nothing free holds on DECIDE_RELEASE_EMPTY, no dust sale', () => {
    const d = decide(live({ balances: { USDC: 0n, WMON: 10n ** 30n }, release: { amount: 1n, chainId: 8453 } }), liveWmonUsdcMonadV6)
    expect(d.proposal).toBeNull()
    expect(d.reason).toBe('DECIDE_RELEASE_EMPTY')
  })

  test('review r2: a frozen pool is neither sold into nor reduced; what is free goes home', async () => {
    const { releaseOf } = await import('./release/index.ts')
    const o = live({ balances: { USDC: 500_000n, WMON: 10n ** 22n }, positions: [held], release: { amount: 4_000_000n, chainId: 8453 } })
    const r = releaseOf(o, liveWmonUsdcMonadV6, new Set([MONAD_POOL]), new Set([MONAD_POOL]))
    expect(r?.proposal).toMatchObject({ kind: 'bridge_out', amount: 500_000n })
  })
})
