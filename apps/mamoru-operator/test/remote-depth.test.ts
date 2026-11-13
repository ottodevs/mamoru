// otto/mamoru#401: what a remote Safe's MamoruActionPolicyV3 checks at its first swap or mint, read the same way.
import { describe, expect, test } from 'bun:test'
import type { Address } from 'viem'
import { V4_POOLS_MONAD, liveWmonUsdcMonadV6, v4BudgetCaps } from '@mamoru/policy'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { V4_DEPTH_MULTIPLE, V4_MAX_DEPTH_STEPS, depthShortOf, fitRemoteCap, readPoolDepth, v4OpRoom, type DepthClient } from '../src/remote-depth.ts'

const POLICY = '0x00000000000000000000000000000000000000a3' as Address
const ACCOUNT = '0x0003d8021BBeC02291b7F0001e05d56BeC3734Cc' as Address
// token0 WMON < token1 USDC by address, as on Monad.
const POOL = { name: 'pool:WMON/USDC/3000', address: '0x00000000000000000000000000000000000000b0' as Address, token0: '0x0000000000000000000000000000000000000001' as Address, token1: '0x0000000000000000000000000000000000000002' as Address }
const TICK = -300_000

/** One pool with flat liquidity `liq` (no initialized tick in the band) and the policy's config/spend of the account. */
function client(liq: bigint, config: { twapWindow: number; perWindow: bigint }, spentAt = 0n): DepthClient & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async readContract(a) {
      calls.push(a.functionName)
      switch (a.functionName) {
        case 'slot0':
          return [sqrtRatioAtTick(TICK), TICK, 0, 0, 0, 0, true]
        case 'liquidity':
          return liq
        case 'tickSpacing':
          return 60
        case 'ticks':
          return [0n, 0n, 0n, 0n, 0n, 0n, 0, false]
        case 'configOf':
          return { twapWindow: config.twapWindow, twapShortWindow: 300, bandTicks: 100, generation: 1n, budgetIn1: true, budgetWindow: 86_400, anchorTick: 0, anchorBand: 0, perWindow: config.perWindow, total: config.perWindow * 4n, initHash: `0x${'00'.repeat(32)}` }
        case 'spendOf':
          return { generation: 1n, updatedAt: spentAt, in1: true, debt: 0n, total: 0n }
      }
      throw new Error(`unexpected ${a.functionName}`)
    },
  }
}

describe('the deferred depth check, read as the contract reads it', () => {
  test('a pool is short only while its check is owed (never charged) and its depth is under perWindow', async () => {
    const liq = 10n ** 15n
    const depth = await readPoolDepth(client(liq, { twapWindow: 1800, perWindow: 0n }), POOL, 100, true)
    expect(depth > 0n).toBe(true)
    const over = { twapWindow: 1800, perWindow: depth + 1n }
    expect(await depthShortOf(client(liq, over), POLICY, ACCOUNT, [POOL])).toEqual([{ pool: POOL.name, depth, perWindow: depth + 1n }])
    // At the budget: the contract accepts (`<`), so nothing is held.
    expect(await depthShortOf(client(liq, { twapWindow: 1800, perWindow: depth }), POLICY, ACCOUNT, [POOL])).toEqual([])
    // Charged once: the checks ran and passed, the pool depth no longer matters to the policy (and is not read).
    const charged = client(liq, over, 1_799_000_000n)
    expect(await depthShortOf(charged, POLICY, ACCOUNT, [POOL])).toEqual([])
    expect(charged.calls).not.toContain('slot0')
    // No config for the pool: nothing to hold.
    expect(await depthShortOf(client(liq, { twapWindow: 0, perWindow: 0n }), POLICY, ACCOUNT, [POOL])).toEqual([])
  })

  test('a failed read throws (the engine then decides without it)', async () => {
    const c: DepthClient = { readContract: async () => Promise.reject(new Error('rpc down')) }
    await expect(depthShortOf(c, POLICY, ACCOUNT, [POOL])).rejects.toThrow('rpc down')
  })
})

describe("a new remote Safe's cap fits its pool (otto/mamoru#401)", () => {
  const remote = liveWmonUsdcMonadV6
  const windowAt = (c: bigint) => v4BudgetCaps(remote, c)[V4_POOLS_MONAD.growth.caps.budgetWindow]!

  test("the sleeve's window is 3x its cap: the 5,000 USDC caps of 3e4d1d49/4e2cf182 carry 15,000 a day", () => {
    expect(windowAt(5_000_000_000n)).toBe(15_000_000_000n)
  })

  test('at 7.4k USDC of depth the cap is 1,233.33 USDC (budget 3,700, half the depth); a deep pool keeps the cap', () => {
    const c = fitRemoteCap(5_000_000_000n, 7_400_000_000n, windowAt)
    expect(c).toBe(1_233_333_333n)
    expect(windowAt(c) <= 3_700_000_000n).toBe(true)
    expect(windowAt(c + 1n) > 3_700_000_000n).toBe(true)
    expect(fitRemoteCap(5_000_000_000n, 40_000_000_000n, windowAt)).toBe(5_000_000_000n)
    expect(fitRemoteCap(5_000_000_000n, 0n, windowAt)).toBe(0n)
  })
})

// otto/mamoru#410: MamoruActionPolicyV4 refuses a priced op worth more than 1/20 of the band depth (I2).
describe('the per-op room under MamoruActionPolicyV4', () => {
  test('is the depth V4 reads over 20, at 80%, so an op of that size passes `_requireDepth`', async () => {
    const c = client(10n ** 18n, { twapWindow: 0, perWindow: 0n })
    const depth = await readPoolDepth(c, POOL, 100, true, undefined, V4_MAX_DEPTH_STEPS)
    const room = await v4OpRoom(c, POOL, 100, true)
    expect(room).toBe((depth * 8_000n) / 200_000n)
    expect(room * V4_DEPTH_MULTIPLE).toBeLessThanOrEqual(depth)
    expect(c.calls).not.toContain('configOf')
  })
})
