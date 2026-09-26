import { describe, expect, test } from 'bun:test'
import type { Provenance } from '@mamoru/domain'
import { address } from '@mamoru/registry'
import type { SavingsLogRow } from './index.ts'
import { everyFigureObserved, labPayload, type LabRun, type LogRef } from './lab-payload.ts'

const H = 120
const AT = '2026-09-26T12:00:00.000Z'
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const
const ref = (block: number, logIndex = 0): LogRef => ({ block, blockHash: hash(block), txHash: hash(1000 + block), logIndex, at: AT })
const ACCOUNT = '0x00000000000000000000000000000000000000aa'

const harvest: SavingsLogRow = {
  kind: 'harvest', opId: 'op-3', tokenId: 7n, chainId: 31337, block: 110n, blockHash: hash(110), txHash: hash(1110), logIndex: 4, at: AT,
  principal: [0n, 0n], fees: [5_000n, 90n], conversion: { amountIn: 90n, amountOut: 8_000n }, credited: 13_000n, status: 'confirmed', code: 'PROJ_CONFIRMED',
  provenance: [
    { source: 'journal', chainId: 31337, observedAt: AT, status: 'fresh', detail: 'PROJ_CONFIRMED' },
    { source: 'fork_rpc', chainId: 31337, blockNumber: 110, blockHash: hash(110), observedAt: AT, status: 'fresh' },
  ],
}

function run(over: Partial<LabRun> = {}): LabRun {
  return {
    chainId: 31337,
    block: { number: H, hash: hash(H), at: AT },
    safeBlock: H - 2,
    account: { address: ACCOUNT, deployed: true },
    policy: {
      version: '1.0.0',
      buckets: [
        { id: 'stables', preference: 5000, pools: [] },
        { id: 'btc-usdc', preference: 4000, pools: ['pool:USDC/cbBTC/500'] },
      ],
      maxTwapDeviationTicks: 50,
      renewalWindowSeconds: 3600,
    },
    balances: { USDC: 20_000n, cbBTC: 10n, WETH: 0n, ETH: 10n ** 16n },
    // cbBTC at 1024 USDC base units per base unit; WETH at 2^-30.
    priceSlots: [
      { pool: 'pool:USDC/cbBTC/500', sqrtPriceX96: 2n ** 91n },
      { pool: 'pool:WETH/USDC/3000', sqrtPriceX96: 2n ** 81n },
    ],
    positions: [
      {
        tokenId: 7n, pool: 'pool:USDC/cbBTC/500', managed: true, tickLower: -100, tickUpper: 100, liquidity: 500n,
        inLiquidity: [1_000n, 2n], collectable: [300n, 1n], principalOwed: [100n, 0n],
        mint: { block: 100, tick: 0 },
        events: [
          { ...ref(100, 2), kind: 'mint', liquidity: 500n, amount0: 1_000n, amount1: 2n, opId: 'op-2' },
          { ...ref(110, 4), kind: 'collect', liquidity: 0n, amount0: 5_000n, amount1: 90n, opId: 'op-3' },
        ],
      },
    ],
    pools: [
      {
        name: 'pool:USDC/cbBTC/500', sqrtPriceX96: 2n ** 91n, tick: 10, twapTick: 0, liquidity: 9_000n, balance0: 1_000_000n, balance1: 500n,
        window: { fromBlock: 51, toBlock: H },
        // Out of range for the ten blocks from 105 to 114, in range again from 115.
        swaps: [
          { ...ref(105, 1), amount0: 2_000n, amount1: -2n, tick: 150 },
          { ...ref(115, 1), amount0: -1_000n, amount1: 1n, tick: 10 },
        ],
        liquidityEvents: [{ ...ref(100, 1), kind: 'mint', amount: 500n, amount0: 1_000n, amount1: 2n, tickLower: -100, tickUpper: 100 }],
      },
    ],
    sessions: [
      { name: 'enter-swap', validUntil: Date.parse(AT) / 1000 + 86_400, active: true },
      { name: 'manage:7', validUntil: Date.parse(AT) / 1000 + 86_400, active: true },
    ],
    paused: false,
    ops: [
      { opId: 'op-1', kind: 'enter_swap', state: 'confirmed', code: 'EXEC_OK', updatedAt: AT, txHash: hash(1090), userOpEvent: ref(90, 3), swap: { ...ref(90, 1), tokenIn: 'USDC', tokenOut: 'cbBTC', amountIn: 4_000n, amountOut: 4n } },
      { opId: 'op-3', kind: 'harvest', state: 'confirmed', code: 'EXEC_OK', updatedAt: AT, txHash: hash(1110), userOpEvent: ref(110, 9), swap: { ...ref(110, 6), tokenIn: 'cbBTC', tokenOut: 'USDC', amountIn: 90n, amountOut: 8_000n } },
    ],
    decisions: [
      { decisionId: '0x01', kind: 'harvest', code: 'DECIDE_HARVEST', block: 109, at: AT, observationCodes: [], trail: [], shadow: [], buckets: [], positions: [] },
      {
        decisionId: '0x02', kind: 'hold', code: 'DECIDE_HOLD', block: H, at: AT, observationCodes: ['OBS_ETH_NOT_INVESTED'],
        trail: [{ gate: 'strategy', verdict: 'SKIP', reason: 'DECIDE_HARVEST_BELOW_COST' }],
        shadow: [{ code: 'ENY_SHADOW', note: 'ENY estimate recorded.' }],
        buckets: [{ bucket: 'stables', code: 'PLAN_BUCKET_NO_EXECUTABLE_POOL' }, { bucket: 'btc-usdc', code: 'DECIDE_IN_RANGE' }],
        positions: [{ tokenId: '7', codes: ['DECIDE_HARVEST_BELOW_COST'] }],
      },
    ],
    savingsLog: [harvest],
    convertQuote: 10_200n,
    ...over,
  }
}

