// otto/mamoru#293, spec 010 (one authorization): the policy of an account whose ONE session per chain is a fallback
// action with MamoruActionPolicyV4 as its only action policy and MamoruGasPolicyV2 as its only userOp policy. The owner
// signs the rules once (InitV4: C, the generation, and for a remote Safe its home); which pools and vaults the engine
// may use follow from V4's own rules over MamoruV4Table (spec 010 A1: pool classes, reference pools, the exact vault
// list, all in code; no registry, no admin, no guardian), never from owner-signed data. Nothing here is live until the
// `one_auth_v4` ops flag is on for an account AND the stack is pinned in the chain's registry file (the registry files
// list A1's contracts under `undeployed` until T8 deploys them: fail closed). T7, the guardian-era stack deployed on
// 2 Nov, is retired unused (otto/mamoru#348): its addresses are under `retired`, never here.
import { decodeAbiParameters, encodeAbiParameters, getAddress, type Hex } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, entry, isDeployed, type Registry, type RegistryEntry, type RegistryName } from '@mamoru/registry'
import { conservadorLiveV6 } from './policies-v6.ts'
import { liveWmonUsdcMonadV6 } from './policies-monad.ts'
import type { GasCaps, GrantTemplate, PolicyVersion } from './types.ts'
import { POLICY_INCREASE_SIG } from './v4-grants.ts'

/** The home account's policy id once it runs on V4. */
export const ONE_AUTH_V4 = 'one-auth-v4'
/** The policy id of a V4 remote Safe (its Init names its home), the RemoteSpec's `policyId`. */
export const ONE_AUTH_V4_REMOTE = 'one-auth-v4-remote'

/**
 * The contracts of spec 010 A1 (contracts/action-policy/script/DeployV4.s.sol), by registry name. All four must be
 * pinned on a chain before anything V4 runs there. MamoruV4Table is the per-chain table V4 and the gas policy read
 * (pool classes, reference pools, vaults); the operator reads it too, to list the candidate pools.
 */
export const ONE_AUTH_V4_CONTRACTS = ['MamoruActionPolicyV4', 'MamoruGasPolicyV2', 'MamoruMigrationCheck', 'MamoruV4Table'] as const
export type OneAuthV4Contract = (typeof ONE_AUTH_V4_CONTRACTS)[number]

/** The deployed V4 stack of one chain (same CREATE2 addresses on every chain, contracts notice). */
export type OneAuthV4Deployment = { policy: Address; gasPolicy: Address; migrationCheck: Address; table: Address }

/**
 * The V4 stack pinned in `registry`, or null when any of the four is not (an `undeployed` name, or absent). The
 * `one_auth_v4` flag is never honoured on a chain where this is null.
 */
export function oneAuthV4Deployment(registry: Registry): OneAuthV4Deployment | null {
  if (!ONE_AUTH_V4_CONTRACTS.every((n) => isDeployed(n, registry))) return null
  const a = (n: OneAuthV4Contract) => address(n, registry)
  const d = { policy: a('MamoruActionPolicyV4'), gasPolicy: a('MamoruGasPolicyV2'), migrationCheck: a('MamoruMigrationCheck'), table: a('MamoruV4Table') }
  if (Object.values(d).some((x) => BigInt(x) === 0n)) return null
  return d
}

/** A policy id of spec 010 (home or remote). */
export function isOneAuthV4(p: Pick<PolicyVersion, 'policyId'> | string | undefined): boolean {
  const id = typeof p === 'string' ? p : p?.policyId
  return id === ONE_AUTH_V4 || id === ONE_AUTH_V4_REMOTE || id === `${ONE_AUTH_V4}-lab` || id === `${ONE_AUTH_V4_REMOTE}-lab`
}

// ---- InitV4 (MamoruActionPolicyV4.sol `struct InitV4`, field for field) ------------------------------------------

export type InitV4 = { capUsd: bigint; generation: bigint; home: Address; homeDomain: number; admit: readonly bigint[] }

