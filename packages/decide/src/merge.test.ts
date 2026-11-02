import { describe, expect, test } from 'bun:test'
import { conservadorLiveV2, conservadorLiveV4, conservadorLiveV5, grantKey, type PolicyVersion } from '@mamoru/policy'
import { address, entry, baseRegistry } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { decide, mergeOf, MERGES_PER_WEEK, rangeFor, reusablePosition, type Observation, type PoolObs, type PositionObs, type SessionObs } from './index.ts'

// otto/mamoru#220: one position per pool. c23e94e1 held two NFTs per pool from before #171 (WETH 6291301+6291328 on
// the same range, cbBTC 6291323+6351872 on two ranges).
const LIVE = conservadorLiveV5
const RISK = 'pool:WETH/USDC/3000'

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

const POOLS = [pool('pool:USDC/USDT/100', 1), pool('pool:USDC/cbBTC/500', -69_080), pool(RISK, -193_380)]
const riskPool = POOLS[2]!
const live = (grant: string): SessionObs => ({ grant, permissionId: `0x${'0a'.repeat(32)}`, validUntil: 10_000_000, active: true })
const sessions = (p: PolicyVersion) => p.session.grants.filter((g) => !g.perPosition).map((g) => live(grantKey(g)))

function obs(positions: PositionObs[], over: Partial<Observation> = {}): Observation {
  return {
    chainId: 8453,
    block: { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: 100_000n },
    safeBlock: { number: 98n, hash: `0x${'22'.repeat(32)}` },
    account: { address: '0x00000000000000000000000000000000000000aa', deployed: true, nonceKey: 0n, nonce: 0n },
    sessions: sessions(LIVE),
    native: 10n ** 17n,
    balances: { USDC: 5_000_000n, USDT: 0n, cbBTC: 0n, WETH: 0n },
    positions,
    pools: POOLS,
    ethPrice: { pool: RISK, sqrtPriceX96: riskPool.sqrtPriceX96, token0: 'WETH' },
    gas: { maxFeePerGas: 2_000_000n, opGasUnits: 5_100_000n },
    deposits: [],
    intents: { paused: false, exitRequested: false },
    slot: null,
    ...over,
  }
}

const fresh = rangeFor(obs([]), LIVE, riskPool)
const held = (tokenId: bigint, shift = 0, over: Partial<PositionObs> = {}): PositionObs => ({
  tokenId,
  pool: RISK,
  tickLower: fresh.tickLower + shift,
  tickUpper: fresh.tickUpper + shift,
  liquidity: 1_000_000n,
  collectable0: 0n,
  collectable1: 0n,
  principalOwed0: 0n,
  principalOwed1: 0n,
  managed: true,
  admitted: true,
  ...over,
})

