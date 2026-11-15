import { describe, expect, test } from 'bun:test'
import { conservadorLiveV6, DEFAULT_ENGINE_SETTINGS, grantKey, withEngineSettings, type EngineSettings } from '@mamoru/policy'
import { baseRegistry, address, entry } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { decide, type Observation, type PoolObs } from './index.ts'

// otto/mamoru#415: ops pause new money into a chain's volatile buckets until a set time (Monad's MON unlock, 24 Nov 2026).

const USDC = 1_000_000n
const NOW = 1_795_000_000n
const UNTIL = 1_795_600_000

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
    liquidity: 10n ** 18n,
    twapTick: tick,
    identity: { factoryPool: e.address, token0: address(e.token0!, baseRegistry), token1: address(e.token1!, baseRegistry), fee: e.fee!, tickSpacing: e.tickSpacing! },
  }
}

const POOLS = [pool('pool:USDC/USDT/100', 1), pool('pool:USDC/cbBTC/500', -69_080), pool('pool:WETH/USDC/3000', -193_380)]
const V6 = conservadorLiveV6
const BRIDGE = { kind: 'v3', perCall: 10n ** 15n, amountLeft: 10n ** 15n } as const

function obs(over: Partial<Observation> = {}): Observation {
  return {
    chainId: 8453,
    block: { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: NOW },
    safeBlock: { number: 98n, hash: `0x${'22'.repeat(32)}` },
    account: { address: '0x00000000000000000000000000000000000000aa', deployed: true, nonceKey: 0n, nonce: 0n },
    sessions: V6.session.grants.filter((g) => !g.perPosition).map((g, i) => ({ grant: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(2, '0').repeat(32)}` as const, validUntil: 4_000_000_000, active: true, ...(grantKey(g) === 'bridge-out' ? { bridgeLimit: BRIDGE } : {}) })),
    native: 10n ** 17n,
    balances: { USDC: 1_000n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n },
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

const at = (o: Observation, timestamp: bigint): Observation => ({ ...o, block: { ...o.block, timestamp } })
const settings = (entryPause: EngineSettings['entryPause']): EngineSettings => ({ ...DEFAULT_ENGINE_SETTINGS, entryPause })

describe('entry pause by chain (otto/mamoru#415)', () => {
  const ready = obs({ remote: { value: 0n, inFlight: 0n, ready: true } })

  test('Monad paused: Base bridges nothing to Growth, its share waits as savings with the pause code, Base buckets still enter', () => {
    expect(decide(ready, V6).proposal).toMatchObject({ kind: 'bridge_out', bucket: 'growth' })
    const paused = withEngineSettings(V6, settings([{ chainId: 143, until: UNTIL }]))
    const d = decide(ready, paused)
    expect(d.proposal?.kind).not.toBe('bridge_out')
    expect(d.proposal?.kind === 'enter_swap' || d.proposal?.kind === 'enter_mint').toBe(true)
    const w = (d.waiting ?? []).find((x) => x.bucket === 'growth')
    expect(w?.code).toBe('DECIDE_ENTRY_PAUSED_SCHEDULED')
    expect(w!.amount > 140n * USDC && w!.amount <= 150n * USDC).toBe(true)
  })

  test('the pause lifts by itself at its end: the same observation one second later bridges again', () => {
    const paused = withEngineSettings(V6, settings([{ chainId: 143, until: UNTIL }]))
    expect(decide(at(ready, BigInt(UNTIL) - 1n), paused).proposal?.kind).not.toBe('bridge_out')
    expect(decide(at(ready, BigInt(UNTIL)), paused).proposal).toMatchObject({ kind: 'bridge_out', bucket: 'growth' })
  })

  test('Base paused: the WETH/USDC bucket takes no entry and says why; stables still fill; the Monad bridge is untouched', () => {
    const paused = withEngineSettings(V6, settings([{ chainId: 8453, until: UNTIL }]))
    const d = decide(obs(), paused)
    expect(d.buckets.find((b) => b.bucket === 'risk')?.code).toBe('DECIDE_ENTRY_PAUSED_SCHEDULED')
    expect(d.buckets.find((b) => b.bucket === 'stables')?.code).not.toBe('DECIDE_ENTRY_PAUSED_SCHEDULED')
    expect(d.proposal?.pool).toBe('pool:USDC/USDT/100')
    expect(decide(ready, paused).proposal).toMatchObject({ kind: 'bridge_out', bucket: 'growth' })
  })

  test('positions keep running: an out-of-range WETH/USDC position gets the same proposal with the pause as without', () => {
    const paused = withEngineSettings(V6, settings([{ chainId: 8453, until: UNTIL }]))
    const out = { tokenId: 7n, pool: 'pool:WETH/USDC/3000', tickLower: -193_380 + 1_200, tickUpper: -193_380 + 2_400, liquidity: 10n ** 15n, collectable0: 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: true }
    const o = obs({ balances: { USDC: 0n, USDT: 0n, cbBTC: 0n, WETH: 0n }, positions: [out] })
    const base = decide(o, V6)
    expect(base.proposal).not.toBeNull()
    expect(decide(o, paused).proposal).toEqual(base.proposal)
  })

  test('a pause on another chain changes nothing', () => {
    const other = withEngineSettings(V6, settings([{ chainId: 10, until: UNTIL }]))
    expect(other.entryPauseUntil).toBeUndefined()
    expect(decide(ready, other).premiseHash).toBe(decide(ready, V6).premiseHash)
  })
})
