import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, encodeFunctionResult, hexToBigInt, pad, parseAbi, toHex, type Hex } from 'viem'
import { multicall3Abi, multicall3Of } from '@mamoru/rpc'
import { baseRegistry, address } from '@mamoru/registry'
import { conservadorLiveV2, instantiateGrant } from '@mamoru/policy'
import { actionConfigId, cumulativeLimitSlot, readChainUsage, userOpConfigId } from '../src/session-usage.ts'

const ACCOUNT = '0x5af19C48077D38F10B4245a6B2D92478aaEFAcD0' as const
const PID = `0x${'ab'.repeat(32)}` as Hex
const caps = Object.fromEntries(conservadorLiveV2.session.caps.map((c) => [c.name, 100_000_000n]))
const grant = instantiateGrant(conservadorLiveV2, 'enter-swap:pool:USDC/USDT/100', { account: ACCOUNT, sessionKey: ACCOUNT, chainId: 8453, salt: PID, validAfter: 0, validUntil: 1, caps, capUsdc: 100_000_000n })
const swap = grant.actions.find((a) => a.signature.startsWith('exactInputSingle'))!
const rule = swap.params.findIndex((p) => p.cumulativeLimit !== undefined)

/** A chain that holds `used` userOps and `spent` of the swap total for the grant, at the slots Smart Sessions uses. */
function chain(o: { limit?: bigint; used: bigint; capWord?: bigint; spent: bigint }) {
  const slot = cumulativeLimitSlot(actionConfigId(ACCOUNT, PID, swap.targetAddress, swap.selector), address('SmartSession', baseRegistry), ACCOUNT, rule)
  const words = new Map<bigint, bigint>([[slot, o.capWord ?? swap.params[rule]!.cumulativeLimit!], [slot + 1n, o.spent]])
  return {
    async readContract(a: { args: readonly [Hex, string, string] }) {
      if (a.args[0] !== userOpConfigId(ACCOUNT, PID)) throw new Error('unknown config id')
      return [o.limit ?? BigInt(grant.userOp.usageLimit), o.used] as const
    },
    async getStorageAt(a: { slot: Hex }) {
      return pad(toHex(words.get(hexToBigInt(a.slot)) ?? 0n), { size: 32 })
    },
  }
}

describe('usage counters read from the chain (#149)', () => {
  test('uses and the share of the swap total, as the chain counts them', async () => {
    const total = swap.params[rule]!.cumulativeLimit!
    const u = await readChainUsage(chain({ used: 7n, spent: (total * 81n) / 100n }), ACCOUNT, [{ permissionId: PID, grant }])
    expect(u.get(PID.toLowerCase())).toEqual({ used: 7, spentBps: 8_100, cumulative: [{ limit: total, used: (total * 81n) / 100n }] })
  })

  test('a read whose limits are not the signed ones is not used', async () => {
    expect((await readChainUsage(chain({ limit: 16n, used: 7n, spent: 0n }), ACCOUNT, [{ permissionId: PID, grant }])).size).toBe(0)
    expect((await readChainUsage(chain({ used: 7n, capWord: 1n, spent: 0n }), ACCOUNT, [{ permissionId: PID, grant }])).size).toBe(0)
    const failing = { readContract: async () => { throw new Error('rpc down') }, getStorageAt: async () => undefined }
    expect((await readChainUsage(failing as never, ACCOUNT, [{ permissionId: PID, grant }])).size).toBe(0)
  })

  test('the ids follow Smart Sessions: verified on Base for a live grant (limit 25,000,000 at the computed slot)', () => {
    expect(userOpConfigId(ACCOUNT, PID)).toMatch(/^0x[0-9a-f]{64}$/)
    expect(cumulativeLimitSlot(actionConfigId(ACCOUNT, PID, swap.targetAddress, swap.selector), address('SmartSession', baseRegistry), ACCOUNT, 1) - cumulativeLimitSlot(actionConfigId(ACCOUNT, PID, swap.targetAddress, swap.selector), address('SmartSession', baseRegistry), ACCOUNT, 0)).toBe(4n)
  })
})

// Batching: the usageLimitConfigs reads of all grants go out as Multicall3, with the results unchanged.
const USAGE_ABI = parseAbi(['function usageLimitConfigs(bytes32 id, address multiplexer, address account) view returns (uint128 limit, uint128 used)'])
const PIDS = [1, 2, 3].map((n) => `0x${n.toString(16).padStart(2, '0').repeat(32)}` as Hex)
const grantOf = (pid: Hex) => instantiateGrant(conservadorLiveV2, 'enter-swap:pool:USDC/USDT/100', { account: ACCOUNT, sessionKey: ACCOUNT, chainId: 8453, salt: pid, validAfter: 0, validUntil: 1, caps, capUsdc: 100_000_000n })
const GRANTS = PIDS.map((permissionId) => ({ permissionId, grant: grantOf(permissionId) }))