export const INIT_V4_TUPLE = [
  {
    type: 'tuple',
    components: [
      { name: 'capUsd', type: 'uint128' },
      { name: 'generation', type: 'uint64' },
      { name: 'home', type: 'address' },
      { name: 'homeDomain', type: 'uint32' },
      { name: 'admit', type: 'uint256[]' },
    ],
  },
] as const

/**
 * otto/mamoru#293 (review of #202, P1-11): the C an account's InitV4 carries on a chain, from the same values the "What's
 * new" lines state: the account's USDC cap x the chain's share of the policy split (Base 85 %, Monad 15 % for one-auth-v4)
 * x V4_CAP_MULTIPLE_BPS. V4 charges every swap, mint and increase against C per day and pauses past C in 24 h; placing a
 * deposit is a swap of about half and a mint of all of it (1.5x the chain's share), so the multiple must stay above 1.5:
 * 2x (pending Ot's decision; spec 010 open question 4). Charging an entry once (net) instead of per call needs a V4 change.
 * A remote Safe's C is not this: V4 gives a remote its home's C at registerRemote (contract, MamoruV4Helper.remote).
 */
export const V4_CAP_MULTIPLE_BPS = 20_000

/** The chain's share of the policy split, bps: its local buckets' preference (home) or its remote buckets' (a remote chain). */
export function v4ChainShareBps(policy: Pick<PolicyVersion, 'buckets' | 'remoteBuckets'>, chainId: number, homeChainId = 8453): number {
  const total = policy.buckets.reduce((s, b) => s + b.preference, 0) + (policy.remoteBuckets ?? []).reduce((s, b) => s + b.preference, 0)
  if (total <= 0) return 0
  const mine = chainId === homeChainId ? policy.buckets.reduce((s, b) => s + b.preference, 0) : (policy.remoteBuckets ?? []).filter((b) => b.chainId === chainId).reduce((s, b) => s + b.preference, 0)
  return Math.floor((mine * 10_000) / total)
}

/** InitV4.capUsd of the home account on `chainId` (USD units, 6 decimals) for an account cap of `accountCapUsdc`. */
export function v4CapUsdOf(accountCapUsdc: bigint, policy: Pick<PolicyVersion, 'buckets' | 'remoteBuckets'> = oneAuthV4LiveSplit, chainId = 8453, multipleBps = V4_CAP_MULTIPLE_BPS): bigint {
  return (accountCapUsdc * BigInt(v4ChainShareBps(policy, chainId)) * BigInt(multipleBps)) / 100_000_000n
}

/** V4's rolling 30-day cap: CAP30_MULTIPLE x C (contract constant). */
export const V4_CAP30_MULTIPLE = 3n

/** one-auth-v4's split (Base 50 + 35, Monad 15), for v4CapUsdOf's default. */
const oneAuthV4LiveSplit = { buckets: [{ preference: 5000 }, { preference: 3500 }], remoteBuckets: [{ preference: 1500, chainId: 143 }] } as unknown as Pick<PolicyVersion, 'buckets' | 'remoteBuckets'>

/** V4's MAX_ADMIT, MAX_CAP_USD and MAX_FIRST_GENERATION (LeftClaw H-1). */
export const V4_MAX_ADMIT = 64
export const V4_MAX_CAP_USD = 10n ** 15n
export const V4_MAX_FIRST_GENERATION = 65_535n
/** V4's REVOKE_FLAG (LeftClaw M-4): an admit entry with it revokes the position for good. */
export const V4_REVOKE_FLAG = 1n << 255n

