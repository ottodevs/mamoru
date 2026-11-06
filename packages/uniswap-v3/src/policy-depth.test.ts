import { describe, expect, it } from 'bun:test'
import { policyDepth, policyDepthIn, type DepthReads } from './policy-depth.ts'
import { sqrtRatioAtTick } from './quote.ts'

const Q96 = 1n << 96n
const T0 = '0x0000000000000000000000000000000000000001' as const
const T1 = '0x0000000000000000000000000000000000000002' as const

function pool(tick: number, liquidity: bigint, tickSpacing: number, nets: Record<number, bigint> = {}): DepthReads & { asked: number[] } {
  const asked: number[] = []
  return {
    sqrtPriceX96: sqrtRatioAtTick(tick),
    tick,
    liquidity,
    tickSpacing,
    asked,
    liquidityNet: async (t) => {
      asked.push(t)
      return nets[t] ?? 0n
    },
  }
}

describe('policyDepth: MamoruActionPolicy._depth, read for read (otto/mamoru#378)', () => {
  it('without a crossed boundary is the amount between spot and the band edge at the in-range liquidity', async () => {
    const l = 10n ** 18n
    // Spacing 60 against a 10-tick band: one segment each way, as the contract's loop would take it.
    const r = pool(0, l, 60)
    const up = await policyDepth(r, 10, true)
    expect(up).toBe((l * (sqrtRatioAtTick(10) - sqrtRatioAtTick(0))) / Q96)
    const down = await policyDepth(r, 10, false)
    const a = sqrtRatioAtTick(-10)
    const b = sqrtRatioAtTick(0)
    expect(down).toBe(((l << 96n) * (b - a)) / b / a)
  })

  it('applies liquidityNet at each crossed boundary, added going up and subtracted going down', async () => {
    const l = 10n ** 18n
    const net = 10n ** 18n
    const flat = await policyDepth(pool(0, l, 5), 10, true)
    const r = pool(0, l, 5, { 5: net })
    const crossed = await policyDepth(r, 10, true)
    expect(crossed).toBeGreaterThan(flat)
    expect(r.asked).toEqual([5])
    const rd = pool(0, l, 5, { 0: net })
    // Going down from tick 0: the first boundary is 0 itself (spot sits on it), its net is subtracted.
    const down = await policyDepth(rd, 10, false)
    expect(rd.asked).toEqual([0, -5])
    expect(down).toBeLessThan(await policyDepth(pool(0, l, 5), 10, false))
  })

  it('rounds the start boundary like Solidity for a negative tick between boundaries', async () => {
    const r = pool(-7, 10n ** 18n, 5)
    await policyDepth(r, 10, false)
    expect(r.asked).toEqual([-10, -15])
  })

  it('policyDepthIn takes the smaller side, the other one quoted into the budget token at the band edge', async () => {
    const r = pool(0, 10n ** 18n, 1)
    const in1 = await policyDepthIn(r, T0, T1, 10, true)
    const up = await policyDepth(r, 10, true)
    expect(in1).toBeLessThanOrEqual(up)
    const in0 = await policyDepthIn(r, T0, T1, 10, false)
    expect(in0).toBeLessThanOrEqual(await policyDepth(r, 10, false))
  })
})
