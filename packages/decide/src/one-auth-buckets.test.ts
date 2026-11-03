// otto/mamoru#293 (security review of #293's push): a one-auth-v4 bucket whose registry pools are all inactive keeps its
// weight: the denominator is preferenceTotal on every side, so the other buckets never grow past their preference and the
// empty bucket's share waits as idle savings (no reduce/increase churn either).
import { describe, expect, test } from 'bun:test'
import { grantKey, oneAuthV4Live, staticPool, withRegistryPools } from '@mamoru/policy'
import { address, baseRegistry, entry } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { allocate, decide, type Observation, type PoolObs } from './index.ts'

const D = { policy: '0x00000000000000000000000000000000000000a2', gasPolicy: '0x00000000000000000000000000000000000000a3' } as const
const USDC = 1_000_000n
const entryOf = (name: string, ratioBps = 10_000) => ({ ...staticPool(name, baseRegistry), entry: { twapWindow: 600, twapShortWindow: 60, bandTicks: 100, anchorTick: 0, anchorBand: name.includes('USDT') ? 40 : 0, ratioBps, active: !name.includes('USDT') } })

function pool(name: string, tick: number): PoolObs {
  const e = entry(name, baseRegistry)
  return { name, address: e.address, token0: e.token0!, token1: e.token1!, fee: e.fee!, tickSpacing: e.tickSpacing!, sqrtPriceX96: sqrtRatioAtTick(tick), tick, liquidity: 10n ** 18n, twapTick: tick, identity: { factoryPool: e.address, token0: address(e.token0!, baseRegistry), token1: address(e.token1!, baseRegistry), fee: e.fee!, tickSpacing: e.tickSpacing! } }
}

describe('one-auth-v4 with no active stables pool', () => {
  const { policy } = withRegistryPools(oneAuthV4Live, D, [entryOf('pool:USDC/USDT/100'), entryOf('pool:WETH/USDC/3000')], baseRegistry)

  test('the stables bucket stays, empty; the risk bucket targets at most its 35 %, the rest waits idle', () => {
    expect(policy.buckets.map((b) => [b.id, b.pools])).toEqual([['stables', []], ['risk', ['pool:WETH/USDC/3000']]])
    const o: Observation = {
      chainId: 8453,
      block: { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: 1_000n },
      safeBlock: { number: 98n, hash: `0x${'22'.repeat(32)}` },
      account: { address: '0x00000000000000000000000000000000000000aa', deployed: true, nonceKey: 0n, nonce: 0n },
      sessions: policy.session.grants.map((g, i) => ({ grant: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(2, '0').repeat(32)}` as const, validUntil: 2 ** 32 - 1, active: true })),
      native: 10n ** 17n,
      balances: { USDC: 100n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n },
      positions: [],
      pools: [pool('pool:WETH/USDC/3000', -193_380)],
      ethPrice: { pool: 'pool:WETH/USDC/3000', sqrtPriceX96: sqrtRatioAtTick(-193_380), token0: 'WETH' },
      gas: { maxFeePerGas: 2_000_000n, opGasUnits: 5_100_000n },
      deposits: [],
      intents: { paused: false, exitRequested: false },
      slot: null,
    }
    const d = decide(o, policy)
    const a = allocate(o, policy, false)
    const risk = a.buckets.find((b) => b.bucket === 'risk')!
    const stables = a.buckets.find((b) => b.bucket === 'stables')!
    const total = 100n * USDC
    expect(risk.target).toBe((total * 3500n) / 10_000n)
    expect(stables.target).toBe(0n)
    // the entry the engine makes is at most the risk bucket's share; the stables share (and Growth's) stays USDC
    if (d.proposal?.kind === 'enter_swap') expect(d.proposal.amountIn <= (total * 3500n) / 10_000n).toBe(true)
  })
})

describe('flag off (not V4): the allocate denominator is unchanged (review of #202 r2)', () => {
  test('a v2 policy with one bucket unobservable: targets over the executable buckets and the remote ones, as on main', () => {
    const { conservadorLiveV2 } = require('@mamoru/policy') as typeof import('@mamoru/policy')
    const o = {
      chainId: 8453, block: { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: 1_000n }, safeBlock: { number: 98n, hash: `0x${'22'.repeat(32)}` },
      account: { address: '0x00000000000000000000000000000000000000aa', deployed: true, nonceKey: 0n, nonce: 0n },
      sessions: conservadorLiveV2.session.grants.filter((g) => !g.perPosition).map((g, i) => ({ grant: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(2, '0').repeat(32)}` as const, validUntil: 10_000, active: true })),
      native: 10n ** 17n, balances: { USDC: 100n * USDC, USDT: 0n, cbBTC: 0n, WETH: 0n }, positions: [],
      pools: [pool('pool:USDC/USDT/100', 1), pool('pool:WETH/USDC/3000', -193_380)], // the btc-usdc bucket's pool unobserved
      ethPrice: { pool: 'pool:WETH/USDC/3000', sqrtPriceX96: sqrtRatioAtTick(-193_380), token0: 'WETH' }, gas: { maxFeePerGas: 2_000_000n, opGasUnits: 5_100_000n },
      deposits: [], intents: { paused: false, exitRequested: false }, slot: null,
    } as Observation
    const a = allocate(o, conservadorLiveV2, false)
    const executable = conservadorLiveV2.buckets.filter((b) => o.pools.some((p) => p.name === b.pools[0])).reduce((s, b) => s + b.preference, 0)
    for (const b of a.buckets) {
      const pref = conservadorLiveV2.buckets.find((x) => x.id === b.bucket)!.preference
      expect(b.target).toBe(b.pool ? (100n * USDC * BigInt(pref)) / BigInt(executable) : 0n)
    }
  })
})