/** A chain with `usageLimitConfigs` and the cumulative slots of every PIDS grant; counts each kind of request. */
function batchedChain(o: { unknown?: Hex; batchFails?: boolean; withCall?: boolean; capWord?: bigint } = {}) {
  const counts = { call: 0, readContract: 0, getStorageAt: 0, inner: 0 }
  const words = new Map<bigint, bigint>()
  for (const g of GRANTS) {
    const sw = g.grant.actions.find((a) => a.signature.startsWith('exactInputSingle'))!
    const r = sw.params.findIndex((p) => p.cumulativeLimit !== undefined)
    const slot = cumulativeLimitSlot(actionConfigId(ACCOUNT, g.permissionId, sw.targetAddress, sw.selector), address('SmartSession', baseRegistry), ACCOUNT, r)
    words.set(slot, o.capWord ?? sw.params[r]!.cumulativeLimit!)
    words.set(slot + 1n, 1_000_000n)
  }
  const answer = (args: readonly [Hex, string, string]): readonly [bigint, bigint] => {
    if (o.unknown && args[0] === userOpConfigId(ACCOUNT, o.unknown)) throw new Error('unknown config id')
    return [BigInt(GRANTS[0]!.grant.userOp.usageLimit), 5n] as const
  }
  const client = {
    async readContract(a: { args: readonly [Hex, string, string] }) {
      counts.readContract++
      return answer(a.args)
    },
    async getStorageAt(a: { slot: Hex }) {
      counts.getStorageAt++
      return pad(toHex(words.get(hexToBigInt(a.slot)) ?? 0n), { size: 32 })
    },
    ...(o.withCall === false
      ? {}
      : {
          async call(a: { to: string; data: Hex }) {
            counts.call++
            if (o.batchFails) throw new Error('aggregate refused')
            expect(a.to.toLowerCase()).toBe(multicall3Of(baseRegistry)!.toLowerCase())
            const { args } = decodeFunctionData({ abi: multicall3Abi, data: a.data })
            const results = (args![0] as readonly { callData: Hex }[]).map((c) => {
              counts.inner++
              const inner = decodeFunctionData({ abi: USAGE_ABI, data: c.callData })
              try {
                return { success: true, returnData: encodeFunctionResult({ abi: USAGE_ABI, functionName: 'usageLimitConfigs', result: answer(inner.args as never) }) }
              } catch {
                return { success: false, returnData: '0x' as Hex }
              }
            })
            return { data: encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results }) }
          },
        }),
  }
  return { client, counts }
}

describe('usage counters through Multicall3', () => {
  const direct = async () => {
    const d = batchedChain({ withCall: false })
    return { u: await readChainUsage(d.client as never, ACCOUNT, GRANTS), counts: d.counts }
  }

  test('every usageLimitConfigs read rides one aggregate3, with the same result as one read each', async () => {
    const alone = await direct()
    expect(alone.counts.readContract).toBe(3)
    const b = batchedChain()
    const u = await readChainUsage(b.client as never, ACCOUNT, GRANTS)
    expect(b.counts).toMatchObject({ call: 1, inner: 3, readContract: 0 })
    expect(u).toEqual(alone.u)
    expect(u.size).toBe(3)
  })

  test('a read that fails inside the batch fails alone: that grant is left out, the others stay', async () => {
    const b = batchedChain({ unknown: PIDS[1]! })
    const u = await readChainUsage(b.client as never, ACCOUNT, GRANTS)
    expect([...u.keys()].sort()).toEqual([PIDS[0]!, PIDS[2]!])
    expect(b.counts.readContract).toBe(1)
  })

  test('a grant whose read cannot be built (malformed permission id) is left out alone, the others stay', async () => {
    const bad = { ...GRANTS[1]!, permissionId: '0x1234' as Hex }
    for (const withCall of [true, false]) {
      const b = batchedChain({ withCall })
      const u = await readChainUsage(b.client as never, ACCOUNT, [GRANTS[0]!, bad, GRANTS[2]!])
      expect([...u.keys()].sort()).toEqual([PIDS[0]!, PIDS[2]!])
    }
  })

  test('when the batch request itself fails, each read goes out on its own', async () => {
    const b = batchedChain({ batchFails: true })
    const u = await readChainUsage(b.client as never, ACCOUNT, GRANTS)
    expect(b.counts).toMatchObject({ call: 1, readContract: 3 })
    expect(u).toEqual((await direct()).u)
  })

  test('a limit word on chain that is not the signed one still leaves the grant out', async () => {
    const b = batchedChain({ capWord: 1n })
    expect((await readChainUsage(b.client as never, ACCOUNT, GRANTS)).size).toBe(0)
  })

  test('both slots of every cumulative rule are read on every round, nothing is kept between rounds', async () => {
    const b = batchedChain()
    const first = await readChainUsage(b.client as never, ACCOUNT, GRANTS)
    expect(b.counts.getStorageAt).toBe(6)
    const second = await readChainUsage(b.client as never, ACCOUNT, GRANTS)
    expect(b.counts.getStorageAt).toBe(12)
    expect(second).toEqual(first)
  })
})
