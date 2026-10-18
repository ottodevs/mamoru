import { keccak256, stringToHex, toFunctionSelector } from 'viem'
import { FORBIDDEN_LAB_CHAIN_IDS, BASE_CHAIN_ID, ReasonError, type Address, type Hex } from '@mamoru/domain'
import { address, baseRegistry, isDeployed, type Registry } from '@mamoru/registry'
import { grantKey } from './grants.ts'
import { MAX_USAGE_LIMIT, type GrantName, type GrantTemplate, type MamoruActionPolicyInit, type PolicyVersion, type RefTemplate, type ResolvedActionRule, type SessionGrant } from './types.ts'

function canonical(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    )
  }
  return value
}

const hashes = new WeakMap<PolicyVersion, Hex>()

/** Hash of the canonical policy. A policy version is never changed in place, so the hash is kept per object. */
export function policyHash(policy: PolicyVersion): Hex {
  let h = hashes.get(policy)
  if (!h) {
    h = keccak256(stringToHex(JSON.stringify(canonical(policy))))
    hashes.set(policy, h)
  }
  return h
}

/** Raw units of `asset` per raw unit of USDC, as a fraction. */
export type Price = { num: bigint; den: bigint }

export type Caps = Record<string, bigint>

export function computeCaps(policy: PolicyVersion, depositUsdc: bigint, prices: Record<string, Price>): Caps {
  const caps: Caps = {}
  for (const f of policy.session.caps) {
    const usdcShare = (depositUsdc * BigInt(f.bpsOfDeposit)) / 10_000n
    if (f.asset === 'USDC') {
      caps[f.name] = usdcShare
      continue
    }
    const price = prices[f.asset]
    if (!price) throw new Error(`missing activation price for ${f.asset}`)
    caps[f.name] = (usdcShare * price.num) / price.den
  }
  return caps
}

export function assertPolicyChain(policy: PolicyVersion, chainId: number): void {
  const ok = policy.chain === 'base' ? chainId === BASE_CHAIN_ID : !FORBIDDEN_LAB_CHAIN_IDS.includes(chainId)
  if (!ok) throw new ReasonError('SIGN_CHAIN_NOT_ALLOWED', `${policy.policyId} on chain ${chainId}`)
}

export type GrantContext = {
  account: Address
  sessionKey: Address
  chainId: number
  salt: Hex
  validAfter: number
  validUntil: number
  caps: Caps
  tokenId?: bigint
  /** Positions minted by this session's enter-mint. A manage grant cannot name any other id. */
  admittedTokenIds?: readonly bigint[]
  /** Account cap the grant is sized at (raw savings units): picks the usage tier (#149). Absent: the template's `usageLimit`. */
  capUsdc?: bigint
  /**
   * Spec 007, v4 grants only: the account's MamoruActionPolicy generation these grants are enabled at. An activation
   * or a renewal is the on-chain `generationOf(account) + 1` (it retires every older grant of the account); a pool added
   * without a renewal is the current one.
   */
  generation?: bigint
  /** Where registry names resolve. Default: Base. A Lab fork with its own MamoruActionPolicy passes a registry naming it. */
  registry?: Registry
}

/**
 * The usage limit of `template` for an account sized at `capUsdc` (#149): the first tier at or above the cap, the last
 * one above every tier, `usageLimit` without tiers or without a cap. Refuses a limit over MAX_USAGE_LIMIT.
 */
export function usageLimitFor(template: Pick<GrantTemplate, 'name' | 'usageLimit' | 'usageByCap'>, capUsdc?: bigint): number {
  const tiers = template.usageByCap
  const limit = !tiers?.length || capUsdc === undefined ? template.usageLimit : (tiers.find((t) => capUsdc <= t.upToUsdc) ?? tiers.at(-1)!).usageLimit
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_USAGE_LIMIT) throw new Error(`grant ${template.name}: usage limit ${limit} outside 1..${MAX_USAGE_LIMIT}`)
  return limit
}

function capOf(name: string, ctx: GrantContext): bigint {
  const v = ctx.caps[name]
  if (v === undefined) throw new Error(`missing cap cap:${name}`)
  return v
}

function resolveRef(ref: RefTemplate, ctx: GrantContext): bigint {
  if (typeof ref === 'bigint') return ref
  if (ref === 'ACCOUNT') return BigInt(ctx.account)
  if (ref === 'tokenId') {
    if (ctx.tokenId === undefined) throw new Error('per-position grant needs a tokenId')
    return ctx.tokenId
  }
  if (ref.startsWith('cap:')) {
    // `cap:a|b`: the larger of two caps (a v4 swap takes either token of its pool, spec 007).
    const [a, b, ...rest] = ref.slice(4).split('|')
    if (rest.length) throw new Error(`cap ${ref}: at most two names`)
    const x = capOf(a!, ctx)
    if (b === undefined) return x
    const y = capOf(b, ctx)
    return x > y ? x : y
  }
  return BigInt(address(ref, ctx.registry ?? baseRegistry))
}

const UINT24 = 2 ** 24
const UINT32 = 2 ** 32
const UINT128 = 1n << 128n
const UINT64 = 1n << 64n

