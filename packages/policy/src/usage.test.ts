import { describe, expect, test } from 'bun:test'
import { conservadorLiveV2, grantKey, instantiateGrant, MAX_USAGE_LIMIT, usageLimitFor, type GrantTemplate } from './index.ts'

const USDC = 1_000_000n
const g = (key: string) => conservadorLiveV2.session.grants.find((x) => grantKey(x) === key)!
const ctx = (capUsdc?: bigint) => ({
  account: '0x000000000000000000000000000000000000dEaD' as const,
  sessionKey: '0x000000000000000000000000000000000000bEEF' as const,
  chainId: 8453,
  salt: `0x${'11'.repeat(32)}` as const,
  validAfter: 0,
  validUntil: 1,
  caps: Object.fromEntries(conservadorLiveV2.session.caps.map((c) => [c.name, 1n])),
  ...(capUsdc === undefined ? {} : { capUsdc }),
})

describe('usage limits sized for a year at the account cap (#149)', () => {
  test('convert-any follows the account cap, tier by tier, and stays at the last one above them', () => {
    const t = g('convert-any:pool:USDC/cbBTC/500')
    expect(usageLimitFor(t, 100n * USDC)).toBe(1_000)
    expect(usageLimitFor(t, 1_000n * USDC)).toBe(1_000)
    expect(usageLimitFor(t, 1_000n * USDC + 1n)).toBe(6_000)
    expect(usageLimitFor(t, 100_000n * USDC)).toBe(32_000)
    expect(usageLimitFor(t, 1_000_000n * USDC)).toBe(75_000)
    expect(usageLimitFor(t, 5_000_000n * USDC)).toBe(75_000)
    // No cap given: the first tier, never more.
    expect(usageLimitFor(t)).toBe(1_000)
  })

  test('the other live grants have one limit for every cap, all far above 2.0.0', () => {
    for (const pool of ['pool:USDC/USDT/100', 'pool:USDC/cbBTC/500', 'pool:WETH/USDC/3000']) {
      expect(usageLimitFor(g(`manage-any:${pool}`), 1_000_000n * USDC)).toBe(2_500)
      expect(usageLimitFor(g(`enter-swap:${pool}`), 1_000_000n * USDC)).toBe(3_000)
      expect(usageLimitFor(g(`enter-mint:${pool}`), 1_000_000n * USDC)).toBe(1_000)
    }
  })

  test('the signed grant carries the limit of its cap', () => {
    expect(instantiateGrant(conservadorLiveV2, 'convert-any:pool:WETH/USDC/3000', ctx(100_000n * USDC)).userOp.usageLimit).toBe(32_000)
    expect(instantiateGrant(conservadorLiveV2, 'convert-any:pool:WETH/USDC/3000', ctx()).userOp.usageLimit).toBe(1_000)
  })

  test('a limit over the hard ceiling is refused, whatever the tiers say', () => {
    const over: GrantTemplate = { ...g('convert-any:pool:USDC/cbBTC/500'), usageByCap: [{ upToUsdc: 1n, usageLimit: MAX_USAGE_LIMIT + 1 }] }
    expect(() => usageLimitFor(over, 1n)).toThrow(/outside 1\.\.100000/)
    for (const t of conservadorLiveV2.session.grants) for (const cap of [1n, 10n ** 15n]) expect(usageLimitFor(t, cap)).toBeLessThanOrEqual(MAX_USAGE_LIMIT)
  })

  test('entry swap totals are 3 times the 2.0.0 share, renewed from the row; per-call caps unchanged', () => {
    const bps = (name: string) => conservadorLiveV2.session.caps.find((c) => c.name === name)!.bpsOfDeposit
    expect([bps('stablesSwapTotal'), bps('btcSwapTotal'), bps('riskSwapTotal')]).toEqual([30_000, 24_000, 12_000])
    expect([bps('stablesSwapPerCall'), bps('btcSwapPerCall'), bps('riskSwapPerCall')]).toEqual([5_000, 4_000, 2_000])
    expect([bps('stablesMint0'), bps('btcMint0'), bps('riskMint0')]).toEqual([10_000, 8_000, 4_000])
  })
})
