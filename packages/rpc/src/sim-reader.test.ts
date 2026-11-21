import { describe, expect, test } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { encodeFunctionResult, type Hex, type PublicClient } from 'viem'
import { ReasonError } from '@mamoru/domain'
import { address, monadRegistry } from '@mamoru/registry'
import { SIM_READER_CODE, decodeReaderRun, simReaderAbi, simulateFromEntryPoint, simulateUnserved } from './index.ts'

// otto/mamoru#429: since 20 Nov 2026 no reachable provider serves eth_simulateV1 on Monad. The same checks run by one
// eth_call with SimReader at the EntryPoint's address.
const SAFE = '0xD72A7cB9773Dc58a9B944f9737996F45dBD1F108'
const EP = address('EntryPointV07', monadRegistry)
const unserved = () => Object.assign(new Error('RPC Request failed.\nDetails: this request method is not supported'), { details: 'this request method is not supported' })

function reader(ok: boolean, before: bigint[], after: bigint[], ret: Hex = '0x') {
  return encodeFunctionResult({ abi: simReaderAbi, functionName: 'run', result: [ok, ret, 123_456n, before, after] })
}

function fakeClient(answer: (n: number) => Hex, sim: () => never = () => { throw unserved() }) {
  const seen: { call?: any; estimate?: unknown; simulations: number } = { simulations: 0 }
  const client = {
    request: async () => {
      seen.simulations++
      return sim()
    },
    call: async (args: any) => {
      seen.call = args
      return { data: answer(0) }
    },
    estimateGas: async (args: unknown) => {
      seen.estimate = args
      return 200_000n
    },
  } as unknown as PublicClient
  return { client, seen }
}

describe('simulateUnserved', () => {
  test('method missing, chain left out, plan or monthly cap: unserved', () => {
    for (const d of ['this request method is not supported', 'Method not found', 'eth_simulateV1 is not available on the MONAD_MAINNET', 'Monthly capacity limit exceeded.', 'available for paid plans only'])
      expect(simulateUnserved(new ReasonError('EHG_SIM_UNAVAILABLE', `RPC Request failed. (${d})`))).toBe(true)
  })
  test('a timeout, "sender not eoa" or another code is not', () => {
    expect(simulateUnserved(new ReasonError('EHG_SIM_UNAVAILABLE', 'The request took too long to respond.'))).toBe(false)
    expect(simulateUnserved(new ReasonError('EHG_SIM_UNAVAILABLE', 'Missing or invalid parameters. (sender not eoa)'))).toBe(false)
    expect(simulateUnserved(new ReasonError('OBS_RPC_UNAVAILABLE', 'Method not found'))).toBe(false)
    expect(simulateUnserved(new Error('Method not found'))).toBe(false)
  })
})

describe('simulateFromEntryPoint without eth_simulateV1', () => {
  test('the reader stands in: SimReader code at the EntryPoint, deltas and position count from its balances', async () => {
    const { client, seen } = fakeClient(() => {
      const tokens = tokensOf(seen.call.data)
      const before = Array.from({ length: tokens }, () => 10n)
      const after = before.map((b, i) => (i === 0 ? b + 5n : i === tokens - 1 ? b - 1n : b))
      return reader(true, before, after)
    })
    const sim = await simulateFromEntryPoint(client, SAFE, '0xabcd', 9n, monadRegistry)
    expect(seen.simulations).toBeGreaterThan(0)
    expect(seen.call.to).toBe(EP)
    expect(seen.call.stateOverride).toEqual([{ address: EP, code: SIM_READER_CODE }])
    expect(seen.call.blockNumber).toBe(9n)
    expect(sim.ok).toBe(true)
    expect(sim.logsRead).toBe(false)
    expect(sim.logs).toEqual([])
    expect(sim.nftDelta).toBe(-1n)
    expect(Object.values(sim.deltas).filter((v) => v !== 0n)).toEqual([5n])
    // Gas as on Monad today: eth_estimateGas from the EntryPoint at the head.
    expect(sim.gasUsed).toBe(200_000n)
    expect(seen.estimate).toMatchObject({ account: EP, to: SAFE, data: '0xabcd', blockTag: 'latest' })
  })
  test('a revert in the account reads as a revert, with its data, and no gas estimate', async () => {
    const { client, seen } = fakeClient(() => {
      const t = tokensOf(seen.call.data)
      return reader(false, Array(t).fill(1n), Array(t).fill(1n), '0x08c379a0')
    })
    const sim = await simulateFromEntryPoint(client, SAFE, '0x', 1n, monadRegistry)
    expect(sim.ok).toBe(false)
    expect(sim.revert).toBe('0x08c379a0')
    expect(seen.estimate).toBeUndefined()
  })
  test('a provider that serves eth_simulateV1 never reaches the reader', async () => {
    const { client, seen } = fakeClient(
      () => '0x',
      () => [{ calls: Array.from({ length: 64 }, () => ({ status: '0x1', returnData: '0x' + '00'.repeat(32), gasUsed: '0x5208', logs: [] })) }] as never,
    )
    const sim = await simulateFromEntryPoint(client, SAFE, '0x', 1n, monadRegistry)
    expect(seen.call).toBeUndefined()
    expect(sim.logsRead).toBeUndefined()
  })
  test('a timeout is not an unserved method: the error stands, no reader', async () => {
    const { client, seen } = fakeClient(() => '0x', () => { throw new Error('The request took too long to respond.') })
    await expect(simulateFromEntryPoint(client, SAFE, '0x', 1n, monadRegistry)).rejects.toThrow('EHG_SIM_UNAVAILABLE')
    expect(seen.call).toBeUndefined()
  })
})

describe('decodeReaderRun', () => {
  test('refuses an answer without one balance per token on both sides', () => {
    expect(() => decodeReaderRun(reader(true, [1n], [1n, 2n]), 2)).toThrow('EHG_SIM_UNAVAILABLE')
    expect(() => decodeReaderRun('0x', 1)).toThrow('EHG_SIM_UNAVAILABLE')
  })
})

describe('SIM_READER_CODE', () => {
  test('is the compiled runtime of contracts/sim-reader (when built)', () => {
    const artifact = join(import.meta.dir, '../../../contracts/sim-reader/out/SimReader.sol/SimReader.json')
    if (!existsSync(artifact)) return // forge build not run here; the PR states the command
    expect(JSON.parse(readFileSync(artifact, 'utf8')).deployedBytecode.object).toBe(SIM_READER_CODE)
  })
})

/** How many tokens the encoded run(account, tokens, callData) carries. */
function tokensOf(data: Hex): number {
  const body = `0x${data.slice(10)}` as Hex
  const tokensOffset = Number(BigInt(`0x${body.slice(2 + 64, 2 + 128)}`))
  return Number(BigInt(`0x${body.slice(2 + tokensOffset * 2, 2 + tokensOffset * 2 + 64)}`))
}
