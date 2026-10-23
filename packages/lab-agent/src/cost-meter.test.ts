import { describe, expect, test } from 'bun:test'
import { measureCpuMs, newCostMeter, recordModelCall, recordRun, recordSweepCpuMs, recordToolRound, shadowCost, type ShadowPriceTable } from './cost-meter.ts'

describe('CostMeter (AL-40)', () => {
  test('starts empty and accumulates every field the spec names', () => {
    const meter = newCostMeter()
    expect(meter).toEqual({ modelCalls: [], toolRounds: 0, runs: [], sweepCpuMs: 0, wallMs: 0, repairUsed: false, verifierOutcome: 'ok' })

    recordModelCall(meter, { model: 'r1', promptTokens: 100, completionTokens: 20 })
    recordModelCall(meter, { model: 'r1', promptTokens: 50, completionTokens: 10 })
    recordToolRound(meter)
    recordRun(meter, '0xaaa', 12.5)
    recordSweepCpuMs(meter, 3)
    meter.wallMs = 900
    meter.repairUsed = true
    meter.verifierOutcome = 'partial'

    expect(meter.modelCalls).toHaveLength(2)
    expect(meter.toolRounds).toBe(1)
    expect(meter.runs).toEqual([{ resultHash: '0xaaa', cpuMs: 12.5 }])
    expect(meter.sweepCpuMs).toBe(3)
    expect(meter.wallMs).toBe(900)
    expect(meter.repairUsed).toBe(true)
    expect(meter.verifierOutcome).toBe('partial')
  })
})

describe('measureCpuMs', () => {
  test('returns the function result and a non-negative cpuMs', () => {
    const { result, cpuMs } = measureCpuMs(() => {
      let s = 0
      for (let i = 0; i < 1e5; i++) s += i
      return s
    })
    expect(result).toBe(4999950000)
    expect(cpuMs).toBeGreaterThanOrEqual(0)
  })
})

describe('shadowCost (AL-40, AL-41)', () => {
  const prices: ShadowPriceTable = {
    date: '2026-10-23',
    models: { 'free-model-a': { inputPerMTok: 0.1, outputPerMTok: 0.4 }, default: { inputPerMTok: 1, outputPerMTok: 2 } },
    computeUsdPerCpuMs: 0.00001,
    dataUsdPerJob: 0,
    settlementUsdPerJob: 0,
  }

  test('splits LLM / compute / data / settlement from the meter, under the given price table', () => {
    const meter = newCostMeter()
    recordModelCall(meter, { model: 'free-model-a', promptTokens: 2_000_000, completionTokens: 500_000 })
    recordRun(meter, '0xaaa', 1000)
    recordSweepCpuMs(meter, 500)

    const cost = shadowCost(meter, prices)
    expect(cost.llm).toBeCloseTo(2 * 0.1 + 0.5 * 0.4, 6) // 0.4
    expect(cost.compute).toBeCloseTo(1500 * 0.00001, 6) // runs + sweep cpu ms
    expect(cost.data).toBe(0)
    expect(cost.settlement).toBe(0) // v1: always 0 (AL-41)
    expect(cost.total).toBeCloseTo(cost.llm + cost.compute, 6)
  })

  test('a model resource with no price entry falls back to "default"', () => {
    const meter = newCostMeter()
    recordModelCall(meter, { model: 'unknown-resource', promptTokens: 1_000_000, completionTokens: 1_000_000 })
    const cost = shadowCost(meter, prices)
    expect(cost.llm).toBeCloseTo(1 + 2, 6)
  })

  test('an empty meter costs exactly the flat per-job terms', () => {
    const meter = newCostMeter()
    const cost = shadowCost(meter, prices)
    expect(cost).toEqual({ llm: 0, compute: 0, data: 0, settlement: 0, total: 0 })
  })
})
