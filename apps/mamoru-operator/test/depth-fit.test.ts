// otto/mamoru#378: a v4 approval signs each pool's daily budget (Init.perWindow) under the depth MamoruActionPolicy reads
// in the pool's band, keeps a budget already configured at the generation, and refuses instead of signing what reverts.
import { describe, expect, test } from 'bun:test'
import type { Hex } from 'viem'
import { v4BudgetCaps, v4PoolsOn } from '@mamoru/policy'
import { v4DeploymentOf } from '@mamoru/account/sessions'
import { address, baseRegistry } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { resolveV5Policy } from '../src/boot.ts'
import { HttpError, type Operator } from '../src/operator.ts'
import { world } from './owner-world.ts'

const env = { MAMORU_ONCHAIN_POLICY_V4: '1', MAMORU_ACTION_POLICY_ADDRESS: `0x${'11'.repeat(20)}`, MAMORU_ACTION_POLICY_V2_ADDRESS: `0x${'33'.repeat(20)}`, MAMORU_GAS_POLICY_ADDRESS: `0x${'22'.repeat(20)}` }
const v5 = resolveV5Policy('base', env)!
const SAFE = `0x${'5a'.repeat(20)}` as Hex
const CAP = 100_000_000_000n // 100,000 USDC

type Config = { twapWindow: number; generation: bigint; perWindow: bigint; total: bigint }
type Fit = (live: { safe: Hex }, policy: typeof v5, cap: bigint, d: unknown, generation: bigint, block: bigint) => Promise<Record<string, bigint>>

/** A chain whose every pool has `liquidity` in range and nothing initialized in the band; `configured` per pool name. */
function chain(op: Operator, liquidity: bigint, configured: Record<string, Config> = {}) {
  const client = (op as unknown as { client: { readContract: (a: { address: string; functionName: string; args?: readonly unknown[] }) => Promise<unknown> } }).client
  client.readContract = async (a) => {
    if (a.functionName === 'configOf') {
      const pool = String(a.args?.[1]).toLowerCase()
      const hit = Object.entries(configured).find(([name]) => poolAddress(name) === pool)
      return hit?.[1] ?? { twapWindow: 0, generation: 0n, perWindow: 0n, total: 0n }
    }
    if (a.functionName === 'slot0') return [sqrtRatioAtTick(0), 0, 0, 0, 0, 0, true]
    if (a.functionName === 'liquidity') return liquidity
    if (a.functionName === 'tickSpacing') return 1
    if (a.functionName === 'ticks') return [0n, 0n, 0n, 0n, 0n, 0n, 0, false]
    throw new Error(`unexpected read ${a.functionName}`)
  }
}

const poolAddress = (name: string) => address(name as never, baseRegistry).toLowerCase()

function fit(op: Operator): Fit {
  const o = op as unknown as { depthFitBudgets: Fit }
  return o.depthFitBudgets.bind(op)
}

const specs = v4PoolsOn(v5.sourceChainId).filter((p) => v5.buckets.some((b) => b.pools.includes(p.pool)))
const stables = specs.find((p) => p.pool === 'pool:USDC/USDT/100')!
const formula = v4BudgetCaps(v5, CAP)
const d = v4DeploymentOf(v5)

describe('depthFitBudgets (otto/mamoru#378)', () => {
  test('a deep band signs the cap formula unchanged', async () => {
    const w = world(0n)
    chain(w.op, 10n ** 30n)
    expect(await fit(w.op)({ safe: SAFE }, v5, CAP, d, 1n, 100n)).toEqual(formula)
  })

  test('a shallow band signs perWindow at 80 % of its depth, total unchanged', async () => {
    const w = world(0n)
    // Spot at tick 0 with this liquidity: a 10-tick band holds far less than the formula's daily budget at 100k.
    chain(w.op, 10n ** 14n)
    const got = await fit(w.op)({ safe: SAFE }, v5, CAP, d, 1n, 101n)
    const want = formula[stables.caps.budgetWindow]!
    expect(got[stables.caps.budgetWindow]!).toBeLessThan(want)
    expect(got[stables.caps.budgetWindow]!).toBeGreaterThanOrEqual(1_000_000n)
    expect(got[stables.caps.budgetTotal]).toBe(formula[stables.caps.budgetTotal])
  })

  test('a pool already configured at this generation keeps its on-chain values (its Init must hash the same)', async () => {
    const w = world(0n)
    const configured = { twapWindow: 1800, generation: 2n, perWindow: 7_000_000n, total: 9_000_000n }
    chain(w.op, 10n ** 30n, { [stables.pool]: configured })
    const got = await fit(w.op)({ safe: SAFE }, v5, CAP, d, 2n, 102n)
    expect(got[stables.caps.budgetWindow]).toBe(7_000_000n)
    expect(got[stables.caps.budgetTotal]).toBe(9_000_000n)
    // At another generation the configured values are not reused.
    const next = await fit(w.op)({ safe: SAFE }, v5, CAP, d, 3n, 102n)
    expect(next[stables.caps.budgetWindow]).toBe(formula[stables.caps.budgetWindow])
  })

  test('a configured budget above what this cap signs is refused, never re-signed', async () => {
    const w = world(0n)
    const configured = { twapWindow: 1800, generation: 2n, perWindow: formula[stables.caps.budgetWindow]! + 1n, total: 1n }
    chain(w.op, 10n ** 30n, { [stables.pool]: configured })
    const e = await fit(w.op)({ safe: SAFE }, v5, CAP, d, 2n, 103n).catch((x) => x)
    expect(e).toBeInstanceOf(HttpError)
    expect((e as HttpError).code).toBe('POLICY_GENERATION_MOVED')
  })

  test('a band that cannot take one unit is refused before anything is signed', async () => {
    const w = world(0n)
    chain(w.op, 0n)
    const e = await fit(w.op)({ safe: SAFE }, v5, CAP, d, 1n, 104n).catch((x) => x)
    expect(e).toBeInstanceOf(HttpError)
    expect((e as HttpError).code).toBe('POOL_DEPTH_TOO_THIN')
  })
})
