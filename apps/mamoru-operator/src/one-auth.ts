// otto/mamoru#293 (spec 010, one authorization): the operator's side of MamoruActionPolicyV4 that does not need the
// Operator's own state: the "What's new" view, the plain-language lines of each signed step (#41), the engine's view of
// the account's one V4 session, and the pools V4's rules make eligible, read on chain (cached per review; spec 010 A1:
// MamoruV4Table's classes checked by MamoruV4Helper.priced, no registry). Everything here is reached only for an account
// in the `one_auth_v4` scope on a chain whose registry pins the V4 stack, or for an account that already runs on V4.
import { keccak256, toHex, zeroAddress, type Hex, type PublicClient } from 'viem'
import type { Address, WhatsNew } from '@mamoru/domain'
import { address, type Registry } from '@mamoru/registry'
import { ONE_AUTH_V4, V4_CAP30_MULTIPLE, registryPoolsKey, V4_USAGE_LIMIT, V4_VALID_UNTIL, type OneAuthV4Deployment, type RegistryPool, type SessionGrant } from '@mamoru/policy'
import { mamoruActionPolicyV4Abi, mamoruV4HelperAbi, mamoruV4TableAbi, v4Children, V4_FEE_BITS } from '@mamoru/account/one-auth'
import { mamoruActionPolicyV2Abi } from '@mamoru/registry'

/** The reasons the screen gives, one line each (#295 renders 1-4). */
export const WHATS_NEW_POINTS: readonly string[] = [
  'Mamoru can use new pools that pass its on-chain rules without asking you again',
  'Safer price limits',
  'Nobody can pause or steer your account: its limits are code on chain',
  'No more renewals: you sign again only to take money out',
]

/** What the operator keeps of an account's move to V4 (state.ts `AccountState.oneAuth`). */
export type OneAuthState = {
  /** The last permission-id inventory (fail closed: no offer unless `ok`). */
  inventory?: { ok: boolean; at: string; scannedFrom: string; scannedTo: string; events: Hex[]; remove?: Hex[]; revoke?: Hex[]; code?: string; detail?: string; unknown?: Hex[] }
  /** The policy the account ran before step 0 (for /ops and the history). */
  from?: string
  /** C (USD units, 6 decimals) and generation of the account's V4 Init. */
  capUsd?: string
  generation?: string
  /** The home's remote on Monad as V4 registered it (registerRemote), and whether V4 holds it ready (announceReady, A1). */
  remote?: { domain: number; address: Hex; sessionKey: Hex; ready?: boolean; registeredAt?: string; tx?: Hex; accountKey?: string; capUsd?: string }
  /** The account's pause from the last read: the V2/V3 guardian's before V4 (V4 has no pause, A1: always false there). */
  paused?: boolean
}

/**
 * The "What's new" view (domain `WhatsNew`, the contract #295 builds against): step 0 on Base, step 1 on Monad only for an
 * account with a design-C Safe there. `currentStep`: the first step not confirmed.
 */
export function whatsNewOf(p: { base: string[]; monad?: { summary: string[]; moveTo?: string }; currentStep: number }): WhatsNew {
  const steps: WhatsNew['steps'] = [{ chain: 'base', summary: p.base }]
  if (p.monad) steps.push({ chain: 'monad', summary: p.monad.summary, ...(p.monad.moveTo ? { moveTo: p.monad.moveTo } : {}) })
  return { policy: ONE_AUTH_V4, points: [...WHATS_NEW_POINTS], signatures: steps.length === 2 ? 2 : 1, currentStep: p.currentStep, steps }
}

const usd = (raw: bigint) => {
  const whole = raw / 1_000_000n
  const cents = (raw % 1_000_000n) / 10_000n
  return `${whole.toLocaleString('en-US')}${cents ? `.${cents.toString().padStart(2, '0')}` : ''}`
}