export function encodeInitV4(i: InitV4): Hex {
  if (i.capUsd <= 0n || i.capUsd > V4_MAX_CAP_USD) throw new Error(`InitV4: capUsd ${i.capUsd} outside (0, ${V4_MAX_CAP_USD}]`)
  if (i.admit.length > V4_MAX_ADMIT) throw new Error(`InitV4: ${i.admit.length} admitted positions, at most ${V4_MAX_ADMIT}`)
  // V4's Init rule (BadInit(4)): a home account names no home domain; a remote's or a sibling's home domain is a chain
  // of V4's table. CCTP domain 0 is Ethereum's, so it is a home domain like any other once `home` is set (#307).
  const hasHome = BigInt(i.home) !== 0n
  if (!hasHome && i.homeDomain !== 0) throw new Error('InitV4: a home account names no home domain')
  if (hasHome && V4_CHAIN_BY_DOMAIN[i.homeDomain] === undefined) throw new Error(`InitV4: home domain ${i.homeDomain} is not a chain of V4's table`)
  // V4 would accept a home on Ethereum; Mamoru does not put one there (Ethereum hosts siblings only, never a home).
  if (hasHome && !V4_HOME_CHAINS.includes(V4_CHAIN_BY_DOMAIN[i.homeDomain]!)) throw new Error(`InitV4: home domain ${i.homeDomain} is not an engine chain (${V4_HOME_CHAINS.join(', ')})`)
  return encodeAbiParameters(INIT_V4_TUPLE, [{ capUsd: i.capUsd, generation: i.generation, home: getAddress(i.home), homeDomain: i.homeDomain, admit: [...i.admit] }])
}

export function decodeInitV4(data: Hex): InitV4 {
  const [t] = decodeAbiParameters(INIT_V4_TUPLE, data)
  return { capUsd: t.capUsd, generation: t.generation, home: t.home, homeDomain: t.homeDomain, admit: [...t.admit] }
}

// ---- MamoruGasPolicyV2.Caps -----------------------------------------------------------------------------------

/**
 * MamoruGasPolicyV2.Caps (contracts/action-policy/src/MamoruGasPolicyV2.sol), field for field: the per-op caps. Spec 010
 * A1 (otto/mamoru#317): the gas rate per window (G, W) is the chain's, in MamoruV4Chains, not owner-signed.
 */
export type GasCapsV2 = GasCaps & { maxPaymasterGas: bigint }

export const GAS_CAPS_V2_TUPLE = [
  {
    type: 'tuple',
    components: [
      { name: 'maxPriorityFeePerGas', type: 'uint64' },
      { name: 'maxVerificationGasLimit', type: 'uint32' },
      { name: 'maxCallGasLimit', type: 'uint32' },
      { name: 'maxPreVerificationGas', type: 'uint32' },
      { name: 'maxFeePerGas', type: 'uint64' },
      { name: 'maxPaymasterGas', type: 'uint32' },
    ],
  },
] as const

export function encodeGasCapsV2(c: GasCapsV2): Hex {
  return encodeAbiParameters(GAS_CAPS_V2_TUPLE, [
    {
      maxPriorityFeePerGas: c.maxPriorityFeePerGas,
      maxVerificationGasLimit: Number(c.maxVerificationGasLimit),
      maxCallGasLimit: Number(c.maxCallGasLimit),
      maxPreVerificationGas: Number(c.maxPreVerificationGas),
      maxFeePerGas: c.maxFeePerGas,
      maxPaymasterGas: Number(c.maxPaymasterGas),
    },
  ])
}

export function decodeGasCapsV2(data: Hex): GasCapsV2 {
  const [c] = decodeAbiParameters(GAS_CAPS_V2_TUPLE, data)
  return {
    maxPriorityFeePerGas: c.maxPriorityFeePerGas,
    maxVerificationGasLimit: BigInt(c.maxVerificationGasLimit),
    maxCallGasLimit: BigInt(c.maxCallGasLimit),
    maxPreVerificationGas: BigInt(c.maxPreVerificationGas),
    maxFeePerGas: c.maxFeePerGas,
    maxPaymasterGas: BigInt(c.maxPaymasterGas),
  }
}

