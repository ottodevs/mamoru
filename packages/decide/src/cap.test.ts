import { describe, expect, test } from 'bun:test'
import { conservadorLiveV2, conservadorLiveV7, grantKey } from '@mamoru/policy'
import { address, baseRegistry, entry } from '@mamoru/registry'
import { quoteMint, sqrtRatioAtTick, token0InToken1, token1InToken0 } from '@mamoru/uniswap-v3/quote'
import { bucketValues, capRoomOf, decide, placedOf, withinCap, type Observation, type PoolObs, type PositionObs, type VaultObs } from './index.ts'

// otto/mamoru#212: the engine places new savings only within the account's cap, counted across chains.
const V2 = conservadorLiveV2
const USDC = 1_000_000n

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
    liquidity: 10n ** 24n,
    twapTick: tick,
    twapLiquidity: 10n ** 24n,
    identity: { factoryPool: e.address, token0: address(e.token0!, baseRegistry), token1: address(e.token1!, baseRegistry), fee: e.fee!, tickSpacing: e.tickSpacing! },
  }
}

const POOLS = [pool('pool:USDC/USDT/100', 1), pool('pool:USDC/cbBTC/500', -69_080), pool('pool:WETH/USDC/3000', -193_380)]

function obs(over: Partial<Observation> = {}): Observation {
  return {
    chainId: 8453,
    block: { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: 1_000n },
    safeBlock: { number: 98n, hash: `0x${'22'.repeat(32)}` },
    account: { address: '0x00000000000000000000000000000000000000aa', deployed: true, nonceKey: 0n, nonce: 0n },
    sessions: V2.session.grants.filter((g) => !g.perPosition).map((g, i) => ({ grant: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(2, '0').repeat(32)}` as const, validUntil: 10_000, active: true })),
    native: 10n ** 17n,
    balances: { USDC: 0n, USDT: 0n, cbBTC: 0n, WETH: 0n },
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

/** Applies the decision's entry the way the chain would (no fees). Null when it holds or proposes anything else. */
function apply(o: Observation, nextId: bigint): Observation | null {
  const p = decide(o, V2).proposal
  if (!p || (p.kind !== 'enter_swap' && p.kind !== 'enter_mint')) return null
  const balances = { ...o.balances }
  const pl = o.pools.find((x) => x.name === p.pool)!
  if (p.kind === 'enter_swap') {
    const out = pl.token0 === p.tokenIn ? token0InToken1(p.amountIn, pl.sqrtPriceX96) : token1InToken0(p.amountIn, pl.sqrtPriceX96)
    balances[p.tokenIn] = balances[p.tokenIn]! - p.amountIn
    balances[p.tokenOut] = (balances[p.tokenOut] ?? 0n) + out
    return { ...o, balances }
  }
  const q = quoteMint({ sqrtPriceX96: pl.sqrtPriceX96, tickLower: p.tickLower, tickUpper: p.tickUpper, amount0Desired: p.amount0Desired, amount1Desired: p.amount1Desired, slippageBps: 50 })
  balances[pl.token0] = balances[pl.token0]! - q.amount0
  balances[pl.token1] = balances[pl.token1]! - q.amount1
  const pos: PositionObs = { tokenId: nextId, pool: pl.name, tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: q.liquidity, collectable0: 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: true }
  return { ...o, balances, positions: [...o.positions, pos] }
}

/** Every entry the engine would make, one review after the other, until it holds. */
function settle(o: Observation): Observation {
  let cur = o
  for (let i = 1n; i < 60n; i++) {
    const next = apply(cur, i)
    if (!next) return cur
    cur = next
  }
  throw new Error('did not settle')
}

describe('otto/mamoru#212: placing within the cap', () => {
  test('without a cap the observation and the decision are unchanged', () => {
    const o = obs({ balances: { USDC: 5_000n * USDC } })
    expect(withinCap(o, V2)).toBe(o)
    expect(capRoomOf(o, V2)).toBeNull()
  })

  test('placedOf counts positions and idle tokens other than the savings asset, never idle USDC', () => {
    const o = obs({ balances: { USDC: 300n * USDC, USDT: 50n * USDC } })
    // USDT at ~1.0: about 50 USDC placed (bought for an entry), the 300 idle USDC not.
    const placed = placedOf(o, V2)
    expect(placed > 49n * USDC && placed < 51n * USDC).toBe(true)
    const settled = settle(obs({ balances: { USDC: 400n * USDC } }))
    const p = placedOf(settled, V2)
    // What went into positions (and is left of the volatile side) is placed; what is idle USDC is not.
    expect(p + settled.balances.USDC! > 399n * USDC && p + settled.balances.USDC! <= 400n * USDC).toBe(true)
    expect(settled.positions.length).toBeGreaterThan(0)
  })

  test('over the cap, an entry is sized as if the account held only its room', () => {
    const capped = obs({ balances: { USDC: 5_000n * USDC }, cap: { capUsdc: 1_000n * USDC, elsewhereUsdc: 0n } })
    const plain = obs({ balances: { USDC: 1_000n * USDC } })
    expect(decide(capped, V2).proposal).toEqual(decide(plain, V2).proposal)
  })

  test('the engine places up to the cap and leaves the rest idle', () => {
    const end = settle(obs({ balances: { USDC: 5_000n * USDC }, cap: { capUsdc: 1_000n * USDC, elsewhereUsdc: 0n } }))
    const placed = placedOf(end, V2)
    expect(placed <= 1_000n * USDC).toBe(true)
    expect(placed > 950n * USDC).toBe(true)
    expect(end.balances.USDC! >= 4_000n * USDC).toBe(true)
  })

  test('what the other chains placed comes off the room', () => {
    const end = settle(obs({ balances: { USDC: 1_000n * USDC }, cap: { capUsdc: 1_000n * USDC, elsewhereUsdc: 900n * USDC } }))
    expect(placedOf(end, V2) <= 100n * USDC).toBe(true)
    expect(end.balances.USDC! >= 900n * USDC).toBe(true)
  })

  test('a chain cap bounds what this chain places, on top of the account cap (otto/mamoru#382)', () => {
    // The account cap leaves 9,000; this Safe's own cap of 500 is what binds.
    const o = obs({ balances: { USDC: 1_000n * USDC }, cap: { capUsdc: 10_000n * USDC, elsewhereUsdc: 1_000n * USDC, chainCapUsdc: 500n * USDC } })
    expect(capRoomOf(o, V2)).toBe(500n * USDC)
    expect(placedOf(settle(o), V2) <= 500n * USDC).toBe(true)
    // The account cap binds when it is the smaller room.
    expect(capRoomOf({ ...o, cap: { capUsdc: 1_200n * USDC, elsewhereUsdc: 1_000n * USDC, chainCapUsdc: 500n * USDC } }, V2)).toBe(200n * USDC)
    // A chain read failing still places nothing new.
    expect(capRoomOf({ ...o, cap: { capUsdc: 10_000n * USDC, elsewhereUsdc: null, chainCapUsdc: 500n * USDC } }, V2)).toBe(0n)
    // What a re-range freed goes back in above the account cap, but never above this Safe's own cap.
    expect(capRoomOf({ ...o, cap: { capUsdc: 1_000n * USDC, elsewhereUsdc: 1_000n * USDC, chainCapUsdc: 500n * USDC, reinvestUsdc: 800n * USDC } }, V2)).toBe(500n * USDC)
    expect(capRoomOf({ ...o, cap: { capUsdc: 1_000n * USDC, elsewhereUsdc: 1_000n * USDC, chainCapUsdc: 500n * USDC, reinvestUsdc: 300n * USDC } }, V2)).toBe(300n * USDC)
  })

  test('another chain that could not be read: nothing new is placed (fail closed)', () => {
    const o = obs({ balances: { USDC: 500n * USDC }, cap: { capUsdc: 1_000n * USDC, elsewhereUsdc: null } })
    expect(capRoomOf(o, V2)).toBe(0n)
    const d = decide(o, V2)
    expect(d.proposal).toBeNull()
    expect(d.kind).toBe('hold')
  })

  test('placed above the cap (the market rose): nothing new goes in, nothing is sold, an out-of-range position is still re-ranged', () => {
    const placed = settle(obs({ balances: { USDC: 2_000n * USDC } }))
    const over = { ...placed, balances: { ...placed.balances, USDC: placed.balances.USDC! + 3_000n * USDC }, cap: { capUsdc: 1_000n * USDC, elsewhereUsdc: 0n } }
    expect(capRoomOf(over, V2)).toBe(0n)
    const d = decide(over, V2)
    // No entry and no sale of what is placed: the decision holds.
    expect(d.proposal).toBeNull()
    // The cbBTC price leaves the range of the position there: the re-range of money already placed is unaffected.
    const btc = over.positions.find((p) => p.pool === 'pool:USDC/cbBTC/500')!
    const moved = { ...over, pools: over.pools.map((p) => (p.name === btc.pool ? { ...p, tick: btc.tickUpper + 500, twapTick: btc.tickUpper + 500, sqrtPriceX96: sqrtRatioAtTick(btc.tickUpper + 500) } : p)) }
    expect(decide(moved, V2).proposal).toMatchObject({ kind: 'rerange', pool: 'pool:USDC/cbBTC/500', tokenId: btc.tokenId })
  })

  test('what the engine took out of its own positions goes back in, above the cap or with a chain unread', () => {
    // A chain unread: nothing new, but the 300 a re-range freed is placed again.
    const unread = obs({ balances: { USDC: 300n * USDC }, cap: { capUsdc: 1_000n * USDC, elsewhereUsdc: null, reinvestUsdc: 300n * USDC } })
    expect(capRoomOf(unread, V2)).toBe(300n * USDC)
    expect(decide(unread, V2).proposal).toEqual(decide(obs({ balances: { USDC: 300n * USDC } }), V2).proposal)
    // A position that gained past the cap, closed by a re-range: all of it goes back, not only what fits under the cap.
    const gained = obs({ balances: { USDC: 1_500n * USDC }, cap: { capUsdc: 1_000n * USDC, elsewhereUsdc: 0n, reinvestUsdc: 1_500n * USDC } })
    expect(capRoomOf(gained, V2)).toBe(1_500n * USDC)
    // Without it, the cap holds.
    expect(capRoomOf({ ...gained, cap: { capUsdc: 1_000n * USDC, elsewhereUsdc: 0n } }, V2)).toBe(1_000n * USDC)
  })

  test('merge gate round 1: the cap sizes entries of new money only; reduce, harvest and re-range read every idle dollar', () => {
    const placed = settle(obs({ balances: { USDC: 2_000n * USDC } }))
    const btc = placed.positions.find((p) => p.pool === 'pool:USDC/cbBTC/500')!
    // The cbBTC bucket far over its weight: a reduce, the same with the account over its cap or a chain unread.
    const heavy = { ...placed, positions: placed.positions.map((p) => (p.tokenId === btc.tokenId ? { ...p, liquidity: p.liquidity * 4n } : p)) }
    const plain = decide(heavy, V2)
    expect(plain.proposal?.kind).toBe('reduce')
    expect(decide({ ...heavy, cap: { capUsdc: 100n * USDC, elsewhereUsdc: null } }, V2).proposal).toEqual(plain.proposal)
    // Fees above their cost: the harvest is the same under the cap.
    const fees = { ...placed, positions: placed.positions.map((p) => (p.tokenId === btc.tokenId ? { ...p, collectable0: 50n * USDC, collectable1: 50_000n } : p)) }
    const h = decide(fees, V2)
    expect(h.proposal?.kind).toBe('harvest')
    expect(decide({ ...fees, cap: { capUsdc: 100n * USDC, elsewhereUsdc: 0n } }, V2).proposal).toEqual(h.proposal)
  })

  test('otto/mamoru#353: the cap never makes the engine sell idle volatile: the sale is decided on every savings held', () => {
    // 1,000 USDC and ~300 USDC of WETH idle, the cap's room 10 USDC. Sized as if the account held only its room (the
    // rule before #353), WETH looked far above the mint it could pair and was sold back to USDC.
    const weth = 75n * 10n ** 15n
    const asIfRoom = obs({ balances: { USDC: 10n * USDC, USDT: 0n, cbBTC: 0n, WETH: weth } })
    expect(decide(asIfRoom, V2).proposal).toMatchObject({ kind: 'enter_swap', tokenIn: 'WETH', tokenOut: 'USDC' })
    const held = obs({ balances: { USDC: 1_000n * USDC, USDT: 0n, cbBTC: 0n, WETH: weth } })
    const room = 10n * USDC
    const capped = { ...held, cap: { capUsdc: placedOf(held, V2) + room, elsewhereUsdc: 0n } }
    expect(capRoomOf(capped, V2)).toBe(room)
    const d = decide(capped, V2)
    expect(d.proposal && d.proposal.kind === 'enter_swap' && d.proposal.tokenIn === 'WETH').toBe(false)
    // An entry, if any, spends no more new savings than the room.
    const p = d.proposal
    const spent = !p ? 0n : p.kind === 'enter_swap' && p.tokenIn === 'USDC' ? p.amountIn : p.kind === 'enter_mint' ? (p.pool === 'pool:WETH/USDC/3000' ? p.amount1Desired : p.amount0Desired) : 0n
    expect(spent <= room).toBe(true)
    // At the limit (no room): nothing spends savings and nothing is sold.
    const full = decide({ ...held, cap: { capUsdc: placedOf(held, V2), elsewhereUsdc: 0n } }, V2)
    expect(full.proposal).toBeNull()
  })

  test('otto/mamoru#353: fixed weights: the convert reads every savings held but only sells; what buys is sized on the room', () => {
    // ratioConvertOf (rerange/index.ts) returns a swap of the pool's volatile token into savings or nothing: it never spends
    // savings. The entries (enterBucket) size from withinCap: 1,000 held, room 10, a little WETH idle.
    const FIRST = { ...V2, allocation: 'first-entry' as const }
    const held = obs({ balances: { USDC: 1_000n * USDC, USDT: 0n, cbBTC: 0n, WETH: 10n ** 15n } })
    const room = 10n * USDC
    const o = { ...held, cap: { capUsdc: placedOf(held, FIRST) + room, elsewhereUsdc: 0n } }
    expect(capRoomOf(o, FIRST)).toBe(room)
    const p = decide(o, FIRST).proposal
    expect(p).not.toBeNull()
    if (p!.kind === 'enter_swap' && p!.tokenIn === 'USDC') expect(p!.amountIn <= room).toBe(true)
    if (p!.kind === 'enter_mint') expect((p!.pool.startsWith('pool:USDC/') ? p!.amount0Desired : p!.amount1Desired) <= room).toBe(true)
    // Without the cap the same account buys far more: the room is what limits it.
    const free = decide(held, FIRST).proposal
    expect(free?.kind === 'enter_swap' && free.tokenIn === 'USDC' && free.amountIn > room).toBe(true)
  })
})

describe('otto/mamoru#352: USDC lent in vaults is placed money under the cap', () => {
  const vault = (name: string, assets: bigint): VaultObs => ({ name, shares: assets, assets, maxWithdraw: assets, maxDeposit: 10n ** 15n, maxRedeem: assets })

  test('a vault of the policy: an LP, idle USDC and vault shares, the room is the cap less positions and vault', () => {
    const settled = settle(obs({ balances: { USDC: 300n * USDC } }))
    const lp = placedOf(settled, V2)
    expect(lp > 0n).toBe(true)
    const o = { ...settled, balances: { ...settled.balances, USDC: settled.balances.USDC! + 500n * USDC }, vaults: [vault('vault:gtUSDCp', 600n * USDC)], cap: { capUsdc: 1_000n * USDC, elsewhereUsdc: 0n } }
    const placed = placedOf(o, conservadorLiveV7)
    expect(placed >= lp + 600n * USDC).toBe(true)
    const room = capRoomOf(o, conservadorLiveV7)!
    expect(room).toBe(1_000n * USDC - placed)
    // Without the vault the engine would have had 600 more to place: now what it may place stays within the cap.
    expect(room < 1_000n * USDC - lp - 500n * USDC).toBe(true)
    expect(withinCap(o, conservadorLiveV7).balances.USDC).toBe(room)
  })

  test('a vault the policy no longer names (heldVaults) counts too, and gets no op', () => {
    const o = obs({ balances: { USDC: 900n * USDC }, vaults: [vault('vault:gtUSDCp', 600n * USDC)], cap: { capUsdc: 1_000n * USDC, elsewhereUsdc: 0n } })
    expect(placedOf(o, V2)).toBe(600n * USDC)
    expect(capRoomOf(o, V2)).toBe(400n * USDC)
    // Sized as if 400 USDC were held: the entry the engine proposes is the one for 400.
    expect(decide(o, V2).proposal).toEqual(decide(obs({ balances: { USDC: 400n * USDC } }), V2).proposal)
    // Over the cap only because of the vault: nothing new goes in.
    const full = { ...o, vaults: [vault('vault:gtUSDCp', 1_000n * USDC)] }
    expect(capRoomOf(full, V2)).toBe(0n)
    expect(decide(full, V2).proposal).toBeNull()
  })
})

describe('otto/mamoru#352: v7 with a vault it does not name, and a vault that could not be read', () => {
  const V7 = conservadorLiveV7
  const vault = (name: string, assets: bigint): VaultObs => ({ name, shares: assets, assets, maxWithdraw: assets, maxDeposit: 10n ** 15n, maxRedeem: assets })
  const pools = new Set(V7.buckets.flatMap((b) => b.pools))
  const sessions = [...V7.session.grants.filter((g) => !g.perPosition).map((g, i) => ({ grant: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(2, '0').repeat(32)}` as const, validUntil: 10_000, active: true }))]

  test('the unnamed vault is counted once, under the cap only, and never acted on', () => {
    // The Stable bucket's vault far over its weight; 5000 more in a vault v7 does not name.
    const o = obs({ sessions, balances: { USDC: 0n }, vaults: [vault('vault:gtUSDCp', 1_000n * USDC), vault('vault:other', 5_000n * USDC)] })
    // bucketValues (rebalancing) sees only the policy's vault; placedOf adds the other one once.
    expect(bucketValues(o, V7, pools).total).toBe(1_000n * USDC)
    expect(placedOf(o, V7)).toBe(6_000n * USDC)
    const d = decide(o, V7)
    // The rebalance redeems from the policy's vault, by the weights without the other one.
    expect(d.proposal).toMatchObject({ kind: 'vault_redeem', vault: 'vault:gtUSDCp' })
    expect(JSON.stringify(d, (_, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('vault:other')
    // Idle USDC under a cap the unnamed vault already fills: nothing new goes in.
    const capped = obs({ sessions, balances: { USDC: 500n * USDC }, vaults: [vault('vault:other', 1_000n * USDC)], cap: { capUsdc: 1_000n * USDC, elsewhereUsdc: 0n } })
    expect(capRoomOf(capped, V7)).toBe(0n)
    expect(decide(capped, V7).proposal).toBeNull()
  })

  test('an unread vault: no new room; a reduce held only when the policy names it', () => {
    const over = obs({ sessions, balances: { USDC: 0n }, vaults: [vault('vault:gtUSDCp', 1_000n * USDC)] })
    expect(decide(over, V7).proposal?.kind).toBe('vault_redeem')
    // An unread vault v7 does not name is outside the bucket weights: the redeem from gtUSDCp goes on.
    expect(decide({ ...over, vaultsUnread: ['vault:other'] }, V7).proposal).toMatchObject({ kind: 'vault_redeem', vault: 'vault:gtUSDCp' })
    // An unread vault v7 names (waBasUSDC, the Stable bucket's second): the weights are unknown, nothing is reduced.
    expect(decide({ ...over, vaultsUnread: ['vault:waBasUSDC'] }, V7).proposal).toBeNull()
    const idle = obs({ sessions, balances: { USDC: 500n * USDC }, cap: { capUsdc: 1_000n * USDC, elsewhereUsdc: 0n } })
    expect(decide(idle, V7).proposal).not.toBeNull()
    // Any unread vault, named or not, is unknown placed money: no new room.
    for (const v of ['vault:gtUSDCp', 'vault:other']) {
      const unread = { ...idle, vaultsUnread: [v] }
      expect(capRoomOf(unread, V7)).toBe(0n)
      expect(decide(unread, V7).proposal).toBeNull()
    }
  })
})
