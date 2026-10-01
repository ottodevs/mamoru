import { keccak256, stringToHex, toFunctionSelector } from 'viem'
import { FORBIDDEN_LAB_CHAIN_IDS, BASE_CHAIN_ID, ReasonError, type Address, type Hex } from '@mamoru/domain'
import { address } from '@mamoru/registry'
import { grantKey } from './grants.ts'
import type { GrantName, PolicyVersion, RefTemplate, ResolvedActionRule, SessionGrant } from './types.ts'

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
}

function resolveRef(ref: RefTemplate, ctx: GrantContext): bigint {
  if (typeof ref === 'bigint') return ref
  if (ref === 'ACCOUNT') return BigInt(ctx.account)
  if (ref === 'tokenId') {
    if (ctx.tokenId === undefined) throw new Error('per-position grant needs a tokenId')
    return ctx.tokenId
  }
  if (ref.startsWith('cap:')) {
    const v = ctx.caps[ref.slice(4)]
    if (v === undefined) throw new Error(`missing cap ${ref}`)
    return v
  }
  return BigInt(address(ref))
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
  const actions: ResolvedActionRule[] = template.actions.map((a) => ({
    target: a.target,
    targetAddress: address(a.target),
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
    userOp: { validAfter: ctx.validAfter, validUntil: ctx.validUntil, usageLimit: template.usageLimit },
    permitERC4337Paymaster: false,
    erc7739: 'none',
    fallbackAction: 'none',
    tokenId: ctx.tokenId,
    actions,
  }
}