/**
 * Spec 007: the Init of a v4 grant, every field range-checked against MamoruActionPolicy.Init (uint24 band, uint32
 * windows, uint64 generation, uint128 budgets). Refused while MamoruActionPolicy has no address in the registry: no v4
 * grant can be built, so no v4 activation can be signed, until it is deployed and pinned.
 */
function actionPolicyOf(template: GrantTemplate, ctx: GrantContext): SessionGrant['actionPolicy'] {
  const ap = template.actionPolicy!
  const registry = ctx.registry ?? baseRegistry
  if (!isDeployed('MamoruActionPolicy', registry)) throw new ReasonError('POLICY_TARGET_NOT_IN_REGISTRY', `MamoruActionPolicy is not deployed on ${registry.chain}: grant ${template.name} cannot be built`)
  const g = ctx.generation
  if (g === undefined || g < 1n || g >= UINT64) throw new Error(`grant ${grantKey(template)}: a v4 grant needs a generation in 1..2^64-1, got ${g}`)
  const int = (v: number, max: number, what: string) => {
    if (!Number.isInteger(v) || v < 1 || v >= max) throw new Error(`grant ${grantKey(template)}: ${what} ${v} out of range`)
    return v
  }
  const budget = (ref: `cap:${string}`) => {
    const v = resolveRef(ref, ctx)
    if (v < 0n || v >= UINT128) throw new Error(`grant ${grantKey(template)}: budget ${ref} = ${v} out of uint128`)
    return v
  }
  const init: MamoruActionPolicyInit = {
    pool: address(ap.pool, registry),
    twapWindow: int(ap.twapWindowSeconds, UINT32, 'twapWindow'),
    bandTicks: int(ap.bandTicks, UINT24, 'bandTicks'),
    generation: g,
    budgetWindow: int(ap.budgetWindowSeconds, UINT32, 'budgetWindow'),
    perWindow0: budget(ap.perWindow0),
    perWindow1: budget(ap.perWindow1),
    total0: budget(ap.total0),
    total1: budget(ap.total1),
  }
  if (init.perWindow0 > init.total0 || init.perWindow1 > init.total1) throw new Error(`grant ${grantKey(template)}: a window budget above the approval total`)
  return { address: address('MamoruActionPolicy', registry), init }
}

/** `key` is a grant name or, on a multi-pool policy, `name:pool` (see `grantKey`). A bare name takes the first grant of that name. */
export function instantiateGrant(policy: PolicyVersion, key: GrantName | string, ctx: GrantContext): SessionGrant {
  assertPolicyChain(policy, ctx.chainId)
  const template = policy.session.grants.find((g) => grantKey(g) === key) ?? policy.session.grants.find((g) => g.name === key)
  if (!template) throw new Error(`${policy.policyId} has no grant ${key}`)
  const name = template.name
  if (template.perPosition !== (ctx.tokenId !== undefined)) {
    throw new Error(`grant ${name} ${template.perPosition ? 'needs' : 'does not take'} a tokenId`)
  }
  if (template.perPosition && !ctx.admittedTokenIds?.some((id) => id === ctx.tokenId)) {
    throw new ReasonError('POLICY_DENIED_POSITION', 'tokenId was not minted by enter-mint')
  }
  if (!template.actionPolicy && ctx.generation !== undefined) throw new Error(`grant ${name} has no action policy: no generation`)
  const actionPolicy = template.actionPolicy ? actionPolicyOf(template, ctx) : undefined
  const actions: ResolvedActionRule[] = template.actions.map((a) => ({
    target: a.target,
    targetAddress: address(a.target, ctx.registry ?? baseRegistry),
    signature: a.signature,
    selector: toFunctionSelector(`function ${a.signature}`),
    nativeValue: 0n,
    params: a.params.map((p) => ({
      field: p.field,
      index: p.index,
      condition: p.condition,
      ref: resolveRef(p.ref, ctx),
      cumulativeLimit: p.cumulative ? resolveRef(p.cumulative, ctx) : undefined,
      denial: p.denial,
    })),
  }))
  const seen = new Set<string>()
  for (const a of actions) {
    const key = `${a.targetAddress.toLowerCase()}:${a.selector}`
    if (seen.has(key)) throw new Error(`grant ${name} repeats ${a.target} ${a.signature}: split it`)
    seen.add(key)
  }
  return {
    policyId: policy.policyId,
    policyHash: policyHash(policy),
    name,
    ...(template.pool ? { pool: template.pool } : {}),
    salt: ctx.salt,
    chainId: ctx.chainId,
    account: ctx.account,
    sessionValidator: 'OwnableValidator',
    sessionKey: ctx.sessionKey,
    userOp: { validAfter: ctx.validAfter, validUntil: ctx.validUntil, usageLimit: usageLimitFor(template, ctx.capUsdc) },
    permitERC4337Paymaster: false,
    erc7739: 'none',
    fallbackAction: 'none',
    tokenId: ctx.tokenId,
    actions,
    ...(actionPolicy ? { actionPolicy } : {}),
  }
}
