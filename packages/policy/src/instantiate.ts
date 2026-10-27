import { keccak256, stringToHex, toFunctionSelector } from 'viem'
import { FORBIDDEN_LAB_CHAIN_IDS, BASE_CHAIN_ID, MONAD_CHAIN, ReasonError, type Address, type Hex } from '@mamoru/domain'
import { address, registryFor, type Registry } from '@mamoru/registry'
import { grantKey } from './grants.ts'
import { MAX_USAGE_LIMIT, type GrantName, type GrantTemplate, type PolicyVersion, type RefTemplate, type ResolvedActionRule, type SessionGrant } from './types.ts'

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
  const ok = policy.chain === 'base' ? chainId === BASE_CHAIN_ID : policy.chain === 'monad' ? chainId === MONAD_CHAIN.chainId : !FORBIDDEN_LAB_CHAIN_IDS.includes(chainId)
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

/** otto/mamoru#65: the registry a policy's names resolve in: its source chain's, Base when it names none. */
export function policyRegistry(policy: Pick<PolicyVersion, 'sourceChainId'>): Registry {
  return registryFor(policy.sourceChainId ?? BASE_CHAIN_ID)
}

function resolveRef(ref: RefTemplate, ctx: GrantContext, registry: Registry): bigint {
  if (typeof ref === 'bigint') return ref
  if (ref === 'ACCOUNT') return BigInt(ctx.account)
  if (ref === 'tokenId') {
    if (ctx.tokenId === undefined) throw new Error('per-position grant needs a tokenId')
    return ctx.tokenId
  }
  if (ref.startsWith('cap:')) {
    // otto/mamoru#225: `cap:a|b` is the larger of caps a and b (a merged grant's one bound for what two grants capped).
    // mergeGrants writes it only for caps of the same token (v4-grants.ts `amountToken`): raw numbers of two tokens are
    // not comparable.
    let max: bigint | undefined
    for (const name of ref.slice(4).split('|')) {
      const v = ctx.caps[name]
      if (v === undefined) throw new Error(`missing cap cap:${name}`)
      if (max === undefined || v > max) max = v
    }
    return max!
  }
  return BigInt(address(ref, registry))
}

/** `key` is a grant name or, on a multi-pool policy, `name:pool` (see `grantKey`). A bare name takes the first grant of that name. */
export function instantiateGrant(policy: PolicyVersion, key: GrantName | string, ctx: GrantContext): SessionGrant {
  assertPolicyChain(policy, ctx.chainId)
  const template = policy.session.grants.find((g) => grantKey(g) === key) ?? policy.session.grants.find((g) => g.name === key)
  if (!template) throw new Error(`${policy.policyId} has no grant ${key}`)
  const name = template.name
  const registry = policyRegistry(policy)
  if (template.perPosition !== (ctx.tokenId !== undefined)) {
    throw new Error(`grant ${name} ${template.perPosition ? 'needs' : 'does not take'} a tokenId`)
  }
  for (const a of template.actions) {
    if (a.actionPolicyOnly && (!template.requiresActionPolicy || a.params.length)) throw new Error(`grant ${name}: ${a.signature} without UniActionPolicy needs MamoruActionPolicy and no rules`)
    if (!a.actionPolicyOnly && !a.params.length) throw new Error(`grant ${name}: ${a.signature} has no rule (UniActionPolicy refuses an action without one)`)
  }
  if (template.perPosition && !ctx.admittedTokenIds?.some((id) => id === ctx.tokenId)) {
    throw new ReasonError('POLICY_DENIED_POSITION', 'tokenId was not minted by enter-mint')
  }
  const actions: ResolvedActionRule[] = template.actions.map((a) => ({
    target: a.target,
    targetAddress: address(a.target, registry),
    signature: a.signature,
    selector: toFunctionSelector(`function ${a.signature}`),
    nativeValue: 0n,
    params: a.params.map((p) => ({
      field: p.field,
      index: p.index,
      condition: p.condition,
      ref: resolveRef(p.ref, ctx, registry),
      cumulativeLimit: p.cumulative ? resolveRef(p.cumulative, ctx, registry) : undefined,
      denial: p.denial,
    })),
    ...(a.actionPolicyOnly ? { actionPolicyOnly: true as const } : {}),
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
    ...(template.requiresActionPolicy ? { requiresActionPolicy: true as const } : {}),
    ...(template.requiresPauseGate ? { requiresPauseGate: true as const } : {}),
  }
}