describe('the Monad V4 remote policy keeps a bucket (review of #202 r2, Opus 4)', () => {
  test('withRegistryPools(oneAuthV4RemoteMonad, WMON/USDC) serves WMON/USDC from its one bucket', () => {
    const { oneAuthV4RemoteMonad } = require('@mamoru/policy') as typeof import('@mamoru/policy')
    const { monadRegistry } = require('@mamoru/registry') as typeof import('@mamoru/registry')
    const wmon = { ...staticPool('pool:WMON/USDC/3000', monadRegistry), entry: { twapWindow: 600, twapShortWindow: 60, bandTicks: 100, anchorTick: 0, anchorBand: 0, ratioBps: 10_000, active: true } }
    const r = withRegistryPools(oneAuthV4RemoteMonad, D, [wmon], monadRegistry)
    expect(r.policy.buckets.length).toBeGreaterThanOrEqual(1)
    expect(r.policy.buckets.flatMap((b) => b.pools)).toEqual(['pool:WMON/USDC/3000'])
    expect(r.policy.buckets[0]!.preference).toBeGreaterThan(0)
  })

  test('#278: the remote policy carries the bridge-out session (its return home), a home without remote buckets does not', () => {
    const { oneAuthV4RemoteMonad } = require('@mamoru/policy') as typeof import('@mamoru/policy')
    const { monadRegistry } = require('@mamoru/registry') as typeof import('@mamoru/registry')
    const wmon = { ...staticPool('pool:WMON/USDC/3000', monadRegistry), entry: { twapWindow: 600, twapShortWindow: 60, bandTicks: 100, anchorTick: 0, anchorBand: 0, ratioBps: 10_000, active: true } }
    expect(withRegistryPools(oneAuthV4RemoteMonad, D, [wmon], monadRegistry).policy.session.grants.map((g) => g.name)).toContain('bridge-out')
    const solo = { ...oneAuthV4Live, remoteBuckets: [] }
    expect(withRegistryPools(solo, D, [entryOf('pool:USDC/USDT/100'), entryOf('pool:WETH/USDC/3000')], baseRegistry).policy.session.grants.map((g) => g.name)).not.toContain('bridge-out')
  })
})