/**
 * The gas caps of the V4 sessions, by chain: the same as MamoruV4Chains.remoteCaps (a remote Safe's caps are pinned in
 * V4; the home's are owner-signed and chosen equal, so one table holds both): V1's per-op caps (V4_GAS_CAPS on Base,
 * MONAD_GAS_CAPS on Monad), no paymaster. The rate (MamoruV4Chains, A1): 0.002 ETH / 1 MON per day.
 */
export const GAS_CAPS_V2_BY_CHAIN: Readonly<Record<number, GasCapsV2>> = {
  8453: { maxPriorityFeePerGas: 10_000_000n, maxVerificationGasLimit: 3_000_000n, maxCallGasLimit: 2_000_000n, maxPreVerificationGas: 200_000n, maxFeePerGas: 100_000_000n, maxPaymasterGas: 0n },
  143: { maxPriorityFeePerGas: 1_000_000_000n, maxVerificationGasLimit: 3_000_000n, maxCallGasLimit: 2_000_000n, maxPreVerificationGas: 200_000n, maxFeePerGas: 1_000_000_000_000n, maxPaymasterGas: 0n },
  // #307: Ethereum, MamoruV4Chains' L1 caps (0.1 gwei priority, 5 gwei max fee).
  1: { maxPriorityFeePerGas: 100_000_000n, maxVerificationGasLimit: 3_000_000n, maxCallGasLimit: 2_000_000n, maxPreVerificationGas: 200_000n, maxFeePerGas: 5_000_000_000n, maxPaymasterGas: 0n },
}

/**
 * Spec 010 A1 (otto/mamoru#317): MamoruGasPolicyV2's rate per chain, MamoruV4Chains' `gasPerWindow` (G, wei) and
 * `gasWindow` (W, seconds). Pinned in V4's table, never owner-signed: Base 0.002 ETH, Monad 1 MON, Ethereum 0.01 ETH a day.
 */
export const V4_GAS_RATE_BY_CHAIN: Readonly<Record<number, { perWindow: bigint; window: number }>> = {
  8453: { perWindow: 2_000_000_000_000_000n, window: 86_400 },
  143: { perWindow: 1_000_000_000_000_000_000n, window: 86_400 },
  1: { perWindow: 10_000_000_000_000_000n, window: 86_400 },
}

/**
 * MamoruV4Chains: the CCTP domain of each chain V4 pins, and back. A chain or domain V4 does not pin is ABSENT
 * (`=== undefined`), never 0: CCTP domain 0 is Ethereum (#307).
 */
export const V4_DOMAIN_BY_CHAIN: Readonly<Record<number, number>> = { 8453: 6, 143: 15, 1: 0 }
/** The chains a Mamoru account's home (the account the engine runs) may be on. Ethereum is in V4's table for siblings
 * only (#307): a V4 sibling or remote names one of these as its home, never Ethereum. */
export const V4_HOME_CHAINS: readonly number[] = [8453, 143]
export const V4_CHAIN_BY_DOMAIN: Readonly<Record<number, number>> = { 6: 8453, 15: 143, 0: 1 }

/** MamoruV4Chains, per chain: the pinned stables (the budget unit, 6 decimals) and assets, by registry name. */
export const V4_PINNED: Readonly<Record<number, { stables: readonly RegistryName[]; assets: readonly RegistryName[] }>> = {
  8453: { stables: ['USDC', 'USDT'], assets: ['WETH', 'cbBTC'] },
  143: { stables: ['USDC'], assets: ['WMON'] },
  1: { stables: ['USDC'], assets: ['WETH'] }, // #307: USDT left out (CCTP burn limit 0 on Ethereum)
}

// ---- the policy templates --------------------------------------------------------------------------------------

/**
 * The engine's own view of a V4 session, per pool: decide reads grant templates only for their names, pools and
 * whether `manage-any` can increase (`hasIncrease`), so each registry pool gets one manage-any template (entries,
 * increase, exits), all served by the account's ONE V4 session. They are never encoded into a SmartSession: the
 * session the owner signs is `v4Session` (`@mamoru/account/one-auth`), a fallback action.
 */
