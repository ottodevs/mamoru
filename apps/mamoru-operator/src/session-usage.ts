// otto/mamoru#149: what each engine grant of an account has used, read from the chain, not from the operator's own
// records: a userOp sent with the session key by anyone (another bundler, a leaked key) counts here too.
import { encodeAbiParameters, encodePacked, hexToBigInt, keccak256, parseAbi, toHex, type Hex } from 'viem'
import type { Address } from '@mamoru/domain'
import { address } from '@mamoru/registry'
import type { SessionGrant } from '@mamoru/policy'

const USAGE_LIMIT_ABI = parseAbi(['function usageLimitConfigs(bytes32 id, address multiplexer, address account) view returns (uint128 limit, uint128 used)'])

export type ChainUsage = { used: number; spentBps: number | null }

type Reader = {
  readContract(args: { address: Address; abi: typeof USAGE_LIMIT_ABI; functionName: 'usageLimitConfigs'; args: readonly [Hex, Address, Address] }): Promise<readonly [bigint, bigint]>
  getStorageAt(args: { address: Address; slot: Hex }): Promise<Hex | undefined>
}

/** Smart Sessions IdLib: a userOp policy's config id is keccak(account, permissionId). */
export function userOpConfigId(account: Address, permissionId: Hex): Hex {
  return keccak256(encodePacked(['address', 'bytes32'], [account, permissionId]))
}

/** An action policy's config id: keccak(account, keccak(permissionId, keccak(target, selector))). */
export function actionConfigId(account: Address, permissionId: Hex, target: Address, selector: Hex): Hex {
  const actionId = keccak256(encodePacked(['address', 'bytes4'], [target, selector]))
  return keccak256(encodePacked(['address', 'bytes32'], [account, keccak256(encodePacked(['bytes32', 'bytes32'], [permissionId, actionId]))]))
}

const slotOf = (key: Hex | Address, type: 'bytes32' | 'address', slot: bigint) => hexToBigInt(keccak256(encodeAbiParameters([{ type }, { type: 'uint256' }], [key as never, slot])))

/**
 * Storage slot of rule `rule`'s `usage.limit` in UniActionPolicy (`used` is the next one): `actionConfigs` is slot 0,
 * keyed configId > multiplexer > account; an ActionConfig is valueLimitPerUse, paramRules.length, then 4 slots per
 * rule (condition/offset/isLimited, ref, usage.limit, usage.used). Checked on Base on 2026-10-16 against a live
 * enter-swap grant (length 7, limit 25,000,000 as signed). Each read is checked again: the limit word must be the
 * signed limit, or the read is not used.
 */
export function cumulativeLimitSlot(configId: Hex, multiplexer: Address, account: Address, rule: number): bigint {
  const base = slotOf(account, 'address', slotOf(multiplexer, 'address', slotOf(configId, 'bytes32', 0n)))
  return base + 2n + 4n * BigInt(rule) + 2n
}

/**
 * Uses of every grant, and its fullest cumulative rule in basis points of its cap, as the chain counts them. A grant
 * whose read fails, or whose limit on chain is not the one it was signed with, is left out (the caller falls back
 * on its own count).
 */
export async function readChainUsage(client: Reader, account: Address, grants: readonly { permissionId: Hex; grant: SessionGrant }[]): Promise<Map<string, ChainUsage>> {
  const multiplexer = address('SmartSession')
  const out = new Map<string, ChainUsage>()
  await Promise.all(
    grants.map(async (g) => {
      try {
        const [limit, used] = await client.readContract({ address: address('UsageLimitPolicy'), abi: USAGE_LIMIT_ABI, functionName: 'usageLimitConfigs', args: [userOpConfigId(account, g.permissionId), multiplexer, account] })
        if (limit !== BigInt(g.grant.userOp.usageLimit)) return
        let spentBps: number | null = null
        for (const a of g.grant.actions) {
          for (const [ri, rule] of a.params.entries()) {
            if (rule.cumulativeLimit === undefined) continue
            const slot = cumulativeLimitSlot(actionConfigId(account, g.permissionId, a.targetAddress, a.selector), multiplexer, account, ri)
            const [l, u] = await Promise.all([client.getStorageAt({ address: address('UniActionPolicy'), slot: toHex(slot, { size: 32 }) }), client.getStorageAt({ address: address('UniActionPolicy'), slot: toHex(slot + 1n, { size: 32 }) })])
            if (!l || !u || hexToBigInt(l) !== rule.cumulativeLimit) return
            const bps = rule.cumulativeLimit === 0n ? 10_000 : Number((hexToBigInt(u) * 10_000n) / rule.cumulativeLimit)
            spentBps = Math.max(spentBps ?? 0, bps)
          }
        }
        out.set(g.permissionId.toLowerCase(), { used: Number(used), spentBps })
      } catch {
        // Unread: the caller keeps its own count for this grant.
      }
    }),
  )
  return out
}