describe('every bucket the policy declares is kept, pools resolved by chain and pair (review of #202 r3, Sol 1)', () => {
  const { oneAuthV4RemoteMonad } = require('@mamoru/policy') as typeof import('@mamoru/policy')
  const { monadRegistry } = require('@mamoru/registry') as typeof import('@mamoru/registry')
  const wmon = () => ({ ...staticPool('pool:WMON/USDC/3000', monadRegistry), entry: { twapWindow: 600, twapShortWindow: 60, bandTicks: 100, anchorTick: 0, anchorBand: 0, ratioBps: 10_000, active: true } })

  test('the real Monad remote policy, through the path v4Engine uses: its bucket serves WMON/USDC', () => {
    const r = withRegistryPools(oneAuthV4RemoteMonad, D, [wmon()], monadRegistry)
    expect(r.policy.buckets.map((b) => [b.id, b.pools])).toEqual(oneAuthV4RemoteMonad.buckets.map((b) => [b.id, ['pool:WMON/USDC/3000']]))
  })

  test('a bucket under any id (growth) keeps its pools: the filter never drops a declared bucket', () => {
    const growth = { ...oneAuthV4RemoteMonad, buckets: [{ id: 'growth' as never, preference: 10_000, pools: ['pool:WMON/USDC/3000'] }] }
    const r = withRegistryPools(growth, D, [wmon()], monadRegistry)
    expect(r.policy.buckets as unknown).toEqual([{ id: 'growth', preference: 10_000, pools: ['pool:WMON/USDC/3000'] }])
  })

  test('Base: every declared bucket is kept, each with the registry pools of its pairs (a new fee tier of a pair joins its bucket)', () => {
    const p = (name: string) => ({ ...staticPool(name, baseRegistry), entry: { twapWindow: 600, twapShortWindow: 60, bandTicks: 100, anchorTick: 0, anchorBand: name.includes('USDT') ? 40 : 0, ratioBps: 10_000, active: true } })
    const r = withRegistryPools(oneAuthV4Live, D, [p('pool:WETH/USDC/500'), p('pool:WETH/USDC/3000')], baseRegistry)
    expect(r.policy.buckets.map((b) => [b.id, b.pools])).toEqual([['stables', []], ['risk', ['pool:WETH/USDC/500', 'pool:WETH/USDC/3000']]])
  })
})

describe('otto/mamoru#348 (review of #247): a held pool V4 no longer finds eligible is exit-only', () => {
  const BTC = 'pool:USDC/cbBTC/500'
  const held = entryOf(BTC)
  const { policy, exitOnly } = withRegistryPools(oneAuthV4Live, D, [entryOf('pool:WETH/USDC/3000')], baseRegistry, { held: [held] })
  const tick = 60_000
  const obsWith = (liquidity: bigint, idleBtc: bigint): Observation => ({
    chainId: 8453,
    block: { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: 1_000_000n },
    safeBlock: { number: 98n, hash: `0x${'22'.repeat(32)}` },
    account: { address: '0x00000000000000000000000000000000000000aa', deployed: true, nonceKey: 0n, nonce: 0n },
    sessions: policy.session.grants.map((g, i) => ({ grant: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(2, '0').repeat(32)}` as const, validUntil: 2 ** 32 - 1, active: true })),
    native: 10n ** 17n,
    balances: { USDC: 1_000n * USDC, USDT: 0n, cbBTC: idleBtc, WETH: 0n },
    positions: liquidity > 0n ? [{ tokenId: 7n, pool: BTC, tickLower: tick - 600, tickUpper: tick + 600, liquidity, collectable0: 10n, collectable1: 10n, principalOwed0: 0n, principalOwed1: 0n, managed: true, admitted: true }] : [],
    pools: [pool('pool:WETH/USDC/3000', -193_380), pool(BTC, tick)],
    ethPrice: { pool: 'pool:WETH/USDC/3000', sqrtPriceX96: sqrtRatioAtTick(-193_380), token0: 'WETH' },
    gas: { maxFeePerGas: 2_000_000n, opGasUnits: 1_800_000n },
    deposits: [],
    intents: { paused: false, exitRequested: false },
    slot: null,
  })

  test('its bucket is at preference 0, its template has no increase, it is never entered', () => {
    expect(exitOnly).toEqual([BTC])
    expect(policy.buckets.find((b) => b.id === 'exit-only')).toEqual({ id: 'exit-only', preference: 0, exitOnly: true, pools: [BTC] })
    expect(policy.session.grants.find((g) => g.pool === BTC)!.actions).toEqual([])
    expect(policy.actionPolicy!.bandTicksByPool[BTC]).toBe(100) // its exit is priced like any other pool's
  })

  test('only exits: a large held position is reduced; idle cbBTC is not sold through it; nothing enters it', () => {
    for (const [liq, idle] of [[10n ** 15n, 0n], [10n ** 15n, 50_000n], [0n, 50_000n], [10n ** 9n, 0n]] as const) {
      const d = decide(obsWith(liq, idle), policy)
      const p = d.proposal
      if (p && 'pool' in p && p.pool === BTC) expect(['reduce', 'harvest']).toContain(p.kind)
      if (liq === 10n ** 15n && idle === 0n) expect(p?.kind).toBe('reduce')
    }
  })
})
