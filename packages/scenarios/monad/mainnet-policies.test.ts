import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, keccak256, type Hex } from 'viem'
import { moduleRegistryAbi } from '@mamoru/registry'
import { ARACHNID_DEPLOYER, MODULE_REGISTRY, MULTICALL3, multicall3Abi, RESOLVER_UID, ZERO_UID, formatMon, gasLimitFor, planPolicy, policySpecs, predictAddress, totalCost, type CostLine } from './mainnet-policies.ts'

// The plan only hashes the code it finds: the "deployed" cases use a spec whose codeHash is a stand-in runtime's.
const RUNTIME = '0x6080604052' as Hex

describe('#62 Monad mainnet policy plan', () => {
  const specs = policySpecs()

  test('both Base policies, each CREATE2-predicted at its Base address', () => {
    expect(specs.map((s) => s.name)).toEqual(['TimeFramePolicy', 'UsageLimitPolicy'])
    expect(specs.map((s) => s.address)).toEqual(['0x8177451511dE0577b911C254E9551D981C26dc72', '0x1F34eF8311345A3A4a4566aF321b313052F51493'])
    for (const s of specs) expect(predictAddress(ARACHNID_DEPLOYER, s.input)).toBe(s.address)
  })

  test('empty chain: ONE Multicall3.aggregate3 tx, deploy then register, neither allowed to fail', () => {
    const s = specs[0]!
    const p = planPolicy(s, { code: '0x', resolverUID: ZERO_UID })
    expect(p.steps.map((x) => x.kind)).toEqual(['deploy+register'])
    expect(p.steps[0]!.to).toBe(MULTICALL3)
    const agg = decodeFunctionData({ abi: multicall3Abi, data: p.steps[0]!.data })
    expect(agg.functionName).toBe('aggregate3')
    const calls = agg.args[0]
    expect(calls.map((c) => [c.target, c.allowFailure])).toEqual([[ARACHNID_DEPLOYER, false], [MODULE_REGISTRY, false]])
    expect(calls[0]!.callData).toBe(s.input)
    const d = decodeFunctionData({ abi: moduleRegistryAbi, data: calls[1]!.callData })
    expect(d.functionName).toBe('registerModule')
    expect(d.args).toEqual([RESOLVER_UID, s.address, '0x', '0x'])
  })

  test('idempotent: Base code present skips the deploy, a Base record skips the register', () => {
    const s = { ...specs[1]!, codeHash: keccak256(RUNTIME) }
    const reg = planPolicy(s, { code: RUNTIME, resolverUID: ZERO_UID }).steps
    expect(reg.map((x) => [x.kind, x.to])).toEqual([['register', MODULE_REGISTRY]])
    expect(decodeFunctionData({ abi: moduleRegistryAbi, data: reg[0]!.data }).args).toEqual([RESOLVER_UID, s.address, '0x', '0x'])
    const done = planPolicy(s, { code: RUNTIME, resolverUID: RESOLVER_UID })
    expect(done.steps).toEqual([])
    expect([done.deployed, done.registered]).toEqual([true, true])
  })

  test('fails closed on foreign code or a record under another resolver', () => {
    const s = specs[0]!
    expect(() => planPolicy(s, { code: RUNTIME, resolverUID: ZERO_UID })).toThrow(/not Base's/)
    const ok = { ...s, codeHash: keccak256(RUNTIME) }
    expect(() => planPolicy(ok, { code: RUNTIME, resolverUID: `0x${'11'.repeat(32)}` })).toThrow(/resolver/)
  })

  test('cost is gas LIMIT x price; the limit carries a margin over the estimate', () => {
    expect(gasLimitFor(100_000n)).toBe(120_000n)
    const step = planPolicy(specs[0]!, { code: '0x', resolverUID: ZERO_UID }).steps[0]!
    const lines: CostLine[] = [
      { step, estimate: 100_000n, limit: 120_000n },
      { step, estimate: 50_000n, limit: 62_500n },
    ]
    expect(totalCost(lines, 100n * 10n ** 9n)).toBe(182_500n * 100n * 10n ** 9n)
    expect(formatMon(191_492_000_000_000_000n)).toBe('0.191492')
    expect(formatMon(10n ** 18n)).toBe('1.000000')
  })
})
