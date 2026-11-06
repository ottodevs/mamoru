// otto/mamoru#376: raising the cap is safe at 10,000 and 100,000 USDC. Deterministic: the engine's own `decide`, under
// the prod engine settings (depth 30/500/5, cap 1,000,000), against the real state of the three Base pools at one block
// (fixtures/base-pool-depth-53823027.json, read by apps/mamoru-operator/scripts/depth-fixture.ts), review after review
// until it proposes nothing more. Each proposal is executed the way the Lab executes it (world.ts `apply`). The pools
// do not move between reviews and the account's own mints are not added to their liquidity: both conservative.
import { describe, expect, test } from 'bun:test'
import { amountsOf, decide, depthOf, type Decision, type Observation, type PoolObs } from '@mamoru/decide'
import { conservadorLiveV2, grantKey, withEngineSettings, DEFAULT_ENGINE_SETTINGS, type EngineSettings, type PolicyVersion } from '@mamoru/policy'
import { address, baseRegistry, entry, type RegistryName } from '@mamoru/registry'
import { valueIn, apply, newWorld, swapOut, type World } from './world.ts'
import type { PoolSample } from './types.ts'
import fixture from './fixtures/base-pool-depth-53823027.json'

const USDC = 1_000_000n
const PROD: EngineSettings = { ...DEFAULT_ENGINE_SETTINGS, depth: { impactBps: 30, shareBps: 500, stablesImpactBps: 5 }, capUsdc: 1_000_000 }
const POLICY: PolicyVersion = withEngineSettings(conservadorLiveV2, PROD)
const NAMES = Object.keys(fixture.pools) as RegistryName[]
const VOLATILE: Record<string, RegistryName> = { 'pool:USDC/USDT/100': 'USDT', 'pool:USDC/cbBTC/500': 'cbBTC', 'pool:WETH/USDC/3000': 'WETH' }

function poolObs(name: RegistryName): PoolObs {
  const f = fixture.pools[name as keyof typeof fixture.pools]
  const e = entry(name, baseRegistry)
  return {
    name,
    address: e.address,
    token0: e.token0!,
    token1: e.token1!,
    fee: e.fee!,
    tickSpacing: e.tickSpacing!,
    sqrtPriceX96: BigInt(f.sqrtPriceX96),
    tick: f.tick,
    liquidity: BigInt(f.liquidity),
    twapTick: f.twapTick,
    twapLiquidity: BigInt(f.twapLiquidity),
    identity: { factoryPool: e.address, token0: address(e.token0!, baseRegistry), token1: address(e.token1!, baseRegistry), fee: e.fee!, tickSpacing: e.tickSpacing! },
  }
}
const POOLS = NAMES.map(poolObs)
const sample = (name: string): PoolSample => {
  const p = POOLS.find((x) => x.name === name)!
  return { sqrtPriceX96: p.sqrtPriceX96, tick: p.tick, liquidity: p.liquidity, feeGrowthGlobal0X128: 0n, feeGrowthGlobal1X128: 0n, tickCumulative: null }
}

