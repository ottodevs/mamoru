import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_KEYED_CU_PER_HOUR, keyedBudgetFromEnv, rpcBudget } from '../src/budget.ts'
import { RpcMetrics } from '../src/metrics.ts'

const HOUR = 3_600_000
const T = 500_000 * HOUR + 60_000

const dirs: string[] = []
function metrics(): RpcMetrics {
  const d = mkdtempSync(join(tmpdir(), 'mamoru-budget-'))
  dirs.push(d)
  return new RpcMetrics(d)
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('keyedBudgetFromEnv', () => {
  test('unset, empty, blank, negative and not a number are the default; 0 turns it off', () => {
    expect(keyedBudgetFromEnv({})).toBe(DEFAULT_KEYED_CU_PER_HOUR)
    expect(keyedBudgetFromEnv({ MAMORU_KEYED_CU_PER_HOUR: '' })).toBe(DEFAULT_KEYED_CU_PER_HOUR)
    expect(keyedBudgetFromEnv({ MAMORU_KEYED_CU_PER_HOUR: '   ' })).toBe(DEFAULT_KEYED_CU_PER_HOUR)
    expect(keyedBudgetFromEnv({ MAMORU_KEYED_CU_PER_HOUR: '-5' })).toBe(DEFAULT_KEYED_CU_PER_HOUR)
    expect(keyedBudgetFromEnv({ MAMORU_KEYED_CU_PER_HOUR: 'lots' })).toBe(DEFAULT_KEYED_CU_PER_HOUR)
    expect(keyedBudgetFromEnv({ MAMORU_KEYED_CU_PER_HOUR: '0' })).toBe(0)
    expect(keyedBudgetFromEnv({ MAMORU_KEYED_CU_PER_HOUR: ' 12000 ' })).toBe(12_000)
  })
})

describe('rpcBudget', () => {
  test('over once the clock hour reaches the limit, under again when the hour changes', () => {
    const m = metrics()
    const b = rpcBudget(m, 60)
    m.recordRequest('alchemy.com', 'eth_call', false, T)
    m.recordRequest('alchemy.com', 'eth_call', false, T)
    expect(b.over(T)).toBe(false)
    m.recordRequest('alchemy.com', 'eth_call', false, T)
    expect(m.cuThisHour(T)).toBe(78)
    expect(b.over(T)).toBe(true)
    expect(b.over(T + HOUR)).toBe(false)
  })

  test('counts every billed provider, whatever its label: two keys of one provider, or providers folded into other', () => {
    const m = metrics()
    m.recordRequest('alchemy.com#1', 'eth_call', false, T)
    m.recordRequest('alchemy.com#2', 'eth_call', false, T)
    // More providers than the bucket keeps apart: the rest are folded together, their CU still counts.
    for (let i = 0; i < 40; i++) m.recordRequest(`alchemy.com#${i + 3}`, 'eth_call', false, T)
    expect(m.cuThisHour(T)).toBe(42 * 26)
  })

  test('requests to providers that are not billed do not spend the budget', () => {
    const m = metrics()
    for (let i = 0; i < 50; i++) m.recordRequest('publicnode.com', 'eth_call', false, T)
    expect(rpcBudget(m, 60).over(T)).toBe(false)
  })

  test('a limit of 0 is never over', () => {
    const m = metrics()
    for (let i = 0; i < 50; i++) m.recordRequest('alchemy.com', 'eth_call', false, T)
    expect(rpcBudget(m, 0).over(T)).toBe(false)
  })
})
