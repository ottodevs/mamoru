// otto/mamoru#149: what each engine grant of an account has used, read from the chain, not from the operator's own
// records: a userOp sent with the session key by anyone (another bundler, a leaked key) counts here too.
import { encodeAbiParameters, encodePacked, hexToBigInt, keccak256, parseAbi, toHex, type Hex } from 'viem'
import type { Address } from '@mamoru/domain'
import { baseRegistry, address, type Registry } from '@mamoru/registry'
import type { SessionGrant } from '@mamoru/policy'
import { Batch, contractRead, multicall3Of, type Read } from '@mamoru/rpc'

const USAGE_LIMIT_ABI = parseAbi(['function usageLimitConfigs(bytes32 id, address multiplexer, address account) view returns (uint128 limit, uint128 used)'])

/**
 * `cumulative`: otto/mamoru#376, every cumulative rule of the grant as the chain holds it (limit as signed, used so far),
 * in rule order. Absent when the grant has none or a rule's read failed.
 */
export type ChainUsage = { used: number; spentBps: number | null; cumulative?: { limit: bigint; used: bigint }[] }

type Reader = {
  readContract(args: { address: Address; abi: typeof USAGE_LIMIT_ABI; functionName: 'usageLimitConfigs'; args: readonly [Hex, Address, Address]; blockNumber?: bigint }): Promise<readonly [bigint, bigint]>
  getStorageAt(args: { address: Address; slot: Hex; blockNumber?: bigint }): Promise<Hex | undefined>
  /** Present on a real client: the reads of a batch go through it as one Multicall3 call. */
  call?: unknown
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

/** What `readChainUsage` may be told: the Multicall3 of the chain (default: the registry's); null reads every counter on its own. */
export type ChainUsageOptions = { multicall3?: Address | null }

/**
 * Uses of every grant, and its fullest cumulative rule in basis points of its cap, as the chain counts them. A grant
 * whose read fails, or whose limit on chain is not the one it was signed with, is left out (the caller falls back
 * on its own count).
 *
 * The `usageLimitConfigs` reads of all grants go out as Multicall3.aggregate3 at the one block (a handful of requests
 * whatever the number of grants); a read that fails inside the batch is run again on its own and fails the same way
 * it would have alone. The cumulative rules' counters are storage slots: `eth_getStorageAt` cannot ride Multicall3.
 */
/** `blockNumber`: otto/mamoru#376, every counter read at that one block (absent: latest, as before). */
export async function readChainUsage(
  client: Reader,
  account: Address,
  grants: readonly { permissionId: Hex; grant: SessionGrant }[],
  registry: Registry = baseRegistry,
  blockNumber?: bigint,
  opts: ChainUsageOptions = {},
): Promise<Map<string, ChainUsage>> {
  const at = blockNumber === undefined ? {} : { blockNumber }
  const multiplexer = address('SmartSession', registry)
  const out = new Map<string, ChainUsage>()
  const configs = await readConfigs(client, account, grants, registry, multiplexer, blockNumber, opts.multicall3 === undefined ? multicall3Of(registry) : opts.multicall3)
  await Promise.all(
    grants.map(async (g, gi) => {
      try {
        const [limit, used] = await configs[gi]!.need()
        if (limit !== BigInt(g.grant.userOp.usageLimit)) return
        let spentBps: number | null = null
        const cumulative: { limit: bigint; used: bigint }[] = []
        for (const a of g.grant.actions) {
          for (const [ri, rule] of a.params.entries()) {
            if (rule.cumulativeLimit === undefined) continue
            const slot = cumulativeLimitSlot(actionConfigId(account, g.permissionId, a.targetAddress, a.selector), multiplexer, account, ri)
            const policy = address('UniActionPolicy', registry)
            const [l, u] = await Promise.all([
              client.getStorageAt({ address: policy, slot: toHex(slot, { size: 32 }), ...at }),
              client.getStorageAt({ address: policy, slot: toHex(slot + 1n, { size: 32 }), ...at }),
            ])
            if (!l || !u || hexToBigInt(l) !== rule.cumulativeLimit) return
            cumulative.push({ limit: rule.cumulativeLimit, used: hexToBigInt(u) })
            const bps = rule.cumulativeLimit === 0n ? 10_000 : Number((hexToBigInt(u) * 10_000n) / rule.cumulativeLimit)
            spentBps = Math.max(spentBps ?? 0, bps)
          }
        }
        out.set(g.permissionId.toLowerCase(), { used: Number(used), spentBps, ...(cumulative.length ? { cumulative } : {}) })
      } catch {
        // Unread: the caller keeps its own count for this grant.
      }
    }),
  )
  return out
}

/**
 * `usageLimitConfigs` of every grant at one block, through Multicall3 when the client can `call` and the chain pins one.
 * When the batch request itself fails, each read goes out on its own, as before batching: one bad answer never costs
 * the others.
 */
async function readConfigs(client: Reader, account: Address, grants: readonly { permissionId: Hex; grant: SessionGrant }[], registry: Registry, multiplexer: Address, blockNumber: bigint | undefined, multicall3: Address | null) {
  const policy = address('UsageLimitPolicy', registry)
  const reads = (batch: Batch) =>
    grants.map((g) => batch.add(contractRead(client as never, { address: policy, abi: USAGE_LIMIT_ABI, functionName: 'usageLimitConfigs', args: [userOpConfigId(account, g.permissionId), multiplexer, account], ...(blockNumber === undefined ? {} : { blockNumber }) } as never) as Read<readonly [bigint, bigint]>))
  if (multicall3 !== null && typeof (client as { call?: unknown }).call === 'function') {
    const batch = new Batch(client as never, multicall3, blockNumber)
    const handles = reads(batch)
    try {
      await batch.run()
      return handles
    } catch {
      // The aggregate request failed (provider error, oversized answer): fall through to one read per grant.
    }
  }
  const alone = new Batch(client as never, null, blockNumber)
  const handles = reads(alone)
  await alone.run()
  return handles
}

const POLICY_BUDGET_ABI = parseAbi([
  'struct Config { uint32 twapWindow; uint32 twapShortWindow; uint24 bandTicks; uint64 generation; bool budgetIn1; uint32 budgetWindow; int24 anchorTick; uint24 anchorBand; uint128 perWindow; uint128 total; bytes32 initHash; }',
  'function configOf(address account, address pool) view returns (Config)',
  'function budgetLeft(address account, address pool) view returns (uint256 window, uint256 total)',
  'function generationOf(address account) view returns (uint64)',
])

type BudgetReader = {
  readContract(args: { address: Address; abi: typeof POLICY_BUDGET_ABI; functionName: 'configOf' | 'budgetLeft' | 'generationOf'; args: readonly unknown[] }): Promise<unknown>
}

/**
 * Spec 007 T7 (e): how much of each pool's per-approval budget (T_p, `Init.total`) MamoruActionPolicy has charged,
 * in bps, as the chain counts it (every call charged at validation, by anyone holding the key). Keyed by registry pool
 * name. A pool whose config is not at the account's current generation (retired, or never enabled), or whose read
 * fails, is left out: the caller then shows nothing for it, as before.
 */
export async function readPolicyBudgets(client: BudgetReader, policy: Address, account: Address, pools: readonly { name: string; address: Address }[], usedBps: (total: bigint, left: bigint) => number): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  let generation: bigint
  try {
    generation = (await client.readContract({ address: policy, abi: POLICY_BUDGET_ABI, functionName: 'generationOf', args: [account] })) as bigint
  } catch {
    return out
  }
  await Promise.all(
    pools.map(async (p) => {
      try {
        const [c, left] = await Promise.all([
          client.readContract({ address: policy, abi: POLICY_BUDGET_ABI, functionName: 'configOf', args: [account, p.address] }) as Promise<{ generation: bigint; total: bigint }>,
          client.readContract({ address: policy, abi: POLICY_BUDGET_ABI, functionName: 'budgetLeft', args: [account, p.address] }) as Promise<readonly [bigint, bigint]>,
        ])
        if (c.total === 0n || c.generation !== generation) return
        out.set(p.name, usedBps(c.total, left[1]))
      } catch {
        // Unread: nothing shown for this pool.
      }
    }),
  )
  return out
}
