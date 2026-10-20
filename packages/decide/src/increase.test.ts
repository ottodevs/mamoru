import { describe, expect, test } from 'bun:test'
import { conservadorLiveV2, conservadorLiveV4, conservadorLiveV5, grantKey, type PolicyVersion } from '@mamoru/policy'
import { address, entry } from '@mamoru/registry'
import { sqrtRatioAtTick, token1InToken0 } from '@mamoru/uniswap-v3/quote'
import { decide, rangeFor, reusablePosition, type Observation, type PoolObs, type PositionObs, type SessionObs } from './index.ts'

// otto/mamoru#171: an entry into a pool where the account holds a position of (nearly) the same range adds to it.
// Spec 007: only a policy whose manage-any carries MamoruActionPolicyV2.increase can (conservador-live-v5).
const LAB = conservadorLiveV5
const V2 = conservadorLiveV2
const V4 = conservadorLiveV4
const USDC = 1_000_000n
const RISK = 'pool:WETH/USDC/3000'

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

const POOLS = [pool('pool:USDC/USDT/100', 1), pool('pool:USDC/cbBTC/500', -69_080), pool(RISK, -193_380)]
const riskPool = POOLS[2]!

const live = (grant: string, tokenId?: bigint, over: Partial<SessionObs> = {}): SessionObs => ({ grant, permissionId: `0x${'0a'.repeat(32)}`, ...(tokenId ? { tokenId } : {}), validUntil: 10_000, active: true, ...over })
const pairSessions = (p: PolicyVersion) => p.session.grants.filter((g) => !g.perPosition).map((g) => live(grantKey(g)))

// The stables and btc buckets are full (collectable principal); the risk bucket holds a tiny position and is short.
const stable: PositionObs = { tokenId: 1n, pool: 'pool:USDC/USDT/100', tickLower: -19, tickUpper: 22, liquidity: 0n, collectable0: 10n * USDC, collectable1: 0n, principalOwed0: 10n * USDC, principalOwed1: 0n, managed: true }
const btc: PositionObs = { ...stable, tokenId: 2n, pool: 'pool:USDC/cbBTC/500', collectable0: 8n * USDC, principalOwed0: 8n * USDC }
const weth = token1InToken0(1n * USDC, riskPool.sqrtPriceX96)

function obs(positions: PositionObs[], sessions: SessionObs[]): Observation {
  return {
    chainId: 8453,
    block: { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: 1_000n },
    safeBlock: { number: 98n, hash: `0x${'22'.repeat(32)}` },
    account: { address: '0x00000000000000000000000000000000000000aa', deployed: true, nonceKey: 0n, nonce: 0n },
    sessions,
    native: 10n ** 17n,
    balances: { USDC: 1n * USDC, USDT: 0n, cbBTC: 0n, WETH: weth },
    positions: [stable, btc, ...positions],
    pools: POOLS,
    ethPrice: { pool: RISK, sqrtPriceX96: riskPool.sqrtPriceX96, token0: 'WETH' },
    gas: { maxFeePerGas: 2_000_000n, opGasUnits: 5_100_000n },
    deposits: [],
    intents: { paused: false, exitRequested: false },
    slot: null,
  }
}

const fresh = rangeFor(obs([], []), LAB, riskPool)
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

