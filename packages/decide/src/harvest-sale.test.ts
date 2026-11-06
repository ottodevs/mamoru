import { describe, expect, test } from 'bun:test'
import { conservadorLiveV7, grantKey } from '@mamoru/policy'
import { address, baseRegistry, entry } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { canonicalJson, decide, HARVEST_SALE_AGE_SECONDS, inSavings, type Observation, type PoolObs, type PositionObs } from './index.ts'
import { opCostInSavings } from './value.ts'

// otto/mamoru#107, spec 012 HRV-R1, R2, R7: the sale of harvested volatile, on the live v7 policy.
const V7 = conservadorLiveV7
const BTC_POOL = 'pool:USDC/cbBTC/500'
const NOW = 2_000_000n

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

const POOLS = [pool('pool:USDC/USDT/100', 1), pool(BTC_POOL, -69_080), pool('pool:WETH/USDC/3000', -193_380)]
const BTC = POOLS[1]!

function obs(over: Partial<Observation> = {}): Observation {
  return {
    chainId: 8453,
    block: { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: NOW },
    safeBlock: { number: 98n, hash: `0x${'22'.repeat(32)}` },
    account: { address: '0x00000000000000000000000000000000000000aa', deployed: true, nonceKey: 0n, nonce: 0n },
    sessions: V7.session.grants.map((g, i) => ({ grant: grantKey(g), permissionId: `0x${(i + 1).toString(16).padStart(2, '0').repeat(32)}` as const, validUntil: 1e10, active: true })),
    native: 10n ** 17n,
    balances: { USDC: 0n, USDT: 0n, cbBTC: 0n, WETH: 0n },
    positions: [],
    pools: POOLS,
    vaults: [],
    ethPrice: { pool: 'pool:WETH/USDC/3000', sqrtPriceX96: sqrtRatioAtTick(-193_380), token0: 'WETH' },
    gas: { maxFeePerGas: 2_000_000n, opGasUnits: 5_100_000n },
    deposits: [],
    intents: { paused: false, exitRequested: false },
    slot: null,
    remote: { value: 0n, inFlight: 0n, ready: false },
    ...over,
  }
}

/** cbBTC worth `usdc` raw savings units at the pool price. */
function btcWorth(usdc: bigint): bigint {
  const one = inSavings(BTC, 'cbBTC', 10n ** 8n, 'USDC')
  return (usdc * 10n ** 8n) / one
}

function inRangePosition(over: Partial<PositionObs> = {}): PositionObs {
  return { tokenId: 9n, pool: BTC_POOL, tickLower: -69_080 - 600, tickUpper: -69_080 + 600, liquidity: 10n ** 13n, collectable0: 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: true, ...over }
}

const COST = opCostInSavings(obs(), 'USDC')