export function v4PoolTemplate(pool: RegistryName): GrantTemplate {
  return {
    name: 'manage-any',
    pool,
    perPosition: false,
    usageLimit: V4_USAGE_LIMIT,
    actions: [{ target: pool, signature: POLICY_INCREASE_SIG, params: [] }],
    requiresActionPolicy: true,
    actionPolicyOnly: true,
  }
}

/** Off chain only (no UsageLimitPolicy in a V4 session): what the engine's ledger treats as never spent. */
export const V4_USAGE_LIMIT = 2 ** 31 - 1
/** Off chain only (no TimeFramePolicy in a V4 session): the validUntil the engine's view of the session carries. */
export const V4_VALID_UNTIL = 2 ** 32 - 1

/** The bridge leg's template, for a home account with a remote bucket and for a remote Safe (`bridge-out`, decide's name). */
export function v4BridgeTemplate(): GrantTemplate {
  return { name: 'bridge-out', perPosition: false, usageLimit: V4_USAGE_LIMIT, actions: [], requiresActionPolicy: true, actionPolicyOnly: true }
}

/**
 * The home policy of spec 010 on Base: v6's mix (Stable 50 %, Balance 35 % on Base, Growth 15 % on the account's own
 * Safe on Monad, spec 010 open question 3), engine, range and execution as v6. The buckets' pools here are the defaults
 * V4's table makes eligible at deploy; the engine runs on `withRegistryPools` of it, re-resolved against the pools V4
 * finds eligible (MamoruV4Table classes, MamoruV4Helper.priced) at every review. No session grants: nothing of this is ever renewed.
 */
export const oneAuthV4Live: PolicyVersion = {
  ...conservadorLiveV6,
  policyId: ONE_AUTH_V4,
  version: '0.1.0',
  buckets: [
    { id: 'stables', preference: 5000, pools: ['pool:USDC/USDT/100'] },
    { id: 'risk', preference: 3500, pools: ['pool:WETH/USDC/3000'] },
  ],
  remoteBuckets: [{ id: 'growth', preference: 1500, chainId: 143, pools: ['pool:WMON/USDC/3000'], policyId: ONE_AUTH_V4_REMOTE }],
  session: { validitySeconds: 0, renewalWindowSeconds: 0, caps: [], grants: [] },
}

/** Fork-only twin. */
export const oneAuthV4Lab: PolicyVersion = { ...oneAuthV4Live, policyId: `${ONE_AUTH_V4}-lab`, chain: 'fork' }

/** The policy of a V4 remote Safe on Monad: the Growth bucket alone, as v6's Monad Safe, no grants. */
export const oneAuthV4RemoteMonad: PolicyVersion = {
  ...liveWmonUsdcMonadV6,
  policyId: ONE_AUTH_V4_REMOTE,
  version: '0.1.0',
  session: { validitySeconds: 0, renewalWindowSeconds: 0, caps: [], grants: [] },
}

// ---- eligible pools (spec 010 A1: MamoruV4Table's classes, checked by MamoruV4Helper.priced) ------------------------
// The names keep "Registry" from the pre-A1 MamoruRegistry they replaced: they are the on-chain pool set the engine runs
// on, now derived by V4's rules instead of listed by an admin.

/** PoolEntryV4 (MamoruActionPolicyV4.sol), field for field: what MamoruV4Helper.priced returns for an eligible pool. */
export type RegistryPoolEntry = { twapWindow: number; twapShortWindow: number; bandTicks: number; anchorTick: number; anchorBand: number; ratioBps: number; active: boolean }

/** One eligible pool V4's rules give: its address, identity (token0, token1, fee, tick spacing read on chain) and entry. */
export type RegistryPool = { address: Address; token0: Address; token1: Address; fee: number; tickSpacing: number; entry: RegistryPoolEntry }

const SYMBOLS: readonly RegistryName[] = ['USDC', 'USDT', 'WETH', 'cbBTC', 'WMON']

