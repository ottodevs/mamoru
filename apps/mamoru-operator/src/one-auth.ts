// otto/mamoru#293 (spec 010, one authorization): the operator's side of MamoruActionPolicyV4 that does not need the
// Operator's own state: the "What's new" view, the plain-language lines of each signed step (#41), the engine's view of
// the account's one V4 session, and MamoruRegistry's active pools read on chain (cached per review). Everything here is
// reached only for an account in the `one_auth_v4` scope on a chain whose registry pins the V4 stack, or for an account
// that already runs on V4.
import { keccak256, toHex, zeroAddress, type Hex, type PublicClient } from 'viem'
import type { Address, WhatsNew } from '@mamoru/domain'
import { address, type Registry } from '@mamoru/registry'
import { ONE_AUTH_V4, V4_CAP30_MULTIPLE, registryPoolsKey, V4_USAGE_LIMIT, V4_VALID_UNTIL, type OneAuthV4Deployment, type RegistryPool, type SessionGrant } from '@mamoru/policy'
import { mamoruActionPolicyV4Abi, mamoruRegistryAbi } from '@mamoru/account/one-auth'

/** The reasons the screen gives, one line each (#295 renders 1-4). */
export const WHATS_NEW_POINTS: readonly string[] = [
  'Mamoru can use new pools and chains without asking you again',
  'Safer price limits',
  'Emergency pause. It never moves money.',
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
  /** The home's remote on Monad as V4 registered it (registerRemote), and whether the guardian marked it ready. */
  remote?: { domain: number; address: Hex; sessionKey: Hex; ready?: boolean; registeredAt?: string; tx?: Hex; accountKey?: string }
  /** The account's pause from the last read: V4's (guardian, breaker or review) on V4, the V2/V3 guardian's before. */
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
    'Gives Mamoru one permission that does not expire. It may only swap, provide liquidity and use savings vaults in the pools, vaults and chains of Mamoru\'s public list, where each addition waits 72 hours in public',
    `On this Safe Mamoru may move at most ${usd(p.capUsd)} USDC of value a day (each swap and each deposit into a pool counts), and ${usd(p.capUsd * V4_CAP30_MULTIPLE)} USDC in any 30 days. Past that it pauses by itself`,
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

/** MamoruRegistry's active pools with their entries and identities, read at `blockNumber` (or the head). */
export async function readRegistryPools(client: PublicClient, registryAddress: Address, blockNumber?: bigint): Promise<RegistryPool[]> {
  const at = blockNumber !== undefined ? { blockNumber } : {}
  const pools = (await client.readContract({ address: registryAddress, abi: mamoruRegistryAbi, functionName: 'activePools', ...at })) as Address[]
  return Promise.all(
    pools.map(async (pool) => {
      const [e, token0, token1, fee, tickSpacing] = await Promise.all([
        client.readContract({ address: registryAddress, abi: mamoruRegistryAbi, functionName: 'poolOf', args: [pool], ...at }),
        client.readContract({ address: pool, abi: poolIdentityAbi, functionName: 'token0', ...at }),
        client.readContract({ address: pool, abi: poolIdentityAbi, functionName: 'token1', ...at }),
        client.readContract({ address: pool, abi: poolIdentityAbi, functionName: 'fee', ...at }),
        client.readContract({ address: pool, abi: poolIdentityAbi, functionName: 'tickSpacing', ...at }),
      ])
      return { address: pool, token0, token1, fee: Number(fee), tickSpacing: Number(tickSpacing), entry: { twapWindow: e.twapWindow, twapShortWindow: e.twapShortWindow, bandTicks: e.bandTicks, anchorTick: e.anchorTick, anchorBand: e.anchorBand, ratioBps: e.ratioBps, active: e.active } }
    }),
  )
}

/** One read of the registry per TTL for every V4 account of the process (each review asks; a failed read keeps the last). */
export class RegistryPoolsCache {
  private last: { at: number; pools: RegistryPool[]; key: string } | null = null
  private inflight: Promise<RegistryPool[]> | null = null
  constructor(
    private readonly read: () => Promise<RegistryPool[]>,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** The active pools, at most `ttlMs` old. Throws only when no read has ever succeeded. */
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

/** V4's pause of `account` (guardian, breaker or review); null when unreadable. */
export async function readV4Paused(client: PublicClient, policy: Address, account: Address): Promise<boolean | null> {
  try {
    return (await client.readContract({ address: policy, abi: mamoruActionPolicyV4Abi, functionName: 'isPaused', args: [account] })) as boolean
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