describe('one position per pool (otto/mamoru#220)', () => {
  test('two positions in a pool: the one further from a new range is closed, as a merge', () => {
    const d = decide(obs([held(3n, 60), held(4n, 0)]), LIVE)
    expect(d.code).toBe('DECIDE_RANGE_ADJUST')
    expect(d.proposal).toMatchObject({ kind: 'rerange', grant: `manage-any:${RISK}`, pool: RISK, tokenId: 3n, liquidity: 1_000_000n, why: 'merge', tickLower: fresh.tickLower + 60 })
  })

  test('the same range on both (6291301/6291328): the newer tokenId goes', () => {
    expect(decide(obs([held(4n), held(3n)]), LIVE).proposal).toMatchObject({ kind: 'rerange', tokenId: 4n, why: 'merge' })
  })

  test('#217 review: only admitted positions merge; the policy refuses to close or add to any other', () => {
    for (const admitted of [false, undefined]) expect(mergeOf(obs([held(3n, 60), held(4n, 0, { admitted })]), LIVE, new Set([RISK]))).toBeNull()
    expect(mergeOf(obs([held(3n, 60), held(4n, 0), held(5n, 90, { admitted: false })]), LIVE, new Set([RISK]))).toMatchObject({ tokenId: 3n })
  })

  test('#220 b54dda3a: after the merge the entry adds to the admitted one left, even read unmanaged after a restart', () => {
    expect(reusablePosition(obs([held(3n, 0, { managed: false })]), LIVE, riskPool, fresh)?.tokenId).toBe(3n)
  })

  test('one live position: nothing to merge; an empty one does not count', () => {
    expect(mergeOf(obs([held(3n)]), LIVE, new Set([RISK]))).toBeNull()
    expect(mergeOf(obs([held(3n), held(4n, 60, { liquidity: 0n })]), LIVE, new Set([RISK]))).toBeNull()
    expect(decide(obs([held(3n)]), LIVE).proposal?.kind).not.toBe('rerange')
  })

  test('a policy that cannot add to a held position (v2, v4) keeps both: every top-up there is a new NFT', () => {
    for (const p of [conservadorLiveV2, conservadorLiveV4]) expect(mergeOf(obs([held(3n, 60), held(4n)], { sessions: sessions(p) }), p, new Set([RISK]))).toBeNull()
  })

  test('review r1: no live manage-any session, no merge (it would only starve reduce)', () => {
    const pools = new Set([RISK])
    const dead = sessions(LIVE).map((s) => (s.grant === `manage-any:${RISK}` ? { ...s, active: false } : s))
    expect(mergeOf(obs([held(3n, 60), held(4n)], { sessions: dead }), LIVE, pools)).toBeNull()
    const expired = sessions(LIVE).map((s) => (s.grant === `manage-any:${RISK}` ? { ...s, validUntil: 1 } : s))
    expect(mergeOf(obs([held(3n, 60), held(4n)], { sessions: expired }), LIVE, pools)).toBeNull()
  })

  test('review r1: a position out of range is the re-range rule\'s, with its wait; no merge closes it early', () => {
    const out = held(3n, 4_000)
    expect(mergeOf(obs([out, held(4n)]), LIVE, new Set([RISK]))).toBeNull()
  })

  test('review r1: at most MERGES_PER_WEEK merges a pool in 7 days', () => {
    const pools = new Set([RISK])
    const two = Array.from({ length: MERGES_PER_WEEK }, (_, i) => ({ pool: RISK, at: 10_000n + BigInt(i), merge: true as const }))
    expect(mergeOf(obs([held(3n, 60), held(4n)], { recentReranges: two }), LIVE, pools)).toBeNull()
    expect(mergeOf(obs([held(3n, 60), held(4n)], { recentReranges: two.slice(1) }), LIVE, pools)).toMatchObject({ tokenId: 3n })
    // Re-ranges do not use up merges.
    expect(mergeOf(obs([held(3n, 60), held(4n)], { recentReranges: [{ pool: RISK, at: 10_000n }, { pool: RISK, at: 10_001n }] }), LIVE, pools)).toMatchObject({ tokenId: 3n })
  })

  test('the re-range cooldown holds a merge', () => {
    const pools = new Set([RISK])
    const at = 100_000n - BigInt(LIVE.range.cooldownSeconds) + 1n
    expect(mergeOf(obs([held(3n, 60), held(4n)], { lastRerangeAt: at }), LIVE, pools)).toBeNull()
    expect(mergeOf(obs([held(3n, 60), held(4n)], { lastRerangeAt: at - 1n }), LIVE, pools)).toMatchObject({ tokenId: 3n })
  })

  test('a skipped pool (depegged) is left alone', () => {
    expect(mergeOf(obs([held(3n, 60), held(4n)]), LIVE, new Set([RISK]), new Set([RISK]))).toBeNull()
  })

  test('a merge does not count toward the weekly cap; a re-range does', () => {
    const capped: PolicyVersion = { ...LIVE, range: { ...LIVE.range, maxPerWeek: 1 } }
    const out = held(3n, 4_000)
    const merged = decide(obs([out], { recentReranges: [{ pool: RISK, at: 50_000n, merge: true }] }), capped)
    expect(merged.proposal).toMatchObject({ kind: 'rerange', tokenId: 3n, why: 'out' })
    const moved = decide(obs([out], { recentReranges: [{ pool: RISK, at: 50_000n }] }), capped)
    expect(moved.proposal?.kind).not.toBe('rerange')
    expect(moved.positions.find((p) => p.tokenId === 3n)?.codes).toContain('DECIDE_RANGE_WEEKLY_CAP')
  })
})