/** Every line the owner signs in step 0 (the Base Safe transaction), in the order of its calls. */
export function baseStepLines(p: { remove: number; revoke: number; capUsd: bigint; admitted: number; remoteChain?: string }): string[] {
  // Review of #202 (P1-11): the numbers are the Init's own C and V4's 30-day multiple, never fixed text. A remote Safe gets
  // its home's C from V4 itself (registerRemote), so the line says the same limit applies there.
  const lines = [
    `Removes Mamoru's ${p.remove} current permission${p.remove === 1 ? '' : 's'} on your Safe, and cancels any unused ones (${p.revoke} in all)`,
    'Gives Mamoru one permission that does not expire. It may only swap, provide liquidity and use savings vaults in pools that pass rules written in the contract (official Uniswap pools of listed tokens, with enough history and in line with a reference pool) and in the vaults and chains the contract lists. Nobody can add to that list: a change is a new version, which you would choose to adopt',
    `On this Safe Mamoru may move at most ${usd(p.capUsd)} USDC of value a day (each swap and each deposit into a pool counts), and ${usd(p.capUsd * V4_CAP30_MULTIPLE)} USDC in any 30 days. Past that each move is refused until the window frees up again`,
    ...(p.remoteChain ? [`Your Safe on ${p.remoteChain}, when Mamoru creates it, has the same limits of its own (${usd(p.capUsd)} USDC a day, ${usd(p.capUsd * V4_CAP30_MULTIPLE)} USDC in 30 days)`] : []),
    `Money only ever goes to your own Safes${p.remoteChain ? ` (this one, and yours on ${p.remoteChain})` : ''}. Taking money out still needs your signature`,
  ]
  if (p.admitted) lines.push(`Your ${p.admitted} current position${p.admitted === 1 ? ' stays' : 's stay'} where ${p.admitted === 1 ? 'it is' : 'they are'}, and Mamoru keeps managing ${p.admitted === 1 ? 'it' : 'them'}`)
  lines.push('The transaction checks on chain that only the new permission is left; otherwise nothing changes')
  return lines
}

/** Every line the owner signs in step 1 (the design-C Safe on Monad). */
export function monadStepLines(p: { remove: number; revoke: number; moveTo: string; tokens: string[]; positions: number }): string[] {
  return [
    `Removes Mamoru's ${p.remove} permission${p.remove === 1 ? '' : 's'} on your Safe on Monad, and cancels any unused ones (${p.revoke} in all)`,
    `Moves ${p.tokens.length ? p.tokens.join(' and ') : 'what this Safe holds'} to your new Safe on Monad, ${p.moveTo}: same owner (your passkey)`,
    ...(p.positions ? [`Your ${p.positions} position${p.positions === 1 ? '' : 's'} on Monad stay${p.positions === 1 ? 's' : ''} in this Safe: Mamoru no longer manages ${p.positions === 1 ? 'it' : 'them'}, and you can withdraw ${p.positions === 1 ? 'it' : 'them'} as before`] : []),
    'Leaves this Safe one permission that can move no value (a limit of 0.000001 USDC a day); the transaction checks that it is the only one left',
  ]
}

/** The engine's view of the account's V4 session (one grant, no actions: precheck mirrors V4's checkAction). */
export function v4StoredGrant(p: { account: Address; chainId: number; sessionKey: Address; permissionId: Hex; salt: Hex; deployment: Pick<OneAuthV4Deployment, 'policy'>; registry: Registry; policyId?: string }): SessionGrant {
  return {
    policyId: p.policyId ?? ONE_AUTH_V4,
    policyHash: keccak256(toHex(p.policyId ?? ONE_AUTH_V4)),
    name: 'manage-any',
    salt: p.salt,
    chainId: p.chainId,
    account: p.account,
    sessionValidator: 'OwnableValidator',
    sessionKey: p.sessionKey,
    userOp: { validAfter: 0, validUntil: V4_VALID_UNTIL, usageLimit: V4_USAGE_LIMIT },
    permitERC4337Paymaster: false,
    erc7739: 'none',
    fallbackAction: 'none',
    actions: [],
    requiresActionPolicy: true,
    actionPolicyOnly: true,
    actionPolicy: p.deployment.policy,
    oneAuthV4: { policy: p.deployment.policy, npm: address('NonfungiblePositionManager', p.registry) },
  }
}

const poolIdentityAbi = [
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'fee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] },
  { type: 'function', name: 'tickSpacing', stateMutability: 'view', inputs: [], outputs: [{ type: 'int24' }] },
] as const

/**
 * The pools V4 makes eligible on this chain now (spec 010 A1 "Eligibility rules"): for every pair with a class in
 * MamoruV4Table, every pool of the chain's factory at a fee tier of the class's set, kept only when MamoruV4Helper.priced
 * accepts it (factory, pinned tokens, fee set, observation ring, agreement with the reference pool), with the entry V4
 * itself prices it with. A pool `priced` refuses is not eligible now and is left out; a read that fails otherwise throws
 * (the cache keeps the last good set).
 */