describe('increase instead of a second mint (otto/mamoru#171)', () => {
  test('conservador-live-v2 and -v4 (no increase action) still mint a second NFT into the same range', () => {
    const d = decide(obs([held(3n)], [...pairSessions(V2), live('increase:3', 3n)]), V2)
    expect(d.proposal).toMatchObject({ kind: 'enter_mint', grant: `enter-mint:${RISK}`, ...fresh })
    expect(decide(obs([held(3n)], pairSessions(V4)), V4).proposal).toMatchObject({ kind: 'enter_mint', grant: `enter-mint:${RISK}`, ...fresh })
  })

  test('the identical range (Revert c23e94e1, 6291301/6291328): increase on the held tokenId, same amounts the mint would take', () => {
    const minted = decide(obs([held(3n, 0, { managed: false })], pairSessions(LAB)), LAB).proposal
    const d = decide(obs([held(3n)], pairSessions(LAB)), LAB)
    expect(d.code).toBe('DECIDE_ENTER')
    expect(d.proposal).toMatchObject({ kind: 'increase_liquidity', grant: `manage-any:${RISK}`, pool: RISK, tokenId: 3n, ...fresh })
    expect(minted).toMatchObject({ grant: `enter-mint:${RISK}` })
    expect(minted?.kind).toBe('enter_mint')
    if (minted?.kind !== 'enter_mint' || d.proposal?.kind !== 'increase_liquidity') throw new Error('unreachable')
    expect([d.proposal.amount0Desired, d.proposal.amount1Desired]).toEqual([minted.amount0Desired, minted.amount1Desired])
    expect(d.trail.at(-1)).toEqual({ gate: 'ehg', verdict: 'GO', reason: 'EHG_OK' })
  })

  test('no live manage-any session for the pool (expired, revoked, spent, missing): no increase', () => {
    const others = pairSessions(LAB).filter((s) => s.grant !== `manage-any:${RISK}`)
    for (const s of [live(`manage-any:${RISK}`, undefined, { validUntil: 900 }), live(`manage-any:${RISK}`, undefined, { active: false }), live(`manage-any:${RISK}`, undefined, { usesLeft: 0 })]) {
      expect(reusablePosition(obs([held(3n)], [...others, s]), LAB, riskPool, fresh)).toBeNull()
    }
    expect(reusablePosition(obs([held(3n)], others), LAB, riskPool, fresh)).toBeNull()
  })

  test('#151 review P1-1: a managed position the policy did not admit (a v2/v3 or V1 NFT after a move) is not reused: mint', () => {
    for (const over of [{ admitted: false }, { admitted: undefined }]) {
      expect(reusablePosition(obs([held(3n, 0, over)], pairSessions(LAB)), LAB, riskPool, fresh)).toBeNull()
      expect(decide(obs([held(3n, 0, over)], pairSessions(LAB)), LAB).proposal).toMatchObject({ kind: 'enter_mint', grant: `enter-mint:${RISK}` })
    }
  })

  test('a position the engine does not manage (not minted by it, so not admitted by the policy) is not reused', () => {
    expect(reusablePosition(obs([held(3n, 0, { managed: false })], pairSessions(LAB)), LAB, riskPool, fresh)).toBeNull()
    expect(decide(obs([held(3n, 0, { managed: false })], pairSessions(LAB)), LAB).proposal?.kind).toBe('enter_mint')
  })

  test('tolerance: each edge within 10% of the width (198 of 1980 ticks at 60 spacing, as the Revert range) adds, past it mints', () => {
    expect(fresh.tickUpper - fresh.tickLower).toBe(1980)
    const sessions = pairSessions(LAB)
    expect(reusablePosition(obs([held(3n, 180)], sessions), LAB, riskPool, fresh)?.tokenId).toBe(3n)
    expect(decide(obs([held(3n, 60)], sessions), LAB).proposal).toMatchObject({ kind: 'increase_liquidity', tokenId: 3n, tickLower: fresh.tickLower + 60, tickUpper: fresh.tickUpper + 60 })
    // Off-centre by 180 the held range needs more WETH than is idle: the swap toward it comes first, not a mint.
    expect(decide(obs([held(3n, 180)], sessions), LAB).proposal).toMatchObject({ kind: 'enter_swap', tokenOut: 'WETH' })
    expect(reusablePosition(obs([held(3n, -240)], sessions), LAB, riskPool, fresh)).toBeNull()
    expect(decide(obs([held(3n, -240)], sessions), LAB).proposal).toMatchObject({ kind: 'enter_mint', ...fresh })
    // A wider position whose range only contains the new centre is not reused either.
    expect(decide(obs([held(3n, 0, { tickLower: fresh.tickLower - 600, tickUpper: fresh.tickUpper + 600 })], sessions), LAB).proposal?.kind).toBe('enter_mint')
  })

  test('the policy field sets the tolerance: 0 reuses only the exact range', () => {
    const exact: PolicyVersion = { ...LAB, range: { ...LAB.range, increaseToleranceBps: 0 } }
    const sessions = pairSessions(LAB)
    expect(decide(obs([held(3n, 60)], sessions), exact).proposal?.kind).toBe('enter_mint')
    expect(decide(obs([held(3n)], sessions), exact).proposal?.kind).toBe('increase_liquidity')
  })

  test('an empty position, or one the price is not strictly inside, is not reused', () => {
    const sessions = pairSessions(LAB)
    expect(decide(obs([held(3n, 0, { liquidity: 0n })], sessions), LAB).proposal?.kind).toBe('enter_mint')
    expect(reusablePosition(obs([], sessions), LAB, { ...riskPool, tick: fresh.tickUpper }, fresh)).toBeNull()
    expect(reusablePosition(obs([held(3n)], sessions), LAB, { ...riskPool, tick: fresh.tickLower }, fresh)).toBeNull()
  })

  test('two candidates: the nearer range wins, the lower tokenId on a tie', () => {
    const sessions = pairSessions(LAB)
    expect(reusablePosition(obs([held(5n, 120), held(7n, 60)], sessions), LAB, riskPool, fresh)?.tokenId).toBe(7n)
    expect(reusablePosition(obs([held(7n, 60), held(5n, -60)], sessions), LAB, riskPool, fresh)?.tokenId).toBe(5n)
    // A position of another pool is never a candidate.
    expect(reusablePosition(obs([held(3n, 0, { pool: 'pool:USDC/cbBTC/500' })], sessions), LAB, riskPool, fresh)).toBeNull()
  })
})
