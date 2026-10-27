import { describe, expect, test } from 'bun:test'
import { conservadorLiveV2 } from '@mamoru/policy'
import type { Observation } from '@mamoru/decide'
import { Engine } from './engine.ts'

// otto/mamoru#212: what the engine's own re-range or reduce took out of its positions it may put back, past the cap.
type Inner = { capPlaced: bigint | null; capFreeing: boolean; reinvest: bigint; cfg: { policy: typeof conservadorLiveV2 }; reinvestOf(o: Observation): bigint }
const USDC = 1_000_000n

/** An observation that has `placed` USDT idle (placed, at ~1.0) and `idle` USDC. */
function at(placed: bigint, idle: bigint): Observation {
  const pool = { name: 'pool:USDC/USDT/100', token0: 'USDC', token1: 'USDT', sqrtPriceX96: 1n << 96n, tick: 0 }
  return { balances: { USDC: idle, USDT: placed }, positions: [], pools: [pool], deposits: [] } as unknown as Observation
}

describe('reinvest after the engine took money out', () => {
  test('a freeing operation credits what left the positions; placing again uses it up; never above idle savings', () => {
    const e = Object.assign(Object.create(Engine.prototype), { capPlaced: null, capFreeing: false, reinvest: 0n, cfg: { policy: conservadorLiveV2 } }) as Inner
    expect(e.reinvestOf(at(500n * USDC, 0n))).toBe(0n)
    // A re-range went out: 500 placed became idle USDC.
    e.capFreeing = true
    expect(e.reinvestOf(at(0n, 500n * USDC))).toBe(500n * USDC)
    // An entry put 200 back.
    expect(e.reinvestOf(at(200n * USDC, 300n * USDC))).toBe(300n * USDC)
    // The market fell with no operation of the engine: nothing is credited.
    expect(e.reinvestOf(at(100n * USDC, 300n * USDC))).toBe(300n * USDC)
    // The owner withdrew: never more than the idle savings.
    expect(e.reinvestOf(at(100n * USDC, 50n * USDC))).toBe(50n * USDC)
  })
})