describe('harvest sale (spec 012 HRV-R1)', () => {
  test('sells exactly the harvested volatile, never the principal beside it', () => {
    const harvested = btcWorth(COST * 10n)
    const principal = btcWorth(50_000_000n)
    const d = decide(obs({ balances: { USDC: 0n, cbBTC: harvested + principal }, harvested: { cbBTC: { amount: harvested, since: Number(NOW) - 60 } } }), V7)
    expect(d.proposal).toMatchObject({ kind: 'enter_swap', tokenIn: 'cbBTC', tokenOut: 'USDC', amountIn: harvested, harvestSale: true, pool: BTC_POOL })
    expect(d.reason).toBe('DECIDE_HARVEST')
  })

  test('never more than the Safe still holds (HRV-S21: a re-range spent it)', () => {
    const d = decide(obs({ balances: { USDC: 0n, cbBTC: 0n }, harvested: { cbBTC: { amount: btcWorth(COST * 10n), since: Number(NOW) - 60 } } }), V7)
    expect(d.proposal?.kind === 'enter_swap' && d.proposal.harvestSale).toBeFalsy()
  })

  test('below 3x its cost it waits, and goes once later harvests add up (HRV-S02)', () => {
    const small = btcWorth(COST)
    const wait = decide(obs({ balances: { USDC: 0n, cbBTC: small }, harvested: { cbBTC: { amount: small, since: Number(NOW) - 60 } } }), V7)
    expect(wait.proposal).toBeNull()
    expect(wait.buckets).toContainEqual({ bucket: 'btc-usdc', code: 'DECIDE_WAIT_HARVEST_SALE' })
    const more = small * 4n
    const go = decide(obs({ balances: { USDC: 0n, cbBTC: more }, harvested: { cbBTC: { amount: more, since: Number(NOW) - 60 } } }), V7)
    expect(go.proposal).toMatchObject({ kind: 'enter_swap', amountIn: more, harvestSale: true })
  })

  test('after 7 days it goes once it beats its cost once (HRV-S23)', () => {
    const two = btcWorth(COST * 2n)
    const young = decide(obs({ balances: { USDC: 0n, cbBTC: two }, harvested: { cbBTC: { amount: two, since: Number(NOW) - 60 } } }), V7)
    expect(young.proposal).toBeNull()
    const old = decide(obs({ balances: { USDC: 0n, cbBTC: two }, harvested: { cbBTC: { amount: two, since: Number(NOW - HARVEST_SALE_AGE_SECONDS) - 1 } } }), V7)
    expect(old.proposal).toMatchObject({ kind: 'enter_swap', amountIn: two, harvestSale: true })
  })

  test('an idle sale of principal never takes the harvested amount', () => {
    const harvested = btcWorth(COST)
    const d = decide(obs({ balances: { USDC: 0n, cbBTC: harvested }, harvested: { cbBTC: { amount: harvested, since: Number(NOW) - 60 } }, positions: [inRangePosition()] }), V7)
    if (d.proposal?.kind === 'enter_swap') expect(d.proposal.tokenIn === 'cbBTC' && d.proposal.amountIn > 0n).toBe(false)
  })

  test('a harvest still goes first', () => {
    const harvested = btcWorth(COST * 10n)
    const fees = inRangePosition({ collectable0: COST * 100n, collectable1: 0n })
    const d = decide(obs({ balances: { USDC: 0n, cbBTC: harvested }, harvested: { cbBTC: { amount: harvested, since: Number(NOW) - 60 } }, positions: [fees] }), V7)
    expect(d.proposal?.kind).toBe('harvest')
  })

  test('without harvested volatile the decision is byte-identical to before', () => {
    const o = obs({ balances: { USDC: 300_000_000n, cbBTC: 0n } })
    expect(canonicalJson(decide({ ...o, harvested: undefined }, V7))).toBe(canonicalJson(decide(o, V7)))
  })
})

describe('spending room on V4 (spec 012 HRV-R7)', () => {
  const harvested = btcWorth(COST * 10n)
  const base = { balances: { USDC: 0n, cbBTC: harvested }, harvested: { cbBTC: { amount: harvested, since: Number(NOW) - 60 } } }

  test('room below 1.5x the positions plus the sale: the sale waits (HRV-S03)', () => {
    const p = inRangePosition()
    const o = obs({ ...base, positions: [p], budget: { room: 1n } })
    const d = decide(o, V7)
    expect(d.proposal?.kind === 'enter_swap' && d.proposal.harvestSale).toBeFalsy()
    expect(d.buckets).toContainEqual({ bucket: 'btc-usdc', code: 'DECIDE_WAIT_BUDGET' })
  })

  test('no room never holds back maintenance: re-range, reduce and harvest decide as without a budget (HRV-S04)', () => {
    const out = inRangePosition({ tickLower: -69_080 + 2_000, tickUpper: -69_080 + 3_000 })
    const fees = inRangePosition({ tokenId: 10n, collectable0: COST * 100n })
    for (const positions of [[out], [fees]]) {
      const without = decide(obs({ balances: { USDC: 0n, cbBTC: 0n }, positions, lastRerangeAt: 0n }), V7)
      const withNoRoom = decide(obs({ balances: { USDC: 0n, cbBTC: 0n }, positions, lastRerangeAt: 0n, budget: { room: 0n } }), V7)
      expect(withNoRoom.proposal).toEqual(without.proposal)
      expect(without.proposal).not.toBeNull()
    }
  })

  test('room that covers the reserve: the sale goes', () => {
    const d = decide(obs({ ...base, budget: { room: 10n ** 15n } }), V7)
    expect(d.proposal).toMatchObject({ kind: 'enter_swap', harvestSale: true })
  })
})
