import { describe, expect, test } from 'bun:test'
import { conservadorLiveV2 } from '@mamoru/policy'
import type { Observation } from '@mamoru/decide'
import { Engine } from './engine.ts'

// otto/mamoru#212: what the engine's own re-range or reduce took out of its positions it may put back, past the cap.
type Inner = { capPlaced: bigint | null; capIdle: bigint | null; capFreeing: boolean; capSpending: boolean; reinvest: bigint; cfg: { policy: typeof conservadorLiveV2 }; reinvestOf(o: Observation): bigint; resetCapReinvest(): void }
const USDC = 1_000_000n

/** An observation that has `placed` USDT idle (placed, at ~1.0) and `idle` USDC. */
function at(placed: bigint, idle: bigint): Observation {
  const pool = { name: 'pool:USDC/USDT/100', token0: 'USDC', token1: 'USDT', sqrtPriceX96: 1n << 96n, tick: 0 }
  return { balances: { USDC: idle, USDT: placed }, positions: [], pools: [pool], deposits: [] } as unknown as Observation
}

const engine = () => Object.assign(Object.create(Engine.prototype), { capPlaced: null, capIdle: null, capFreeing: false, capSpending: false, reinvest: 0n, cfg: { policy: conservadorLiveV2 } }) as Inner

describe('reinvest after the engine took money out', () => {
  test('a freeing operation credits the savings it added; placing again uses it up; never above idle savings', () => {
    const e = engine()
    expect(e.reinvestOf(at(500n * USDC, 0n))).toBe(0n)
    // A re-range went out: 500 placed became idle USDC.
    e.capFreeing = true
    expect(e.reinvestOf(at(0n, 500n * USDC))).toBe(500n * USDC)
    // An entry put 200 back.
    e.capSpending = true
    expect(e.reinvestOf(at(200n * USDC, 300n * USDC))).toBe(300n * USDC)
    // The market fell with no operation of the engine: nothing is credited.
    expect(e.reinvestOf(at(100n * USDC, 300n * USDC))).toBe(300n * USDC)
  })

  test('merge gate round 1 (Argon): a price drop during a freeing operation credits only the savings it freed', () => {
    const e = engine()
    // 2,000 placed, 1,000 idle over the cap.
    e.reinvestOf(at(2_000n * USDC, 1_000n * USDC))
    // A harvest freed 50 USDC while the market took 450 off the rest: 50 is credited, not 500.
    e.capFreeing = true
    expect(e.reinvestOf(at(1_500n * USDC, 1_050n * USDC))).toBe(50n * USDC)
  })

  test('merge gate round 1 (Argon): an owner withdrawal clears it, during a freeing operation or after it', () => {
    const e = engine()
    e.reinvestOf(at(500n * USDC, 0n))
    e.capFreeing = true
    expect(e.reinvestOf(at(0n, 500n * USDC))).toBe(500n * USDC)
    // The owner took 800 placed out (a transfer reducing positions): no idle gain from the engine, nothing credited;
    // the operator also clears it on every owner transfer or stop.
    e.resetCapReinvest()
    expect(e.reinvestOf(at(0n, 500n * USDC))).toBe(0n)
    // Idle savings that fall with no entry of the engine (a withdrawal it did not see as an owner op): cleared.
    e.capFreeing = true
    e.reinvestOf(at(0n, 900n * USDC))
    expect(e.reinvestOf(at(0n, 400n * USDC))).toBe(0n)
    // A deposit while a freeing operation ran credits no more than what left the positions.
    e.reinvestOf(at(300n * USDC, 400n * USDC))
    e.capFreeing = true
    expect(e.reinvestOf(at(200n * USDC, 1_400n * USDC))).toBe(100n * USDC)
  })
})