function observe(w: World): Observation {
  return {
    chainId: 8453,
    block: { number: BigInt(fixture.block), hash: `0x${'11'.repeat(32)}`, timestamp: BigInt(fixture.timestamp) },
    safeBlock: { number: BigInt(fixture.block - 2), hash: `0x${'22'.repeat(32)}` },
    account: { address: '0x00000000000000000000000000000000000000aa', deployed: true, nonceKey: 0n, nonce: 0n },
    sessions: POLICY.session.grants.filter((g) => !g.perPosition).map((g, i) => ({ grant: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(2, '0').repeat(32)}` as const, validUntil: fixture.timestamp + 86_400 * 365, active: true })),
    native: 10n ** 17n,
    balances: { USDC: 0n, USDT: 0n, cbBTC: 0n, WETH: 0n, ...w.balances },
    positions: w.positions.map((p) => ({ tokenId: p.tokenId, pool: p.pool, tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: p.liquidity, collectable0: 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: true })),
    pools: POOLS,
    ethPrice: { pool: 'pool:WETH/USDC/3000', sqrtPriceX96: POOLS[2]!.sqrtPriceX96, token0: 'WETH' },
    gas: { maxFeePerGas: 10_000_000n, opGasUnits: 5_100_000n },
    deposits: [],
    intents: { paused: false, exitRequested: false },
    slot: null,
    peerPositions: [],
    // The prod cap, one chain: every USDC of the account is under it.
    cap: { capUsdc: BigInt(PROD.capUsdc!) * USDC, elsewhereUsdc: 0n },
    lastRerangeAt: w.lastRerangeAt,
  }
}

/** What a position of the world is worth in USDC at the fixture price. */
function positionValue(w: World, pool: string): bigint {
  const e = entry(pool, baseRegistry)
  const s = sample(pool)
  return w.positions.filter((p) => p.pool === pool).reduce((sum, p) => {
    const a = amountsOf(s.sqrtPriceX96, p.tickLower, p.tickUpper, p.liquidity)
    return sum + valueIn(e, s, e.token0!, a.amount0, 'USDC') + valueIn(e, s, e.token1!, a.amount1, 'USDC')
  }, 0n)
}

type Run = { world: World; last: Decision; reviews: number; ops: string[] }

/** Reviews until the engine proposes nothing (it waits) or 200 reviews pass. */
function run(deposit: bigint): Run {
  const w = newWorld('USDC', deposit)
  const ops: string[] = []
  for (let i = 0; i < 200; i++) {
    const d = decide(observe(w), POLICY)
    if (!d.proposal) return { world: w, last: d, reviews: i, ops }
    const r = apply(w, d.proposal, sample(d.proposal.pool), fixture.timestamp + i * 300, POLICY.execution.slippageBps)
    if (!r.ok) throw new Error(`review ${i}: ${d.proposal.kind} on ${d.proposal.pool} failed: ${r.detail}`)
    ops.push(`${d.proposal.kind}:${d.proposal.pool}`)
  }
  throw new Error('the engine was still proposing after 200 reviews')
}

/** The owner's Stop: every position closed at the fixture price, every volatile token sold back to USDC on its pool. */
function stop(w: World): bigint {
  for (const p of [...w.positions]) {
    const e = entry(p.pool, baseRegistry)
    const a = amountsOf(sample(p.pool).sqrtPriceX96, p.tickLower, p.tickUpper, p.liquidity)
    w.balances[e.token0!] = (w.balances[e.token0!] ?? 0n) + a.amount0
    w.balances[e.token1!] = (w.balances[e.token1!] ?? 0n) + a.amount1
  }
  w.positions = []
  for (const pool of NAMES) {
    const token = VOLATILE[pool]!
    const held = w.balances[token] ?? 0n
    if (held === 0n) continue
    w.balances.USDC = (w.balances.USDC ?? 0n) + swapOut(entry(pool, baseRegistry), sample(pool), token, held)
    w.balances[token] = 0n
  }
  return w.balances.USDC ?? 0n
}

const fresh = observe(newWorld('USDC', 0n))
const room = Object.fromEntries(POOLS.map((p) => [p.name, depthOf(fresh, POLICY, p, p.name === 'pool:USDC/USDT/100' ? 40 : POLICY.range.widthTicks)!]))
const usd = (v: bigint) => (Number(v) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 })

describe(`a large account under the prod depth settings, Base pools at block ${fixture.block} (otto/mamoru#376)`, () => {
  test('the prod settings are valid and turn depth sizing on for conservador-live-v2', () => {
    expect(POLICY.depth).toEqual({ maxImpactBps: 30, maxShareBps: 500, maxImpactBpsByPool: { 'pool:USDC/USDT/100': 5 } })
    for (const p of POOLS) expect(room[p.name]!.shareRoom > 0n).toBe(true)
  })

  for (const whole of [10_000n, 100_000n]) {
    const deposit = whole * USDC
    test(`${whole.toLocaleString('en-US')} USDC: placed up to each pool's depth, the rest waits typed, a Stop returns it`, () => {
      const r = run(deposit)
      const w = r.world
      const placed = Object.fromEntries(NAMES.map((n) => [n, positionValue(w, n)]))
      const waiting = r.last.waiting ?? []
      const idle = w.balances.USDC ?? 0n
      const lines = NAMES.map((n) => `${n} placed ${usd(placed[n]!)} (share room ${usd(room[n]!.shareRoom)}, swap room ${usd(room[n]!.swapRoom)})`)
      console.log(`[#376] ${usd(deposit)} USDC after ${r.reviews} reviews (${r.ops.length} ops): ${lines.join('; ')}; idle USDC ${usd(idle)}; waiting ${waiting.map((x) => `${x.bucket} ${x.code} ${usd(x.amount)}`).join(', ') || 'none'}`)

      // Placed: never above a pool's share room (5% of its active liquidity), something in every pool.
      for (const n of NAMES) {
        expect(placed[n]! > 0n).toBe(true)
        expect(placed[n]! <= room[n]!.shareRoom + USDC).toBe(true)
      }
      // The placement claim itself (SCN-CAP-02): 10k places almost all (idle under 1 %); 100k places the pools' room
      // (at least 77 % of the deposit) and the rest sits idle exactly as DECIDE_WAIT_DEPTH says.
      const placedSum = Object.values(placed).reduce((s, v) => s + v, 0n)
      if (whole === 10_000n) expect(idle * 100n <= deposit).toBe(true)
      else {
        expect(placedSum * 100n >= deposit * 77n).toBe(true)
        const waitedSum = waiting.reduce((s, x) => s + x.amount, 0n)
        expect(waitedSum > 0n && waitedSum <= idle).toBe(true)
      }
      // The engine stopped by itself: the last review proposes nothing. What it holds back is typed, never refused.
      expect(r.last.proposal).toBeNull()
      for (const x of waiting) expect(['DECIDE_WAIT_DEPTH', 'DECIDE_WAIT_GAS']).toContain(x.code)
      const total = Object.values(placed).reduce((s, v) => s + v, 0n) + idle
      // Nothing lost but swap fees and impact: within 0.5% of the deposit.
      expect(total * 10_000n >= deposit * 9_950n).toBe(true)
      // Each bucket is either at its target or waits for depth with what it misses.
      for (const b of POLICY.buckets) {
        const target = (deposit * BigInt(b.preference)) / 10_000n
        const pool = b.pools[0]!
        const short = target - placed[pool]!
        if (short * 100n > target) expect(waiting.find((x) => x.bucket === b.id)?.code).toBe('DECIDE_WAIT_DEPTH')
      }
      // A full Stop: every position closed, every volatile token sold back, within 10 bps of the deposit (6-7 today).
      // Simplified on purpose: one fixed liquidity per pool (no tick crossing, no QuoterV2) and every position closed at
      // once; execution against the live quoter is what the fork e2e (e2e-depth.ts) proves.
      const back = stop(w)
      console.log(`[#376] ${usd(deposit)} USDC Stop returns ${(Number(back) / 1e6).toFixed(2)} USDC (${((Number(deposit - back) * 10_000) / Number(deposit)).toFixed(1)} bps under the deposit)`)
      expect(w.positions.length).toBe(0)
      expect(back * 10_000n >= deposit * 9_990n).toBe(true)
    })
  }
})
