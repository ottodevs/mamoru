import { describe, expect, test } from 'bun:test'
import { hexToBigInt, pad, toHex, type Hex } from 'viem'
import { address } from '@mamoru/registry'
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
  const slot = cumulativeLimitSlot(actionConfigId(ACCOUNT, PID, swap.targetAddress, swap.selector), address('SmartSession'), ACCOUNT, rule)
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
    expect(u.get(PID.toLowerCase())).toEqual({ used: 7, spentBps: 8_100 })
  })

  test('a read whose limits are not the signed ones is not used', async () => {
    expect((await readChainUsage(chain({ limit: 16n, used: 7n, spent: 0n }), ACCOUNT, [{ permissionId: PID, grant }])).size).toBe(0)
    expect((await readChainUsage(chain({ used: 7n, capWord: 1n, spent: 0n }), ACCOUNT, [{ permissionId: PID, grant }])).size).toBe(0)
    const failing = { readContract: async () => { throw new Error('rpc down') }, getStorageAt: async () => undefined }
    expect((await readChainUsage(failing as never, ACCOUNT, [{ permissionId: PID, grant }])).size).toBe(0)
  })

  test('the ids follow Smart Sessions: verified on Base for a live grant (limit 25,000,000 at the computed slot)', () => {
    expect(userOpConfigId(ACCOUNT, PID)).toMatch(/^0x[0-9a-f]{64}$/)
    expect(cumulativeLimitSlot(actionConfigId(ACCOUNT, PID, swap.targetAddress, swap.selector), address('SmartSession'), ACCOUNT, 1) - cumulativeLimitSlot(actionConfigId(ACCOUNT, PID, swap.targetAddress, swap.selector), address('SmartSession'), ACCOUNT, 0)).toBe(4n)
  })
})
