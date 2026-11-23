import { describe, expect, test } from 'bun:test'
import type { PublicClient } from 'viem'
import { address, monadRegistry } from '@mamoru/registry'
import { SIM_CALL_GAS, simulateCalls, simulateFromEntryPoint } from './index.ts'

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

// otto/mamoru#452: anvil 1.10's eth_simulateV1 (probed on a Base fork, 23 Nov) answers a revert with returnData 0x and
// the revert bytes in error.data: {"returnData":"0x","status":"0x0","error":{"code":3,"message":"execution reverted: …","data":"0x…01"}}.
describe('simulateCalls: a revert carries its bytes in returnData, whichever field the node put them in', () => {
  const WORD = `0x${'00'.repeat(31)}01` as const
  const node = (call: Record<string, unknown>) => ({ request: async () => [{ calls: [{ gasUsed: '0x521a', logs: [], ...call }] }] }) as unknown as PublicClient
  test('anvil: returnData 0x, error.data the bytes', async () => {
    const [r] = await simulateCalls(node({ status: '0x0', returnData: '0x', error: { code: 3, message: 'execution reverted', data: WORD } }), [{ to: SAFE, data: '0x' }], 1n)
    expect(r).toMatchObject({ status: 'reverted', returnData: WORD, error: 'execution reverted' })
  })
  test('geth: the bytes already in returnData are kept; a success never takes error.data', async () => {
    const [g] = await simulateCalls(node({ status: '0x0', returnData: WORD, error: { message: 'execution reverted', data: '0xdead' } }), [{ to: SAFE, data: '0x' }], 1n)
    expect(g!.returnData).toBe(WORD)
    const [ok] = await simulateCalls(node({ status: '0x1', returnData: '0x', error: { message: 'x', data: WORD } }), [{ to: SAFE, data: '0x' }], 1n)
    expect(ok!.returnData).toBe('0x')
  })
  test('error.data that is not hex bytes is ignored', async () => {
    const [r] = await simulateCalls(node({ status: '0x0', returnData: '0x', error: { message: 'execution reverted', data: { reason: 'x' } } }), [{ to: SAFE, data: '0x' }], 1n)
    expect(r!.returnData).toBe('0x')
  })
})

test('simulateFromEntryPoint: a balance read that reverts counts as 0, whatever bytes its revert carries (#452)', async () => {
  const BIG = `0x${'ff'.repeat(32)}`
  const client = {
    request: async ({ params }: { params: unknown }) => {
      const calls = (params as [{ blockStateCalls: [{ calls: { data: string }[] }] }])[0].blockStateCalls[0].calls
      // The reads before the execution revert (revert bytes in error.data, as anvil answers); the reads after it read 0.
      const exec = calls.findIndex((c) => c.data === '0xabcd')
      const ok = { status: '0x1', returnData: `0x${'00'.repeat(32)}`, gasUsed: '0x5208', logs: [] }
      return [{ calls: calls.map((_c, i) => (i < exec ? { status: '0x0', returnData: '0x', gasUsed: '0x5208', logs: [], error: { message: 'execution reverted', data: BIG } } : ok)) }]
    },
  } as unknown as PublicClient
  const sim = await simulateFromEntryPoint(client, SAFE, '0xabcd', 1n, monadRegistry)
  expect(sim.ok).toBe(true)
  expect(Object.values(sim.deltas).every((d) => d === 0n)).toBe(true)
})
