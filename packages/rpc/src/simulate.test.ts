import { describe, expect, test } from 'bun:test'
import type { PublicClient } from 'viem'
import { address, monadRegistry } from '@mamoru/registry'
import { SIM_CALL_GAS, simulateFromEntryPoint } from './index.ts'

// otto/mamoru#260 (Brais's Monad Safe, 1 Nov): Monad's eth_simulateV1 refuses `"validation": false` and a sender with
// code, and reports the whole gas limit as gasUsed. The simulation from the EntryPoint must work there.
const SAFE = '0xD72A7cB9773Dc58a9B944f9737996F45dBD1F108'
const EP = address('EntryPointV07', monadRegistry)

function fakeClient(gasUsed: bigint, estimate = 176_081n, refusesContractSender = false) {
  const seen: { params?: unknown; estimate?: unknown; requests: number } = { requests: 0 }
  const client = {
    request: async ({ params }: { params: unknown }) => {
      seen.requests++
      seen.params = params
      const block = (params as [{ blockStateCalls: [{ stateOverrides?: unknown }] }])[0].blockStateCalls[0]
      if (refusesContractSender && !block.stateOverrides) throw Object.assign(new Error('Missing or invalid parameters.\nDetails: sender not eoa'), { details: 'sender not eoa' })
      const calls = (params as [{ blockStateCalls: [{ calls: unknown[] }] }])[0].blockStateCalls[0].calls
      return [{ calls: calls.map(() => ({ status: '0x1', returnData: '0x' + '00'.repeat(32), gasUsed: `0x${gasUsed.toString(16)}`, logs: [] })) }]
    },
    estimateGas: async (args: unknown) => {
      seen.estimate = args
      return estimate
    },
  } as unknown as PublicClient
  return { client, seen }
}

describe('simulateFromEntryPoint on a gas_limit chain (Monad)', () => {
  test('no explicit validation flag, and no state override where the plain call is accepted (Base)', async () => {
    const { client, seen } = fakeClient(90_000n)
    await simulateFromEntryPoint(client, SAFE, '0x', 1n, monadRegistry)
    const [opts] = seen.params as [{ validation?: unknown; blockStateCalls: [{ stateOverrides?: unknown }] }]
    expect('validation' in opts).toBe(false)
    expect(opts.blockStateCalls[0].stateOverrides).toBeUndefined()
    expect(seen.requests).toBe(1)
  })

  test('"sender not eoa" (Monad): retried once with the EntryPoint given no code in the simulated block', async () => {
    const { client, seen } = fakeClient(90_000n, 0n, true)
    const sim = await simulateFromEntryPoint(client, SAFE, '0x', 1n, monadRegistry)
    expect(sim.ok).toBe(true)
    expect(seen.requests).toBe(2)
    const [opts] = seen.params as [{ blockStateCalls: [{ stateOverrides?: Record<string, { code: string }> }] }]
    expect(opts.blockStateCalls[0].stateOverrides).toEqual({ [EP]: { code: '0x' } })
  })

  test('a gasUsed equal to the call limit is re-measured with eth_estimateGas from the EntryPoint', async () => {
    const { client, seen } = fakeClient(SIM_CALL_GAS)
    const sim = await simulateFromEntryPoint(client, SAFE, '0x1234', 7n, monadRegistry)
    expect(sim.gasUsed).toBe(176_081n)
    expect(seen.estimate).toMatchObject({ account: EP, to: SAFE, data: '0x1234', blockTag: 'latest' })
  })

  test('a real gasUsed (Base) is kept, with no estimate', async () => {
    const { client, seen } = fakeClient(85_165n)
    const sim = await simulateFromEntryPoint(client, SAFE, '0x', 1n, monadRegistry)
    expect(sim.gasUsed).toBe(85_165n)
    expect(seen.estimate).toBeUndefined()
  })
})