function provenances(value: unknown, out: Provenance[] = []): Provenance[] {
  if (Array.isArray(value)) value.forEach((v) => provenances(v, out))
  else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (typeof o.source === 'string' && typeof o.status === 'string') out.push(o as Provenance)
    else Object.values(o).forEach((v) => provenances(v, out))
  }
  return out
}

describe('labPayload', () => {
  test('lab mode on the fork chain, with the lab band and the gate open only for the lab', () => {
    const d = labPayload(run())
    expect(d.mode).toBe('lab')
    expect(d.chainId).toBe(31337)
    expect(d.chains).toEqual([{ chainId: 31337, name: 'Base fork', observed: true }])
    expect(d.banner).toEqual({ kind: 'lab', text: `Simulation · Base fork · Block ${H} · Not capital`, block: H })
    expect(d.account.fundsGate).toBe('lab')
    expect(d.sources.index.provider).toBe('fork_index')
  })

  test('every provenance is on the fork chain and none is Base or MultiBaas', () => {
    const all = provenances(labPayload(run()))
    expect(all.length).toBeGreaterThan(50)
    expect(all.every((p) => p.chainId === 31337)).toBe(true)
    expect(all.some((p) => p.source === 'chain_rpc' || p.source === 'multibaas')).toBe(false)
  })

  test('position: range, principal with the owed part, fees net of principal, history and time in range', () => {
    const p = labPayload(run()).pools.positions[0]!
    expect(p.rangeState.value).toBe('in_range')
    expect(p.principal.amount0.value).toBe('1100')
    expect(p.principal.value).toMatchObject({ value: String(1_100 + 2 * 1024), unit: 'USDC' })
    expect(p.principal.value.provenance.source).toBe('estimate')
    expect(p.uncollectedFees.amount0.value).toBe('200')
    expect(p.uncollectedFees.amount1.value).toBe('1')
    expect(p.collectedFees.amount0.value).toBe('5000')
    expect(p.feeMovement).toMatchObject({ amount0: { value: '5200' }, fromBlock: 100 })
    expect(p.liquidityFromEvents.value).toBe('500')
    expect(p.historyComplete).toBe(true)
    expect(p.timeInRange.value).toBe(String(10 / 20))
    expect(p.codes).toEqual(['DECIDE_HARVEST_BELOW_COST'])
    expect(p.events.map((e) => e.kind)).toEqual(['collect', 'mint'])
  })

  test('pool from fork reads and fork logs', () => {
    const v = labPayload(run()).pools.plan[0]!
    expect(v.price).toMatchObject({ value: String(10n ** 8n * 1024n), unit: 'USDC' })
    expect(v.twapGuard.value).toBe('ok')
    expect(v.stats.swaps.value).toBe(2)
    expect(v.stats.volume0.value).toBe('2000')
    expect(v.stats.fees0.value).toBe('1')
    expect([v.stats.tickMin.value, v.stats.tickMax.value]).toEqual([10, 150])
    expect(v.stats.added.count.value).toBe(1)
    expect(v.recentSwaps[0]!.block).toBe(115)
    expect(v.accountPositions).toEqual([{ tokenId: '7', rangeState: expect.objectContaining({ value: 'in_range' }) }])
  })

  test('savings and the Savings Log come from the harvest row', () => {
    const d = labPayload(run())
    expect(d.savings.ledgerTotal).toMatchObject({ value: '13000', unit: 'USDC', provenance: { source: 'journal' } })
    expect(d.savings.available.value).toBe('13000')
    expect(d.savings.lastHarvest?.value).toBe(AT)
    expect(d.savingsLog.rows).toHaveLength(1)
    expect(d.savingsLog.rows[0]).toMatchObject({ kind: 'harvest', block: 110, txHash: hash(1110), logIndex: 4, opId: 'op-3', code: 'PROJ_CONFIRMED' })
    expect(d.savingsLog.rows[0]!.amount.provenance.source).toBe('fork_rpc')
    expect(d.treasury.idle.usdc.value).toBe('7000')
    expect(d.treasury.idle.code).toBe('PLAN_BUCKET_NO_EXECUTABLE_POOL')
    expect(d.treasury.convert).toMatchObject({ state: 'held_for_entry', quote: { value: '10200' } })
    expect(d.treasury.swaps.map((s) => s.opId)).toEqual(['op-3', 'op-1'])
  })

  test('current action: last op with its state and code, last decision with its trail, newest decisions first', () => {
    const ca = labPayload(run()).currentAction
    expect(ca.op).toEqual({ opId: 'op-3', kind: 'harvest', state: 'confirmed', code: 'EXEC_OK', updatedAt: AT, txHash: hash(1110) })
    expect(ca.decision).toMatchObject({ decisionId: '0x02', code: 'DECIDE_HOLD', block: H, trail: [{ gate: 'strategy', verdict: 'SKIP', reason: 'DECIDE_HARVEST_BELOW_COST' }] })
    expect(ca.recentDecisions.map((x) => x.decisionId)).toEqual(['0x02', '0x01'])
    expect(ca.chainOps.map((x) => x.opId)).toEqual(['op-3', 'op-1'])
    expect(ca.session.value).toBe('active')
    expect(ca.nextReviewAt).toMatchObject({ value: null, provenance: { status: 'not_observed' } })
  })

  test('session inside the renewal window is renewal_due', () => {
    const soon = Date.parse(AT) / 1000 + 600
    expect(labPayload(run({ sessions: [{ name: 'manage:7', validUntil: soon, active: true }] })).currentAction.session.value).toBe('renewal_due')
    expect(labPayload(run({ sessions: [] })).currentAction.session.value).toBe('missing')
  })

  test('actions are not derived: empty and not complete', () => {
    expect(labPayload(run()).actions).toEqual({ items: [], complete: false, notObserved: ['actions derivation'] })
  })

  test('without a price, values are not observed, the total names what is missing and provenance is incomplete', () => {
    const d = labPayload(run({ priceSlots: [{ pool: 'pool:USDC/cbBTC/500', sqrtPriceX96: 2n ** 91n }] }))
    const eth = d.portfolio.tokens.find((t) => t.token === 'ETH')!
    expect(eth.value).toMatchObject({ value: null, provenance: { status: 'not_observed', source: 'estimate' } })
    expect(eth.code).toBe('OBS_ETH_NOT_INVESTED')
    expect(d.account.totalValue.value).toBeNull()
    expect(d.portfolio.tokens.find((t) => t.token === 'WETH')!.value.value).toBe('0')
    expect(d.account.totalMissing).toEqual(['ETH price'])
    expect(d.provenanceComplete).toBe(false)
  })

  test('with every price, the total sums tokens and positions', () => {
    const d = labPayload(run())
    const tokens = d.portfolio.tokens.reduce((a, t) => a + BigInt(t.value.value!), 0n)
    expect(d.portfolio.total.value).toBe((tokens + BigInt(d.portfolio.positions.value.value!)).toString())
    expect(d.portfolio.positions.managed.value).toBe(1)
  })
})

describe('everyFigureObserved', () => {
  test('false as soon as one nested figure is not observed', () => {
    const p: Provenance = { source: 'fork_rpc', chainId: 31337, observedAt: AT, status: 'fresh' }
    expect(everyFigureObserved({ a: [{ value: '1', provenance: p }] })).toBe(true)
    expect(everyFigureObserved({ a: [{ value: null, provenance: { ...p, status: 'not_observed' } }] })).toBe(false)
  })
})

test('registry pool address is the one in the view', () => {
  expect(labPayload(run()).pools.plan[0]!.pool.address).toBe(address('pool:USDC/cbBTC/500'))
})
