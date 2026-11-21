import { describe, expect, test } from 'bun:test'
import { conservadorLiveV6, DEFAULT_ENGINE_SETTINGS, grantKey, liveWmonUsdcMonadV6, sleeveEnginePolicy, withEngineSettings, type EngineSettings } from '@mamoru/policy'
import { address, entry, monadRegistry, type Registry } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { decide, type Observation, type PoolObs, type PositionObs } from './index.ts'

// otto/mamoru#427: ops leave Monad's pools ahead of the MON unlock of 24 Nov 2026: every position out, WMON sold, USDC stays.

const USDC = 1_000_000n
const NOW = 1_795_000_000n
const TICK = -260_000
const GRANT = 'manage-any:pool:WMON/USDC/3000'

function pool(name: string, tick: number, registry: Registry): PoolObs {
  const e = entry(name, registry)
  return { name, address: e.address, token0: e.token0!, token1: e.token1!, fee: e.fee!, tickSpacing: e.tickSpacing!, sqrtPriceX96: sqrtRatioAtTick(tick), tick, liquidity: 10n ** 18n, twapTick: tick, identity: { factoryPool: e.address, token0: address(e.token0!, registry), token1: address(e.token1!, registry), fee: e.fee!, tickSpacing: e.tickSpacing! } }
}

const MONAD = pool('pool:WMON/USDC/3000', TICK, monadRegistry)
// As the operator runs a Monad sleeve: SLEEVE_ENGINE on the signed policy, then the engine settings.
const M = sleeveEnginePolicy(liveWmonUsdcMonadV6)
const settings = (over: Partial<EngineSettings>): EngineSettings => ({ ...DEFAULT_ENGINE_SETTINGS, ...over })
const EXIT = withEngineSettings(M, settings({ chainExit: [{ chainId: 143 }] }))

const position = (over: Partial<PositionObs> = {}): PositionObs => ({ tokenId: 50_578n, pool: MONAD.name, tickLower: TICK - 1_500, tickUpper: TICK + 1_500, liquidity: 10n ** 15n, collectable0: 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: true, ...over })

function obs(over: Partial<Observation> = {}): Observation {
  return {
    chainId: 143,
    registry: monadRegistry,
    block: { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: NOW },
    safeBlock: { number: 98n, hash: `0x${'22'.repeat(32)}` },
    account: { address: '0x00000000000000000000000000000000000000aa', deployed: true, nonceKey: 0n, nonce: 0n },
    sessions: liveWmonUsdcMonadV6.session.grants.map((g, i) => ({ grant: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(2, '0').repeat(32)}` as const, validUntil: 2 ** 32 - 1, active: true })),
    native: 3n * 10n ** 18n,
    balances: { USDC: 0n, WMON: 0n },
    positions: [],
    pools: [MONAD],
    vaults: [],
    ethPrice: { pool: MONAD.name, sqrtPriceX96: MONAD.sqrtPriceX96, token0: 'WMON' },
    gas: { maxFeePerGas: 100_000_000_000n, opGasUnits: 1_000_000n },
    deposits: [],
    intents: { paused: false, exitRequested: false },
    slot: null,
    ...over,
  }
}

describe('chain exit (otto/mamoru#427)', () => {
  test('settings map: a Monad policy is marked as leaving and takes no entry; a Base policy is not leaving but bridges nothing to Monad', () => {
    expect(EXIT.chainExit).toBe(true)
    expect(EXIT.entryPauseUntil).toEqual({ risk: 4_102_444_800 })
    const base = withEngineSettings(conservadorLiveV6, settings({ chainExit: [{ chainId: 143 }] }))
    expect(base.chainExit).toBeUndefined()
    expect(base.entryPauseUntil).toEqual({ growth: 4_102_444_800 })
    expect(withEngineSettings(EXIT, DEFAULT_ENGINE_SETTINGS).chainExit).toBeUndefined()
  })

  test('a live position, in range, is taken out in full and burnt under the pool session, with the exit code', () => {
    const o = obs({ positions: [position()], balances: { USDC: 5n * USDC, WMON: 10n ** 20n } })
    const d = decide(o, EXIT)
    expect(d.proposal).toEqual({ kind: 'reduce', grant: GRANT, pool: MONAD.name, tokenId: 50_578n, liquidity: 10n ** 15n, burn: true })
    expect(d.reason).toBe('DECIDE_CHAIN_EXIT')
    expect(d.trail.filter((t) => t.gate === 'ehg')).toEqual([{ gate: 'ehg', verdict: 'GO', reason: 'EHG_OK' }])
  })

  test('an out-of-range position is taken out, not re-ranged', () => {
    const d = decide(obs({ positions: [position({ tickLower: TICK + 600, tickUpper: TICK + 3_600 })] }), EXIT)
    expect(d.proposal).toMatchObject({ kind: 'reduce', liquidity: 10n ** 15n, burn: true })
  })

  test('no position left: every WMON on the Safe, harvested included, is sold for USDC; nothing is bridged', () => {
    const wmon = 3n * 10n ** 21n
    const d = decide(obs({ balances: { USDC: 7n * USDC, WMON: wmon }, harvested: { WMON: { amount: 10n ** 18n, since: Number(NOW) - 60 } } }), EXIT)
    expect(d.proposal).toEqual({ kind: 'enter_swap', grant: GRANT, pool: MONAD.name, tokenIn: 'WMON', tokenOut: 'USDC', fee: 3000, amountIn: wmon })
    expect(d.reason).toBe('DECIDE_CHAIN_EXIT')
  })

  test('an empty NFT that still owes tokens worth the gas is collected and burnt; one owing nothing is left alone', () => {
    const owed = decide(obs({ positions: [position({ liquidity: 0n, collectable1: 20n * USDC })] }), EXIT)
    expect(owed.proposal).toMatchObject({ kind: 'reduce', liquidity: 0n, burn: true })
    const empty = decide(obs({ positions: [position({ liquidity: 0n })], balances: { USDC: 9n * USDC, WMON: 0n } }), EXIT)
    expect(empty.proposal).toBeNull()
    expect(empty.reason).toBe('DECIDE_CHAIN_EXIT_DONE')
  })

  test('done: only USDC (and dust WMON) left, the Safe holds; no entry even with USDC idle', () => {
    const d = decide(obs({ balances: { USDC: 150n * USDC, WMON: 1n } }), EXIT)
    expect(d.proposal).toBeNull()
    expect(d.reason).toBe('DECIDE_CHAIN_EXIT_DONE')
    // Without the exit the same Safe would enter the pool.
    expect(decide(obs({ balances: { USDC: 150n * USDC, WMON: 1n } }), M).proposal).not.toBeNull()
  })

  test('a pool the action policy would refuse every swap in keeps its WMON and says why', () => {
    const d = decide(obs({ balances: { USDC: 0n, WMON: 3n * 10n ** 21n }, depthShort: [{ pool: MONAD.name, depth: 0n, perWindow: 1n }] }), EXIT)
    expect(d.proposal).toBeNull()
    expect(d.reason).toBe('REMOTE_DEPTH_BELOW_BUDGET')
  })

  test('without the pool session the step is dropped by the gate, never sent another way', () => {
    const d = decide(obs({ sessions: [], positions: [position()] }), EXIT)
    expect(d.proposal).toBeNull()
  })

  test('the owner pause wins over the exit', () => {
    const d = decide(obs({ positions: [position()], intents: { paused: true, exitRequested: false } }), EXIT)
    expect(d.proposal).toBeNull()
    expect(d.reason).toBe('DECIDE_PAUSED')
  })
})