/** The registry name of a token address among the V4-pinned ones, or undefined. */
function tokenName(a: Address, registry: Registry): RegistryName | undefined {
  return SYMBOLS.find((s) => isDeployed(s, registry) && address(s, registry).toLowerCase() === a.toLowerCase())
}

/**
 * The static registry's entry for an on-chain pool, or a new one named like the others (`pool:T0/T1/fee`, token0 first
 * as base.json names them, except that a pool whose token0 is the stable keeps that order too). Only pools of two
 * V4-pinned tokens, one of them a pinned stable, are kept (what V4 itself would price); any other is dropped.
 */
export function registryPoolEntry(p: RegistryPool, registry: Registry, opts: { unpinned?: boolean } = {}): RegistryEntry | null {
  const pinned = V4_PINNED[registry.chainId]
  if (!pinned) return null
  const t0 = tokenName(p.token0, registry)
  const t1 = tokenName(p.token1, registry)
  if (!t0 || !t1) return null
  const isPinned = (n: RegistryName) => pinned.stables.includes(n) || pinned.assets.includes(n)
  if (!isPinned(t0) || !isPinned(t1) || !(pinned.stables.includes(t0) || pinned.stables.includes(t1))) return null
  const known = registry.entries.find((e) => e.kind === 'pool' && e.address.toLowerCase() === p.address.toLowerCase())
  if (known) return known
  // Review of #202 (P0-4): the operator's own reads (funding, withdrawals, Stop) resolve pools in the chain's registry
  // json and nothing else, so the engine never enters a pool they could not see: an eligible pool that the json does not
  // pin is not used (pinning it is a reviewed PR, still no owner signature).
  if (!opts.unpinned) return null
  return { name: `pool:${t0}/${t1}/${p.fee}`, kind: 'pool', role: 'eligible by V4 rules (spec 010 A1), read on chain', address: getAddress(p.address), codeHash: null, token0: t0, token1: t1, fee: p.fee, tickSpacing: p.tickSpacing }
}

/**
 * A V4 policy whose buckets serve the eligible pools: a pool of two pinned stables goes to `stables`, any other
 * (a stable and an asset) to `risk`, each bucket keeping its preference (a bucket with no eligible pool keeps its weight; its share waits as savings). `registry` gains an entry for every pool it did not know. The engine's actionPolicy
 * carries each pool's band, anchor and windows exactly as V4's class states them, so its bounds are V4's own.
 * Returns the extended registry too: the engine resolves every pool name in it.
 */