export async function readEligiblePools(client: PublicClient, deployment: Pick<OneAuthV4Deployment, 'policy' | 'table'>, chainId: number, blockNumber?: bigint): Promise<RegistryPool[]> {
  const at = blockNumber !== undefined ? { blockNumber } : {}
  const { helper } = v4Children(deployment.policy)
  const [chain, pairs] = await Promise.all([
    client.readContract({ address: deployment.table, abi: mamoruV4TableAbi, functionName: 'chain', args: [BigInt(chainId)], ...at }),
    client.readContract({ address: deployment.table, abi: mamoruV4TableAbi, functionName: 'pairsOf', args: [BigInt(chainId)], ...at }),
  ])
  if (chain.chainId !== BigInt(chainId)) throw new Error(`MamoruV4Table has no row for chain ${chainId}`)
  const candidates = new Set<Address>()
  for (const [a, b] of pairs) {
    const cls = await client.readContract({ address: deployment.table, abi: mamoruV4TableAbi, functionName: 'classOf', args: [BigInt(chainId), a, b], ...at })
    if (BigInt(cls.ref) === 0n) continue
    for (const [fee, bit] of V4_FEE_BITS) {
      if ((cls.feeMask & bit) === 0) continue
      const pool = (await client.readContract({ address: chain.factory, abi: factoryGetPoolAbi, functionName: 'getPool', args: [a, b, fee], ...at })) as Address
      if (BigInt(pool) !== 0n) candidates.add(pool)
    }
  }
  const out: RegistryPool[] = []
  for (const pool of candidates) {
    let priced: readonly [{ token0: Address; token1: Address; fee: number }, { twapWindow: number; twapShortWindow: number; bandTicks: number; anchorTick: number; anchorBand: number; ratioBps: number; active: boolean }, Address]
    try {
      priced = (await client.readContract({ address: helper, abi: mamoruV4HelperAbi, functionName: 'priced', args: [pool], ...at })) as typeof priced
    } catch (e) {
      if (isRevert(e)) continue // not eligible now (NotEligible, NotPinned, ...): left out
      throw e
    }
    const [p, e] = priced
    const tickSpacing = await client.readContract({ address: pool, abi: poolIdentityAbi, functionName: 'tickSpacing', ...at })
    out.push({ address: pool, token0: p.token0, token1: p.token1, fee: Number(p.fee), tickSpacing: Number(tickSpacing), entry: { twapWindow: e.twapWindow, twapShortWindow: e.twapShortWindow, bandTicks: e.bandTicks, anchorTick: e.anchorTick, anchorBand: e.anchorBand, ratioBps: e.ratioBps, active: e.active } })
  }
  return out
}

const factoryGetPoolAbi = [
  { type: 'function', name: 'getPool', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }], outputs: [{ type: 'address' }] },
] as const

/** A contract revert (viem ContractFunctionRevertedError somewhere in the cause chain), not a transport failure. */
function isRevert(e: unknown): boolean {
  for (let c = e as { name?: string; cause?: unknown } | undefined; c; c = c.cause as typeof c) if (c.name === 'ContractFunctionRevertedError') return true
  return false
}

/** One read of the eligible pools per TTL for every V4 account of the process (each review asks; a failed read keeps the last). */
export class RegistryPoolsCache {
  private last: { at: number; pools: RegistryPool[]; key: string } | null = null
  private inflight: Promise<RegistryPool[]> | null = null
  constructor(
    private readonly read: () => Promise<RegistryPool[]>,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** The eligible pools, at most `ttlMs` old. Throws only when no read has ever succeeded. */
  async get(): Promise<{ pools: RegistryPool[]; key: string }> {
    if (this.last && this.now() - this.last.at < this.ttlMs) return this.last
    this.inflight ??= this.read().finally(() => (this.inflight = null))
    try {
      const pools = await this.inflight
      this.last = { at: this.now(), pools, key: registryPoolsKey(pools) }
    } catch (e) {
      if (!this.last) throw e
    }
    return this.last!
  }

  /** The last successful read, without waiting (null before the first). */
  peek(): { pools: RegistryPool[]; key: string } | null {
    return this.last
  }
}

/**
 * MamoruActionPolicyV2/V3's guardian pause of `account`; null when unreadable. Never for V4: spec 010 A1 has no pause
 * (callers return false for a V4 account without reading).
 */
export async function readPaused(client: PublicClient, policy: Address, account: Address): Promise<boolean | null> {
  try {
    return (await client.readContract({ address: policy, abi: mamoruActionPolicyV2Abi, functionName: 'isPaused', args: [account] })) as boolean
  } catch {
    return null
  }
}

/** V4's registered remote of `account` on `domain` and whether it is ready; null when unreadable. */
export async function readV4Remote(client: PublicClient, policy: Address, account: Address, domain: number): Promise<{ remote: Address; ready: boolean; sessionKey: Address; capUsd: bigint } | null> {
  try {
    const [r, ready] = await Promise.all([
      client.readContract({ address: policy, abi: mamoruActionPolicyV4Abi, functionName: 'remoteOf', args: [account, domain] }),
      client.readContract({ address: policy, abi: mamoruActionPolicyV4Abi, functionName: 'isReady', args: [account, domain] }),
    ])
    return { remote: r.remote, ready: ready as boolean, sessionKey: r.sessionKey, capUsd: r.capUsd }
  } catch {
    return null
  }
}

export const NO_REMOTE: Address = zeroAddress