export function withRegistryPools(policy: PolicyVersion, deployment: Pick<OneAuthV4Deployment, 'policy' | 'gasPolicy'>, pools: readonly RegistryPool[], registry: Registry): { policy: PolicyVersion; registry: Registry; pools: RegistryName[] } {
  const pinned = V4_PINNED[registry.chainId]
  if (!pinned) throw new Error(`one-auth-v4: chain ${registry.chainId} is not in V4's table`)
  const entries: RegistryEntry[] = [...registry.entries]
  const named: { name: RegistryName; pool: RegistryPool; stablePair: boolean }[] = []
  for (const p of pools) {
    if (!p.entry.active) continue
    const e = registryPoolEntry(p, { ...registry, entries })
    if (!e) continue
    if (!entries.some((x) => x.name === e.name)) entries.push(e)
    const stablePair = pinned.stables.includes(e.token0!) && pinned.stables.includes(e.token1!)
    named.push({ name: e.name, pool: p, stablePair })
  }
  const extended: Registry = { ...registry, entries }
  // Review of #202 r3 (Sol 1): every bucket the policy declares is kept, whatever its id. A registry pool joins the bucket that
  // declares a pool of the same token pair (any fee tier), else the first bucket of its kind (a pair of pinned stables, or
  // a stable and an asset); a bucket with no listed pool keeps its weight (decide's denominator under V4 is preferenceTotal).
  const pairOf = (t0: string, t1: string) => [t0, t1].sort().join('/')
  const declared = policy.buckets.map((b) => {
    const pairs = new Set<string>()
    let stableKind: boolean | null = null
    for (const name of b.pools) {
      const e = registry.entries.find((x) => x.name === name)
      if (!e?.token0 || !e.token1) continue
      pairs.add(pairOf(e.token0, e.token1))
      stableKind = pinned.stables.includes(e.token0) && pinned.stables.includes(e.token1)
    }
    return { b, pairs, stableKind }
  })
  const home = (n: (typeof named)[number]) => {
    const e = entries.find((x) => x.name === n.name)!
    const byPair = declared.find((d) => d.pairs.has(pairOf(e.token0!, e.token1!)))
    return (byPair ?? declared.find((d) => d.stableKind === n.stablePair))?.b.id
  }
  const buckets = policy.buckets.map((b) => ({ ...b, pools: named.filter((n) => home(n) === b.id).map((n) => n.name) }))
  const bandTicksByPool: Record<RegistryName, number> = {}
  const anchorByPool: Record<RegistryName, { tick: number; band: number }> = {}
  const twapByPool: Record<RegistryName, { long: number; short: number }> = {}
  for (const n of named) {
    bandTicksByPool[n.name] = n.pool.entry.bandTicks
    if (n.pool.entry.anchorBand > 0) anchorByPool[n.name] = { tick: n.pool.entry.anchorTick, band: n.pool.entry.anchorBand }
    twapByPool[n.name] = { long: n.pool.entry.twapWindow, short: n.pool.entry.twapShortWindow }
  }
  const caps = GAS_CAPS_V2_BY_CHAIN[registry.chainId]!
  // A home with a remote bucket bridges out to it; a remote Safe bridges home on its home's request (#278). Same session.
  const bridges = (policy.remoteBuckets ?? []).length > 0 || policy.policyId === ONE_AUTH_V4_REMOTE || policy.policyId === `${ONE_AUTH_V4_REMOTE}-lab`
  const grants = [...named.map((n) => v4PoolTemplate(n.name)), ...(bridges ? [v4BridgeTemplate()] : [])]
  const out: PolicyVersion = {
    ...policy,
    buckets,
    range: { ...policy.range, widthTicksByPool: Object.fromEntries(named.filter((n) => n.stablePair).map((n) => [n.name, policy.range.widthTicksByPool?.[n.name] ?? 40])) },
    session: { ...policy.session, grants },
    actionPolicy: {
      address: deployment.policy,
      bandTicksByPool,
      anchorByPool,
      twapByPool,
      gasPolicy: { address: deployment.gasPolicy, caps: { maxPriorityFeePerGas: caps.maxPriorityFeePerGas, maxVerificationGasLimit: caps.maxVerificationGasLimit, maxCallGasLimit: caps.maxCallGasLimit, maxPreVerificationGas: caps.maxPreVerificationGas, maxFeePerGas: caps.maxFeePerGas } },
      contractVersion: 4,
    },
  }
  return { policy: out, registry: extended, pools: named.map((n) => n.name) }
}

/** A stable signature of an eligible pool set (what changes when a pool becomes eligible or stops being so). */
export function registryPoolsKey(pools: readonly RegistryPool[]): string {
  return pools
    .filter((p) => p.entry.active)
    .map((p) => `${p.address.toLowerCase()}:${p.entry.twapWindow}:${p.entry.twapShortWindow}:${p.entry.bandTicks}:${p.entry.anchorTick}:${p.entry.anchorBand}:${p.entry.ratioBps}`)
    .sort()
    .join(',')
}

/** The registry entry of a pool name the static registry already has (tests, fixtures). */
export function staticPool(name: RegistryName, registry: Registry): Pick<RegistryPool, 'address' | 'token0' | 'token1' | 'fee' | 'tickSpacing'> {
  const e = entry(name, registry)
  return { address: e.address, token0: address(e.token0!, registry), token1: address(e.token1!, registry), fee: e.fee!, tickSpacing: e.tickSpacing ?? 1 }
}
