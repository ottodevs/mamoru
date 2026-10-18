import { decodeAbiParameters, hexToBigInt, isAddressEqual, size, slice, toFunctionSelector, type Hex } from 'viem'
import type { Address, ReasonCode } from '@mamoru/domain'
import type { ResolvedParamRule, SessionGrant } from '@mamoru/policy'
import type { RegistryName } from '@mamoru/registry'
import { CALLTYPE_BATCH, CALLTYPE_SINGLE, EXECTYPE_DEFAULT, type Execution } from '../safe/index.ts'
import { checkActionPolicyCall, type ActionPolicyPoolConfig, type ActionPolicyReads, type ActionPolicySpend, type ActionPolicySpendAcc } from './action-policy.ts'

export type { ActionPolicyPoolConfig, ActionPolicyReads, ActionPolicySpend } from './action-policy.ts'

const SEL_EXECUTE = toFunctionSelector('function execute(bytes32,bytes)')
const SEL_EXECUTE_FROM_EXECUTOR = toFunctionSelector('function executeFromExecutor(bytes32,bytes)')
const SEL_EXECUTE_USER_OP = toFunctionSelector(
  'function executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)',
)

export type KnownGrant = { permissionId: Hex; grant: SessionGrant; revoked: boolean }

/** What the engine knows about its sessions: activations, revocations and what included userOps consumed. */
export class SessionLedger {
  private readonly grants = new Map<string, KnownGrant>()
  private readonly uses = new Map<string, number>()
  private readonly cumulative = new Map<string, bigint>()
  // Spec 007 (#151) T4: the action-policy pools this engine watches (config known off chain — the contract has no
  // public getter for Budget), the freshest TWAP/Spend reads for each, and the tokenIds admitted per pool (the
  // engine's own allowedTokenIds/onMinted). Keyed by RegistryName, like `SessionGrant.pool`: a v4 grant is always
  // single-pool, so precheck never needs to resolve an on-chain pool address to look one of these up.
  private readonly actionPools = new Map<RegistryName, ActionPolicyPoolConfig>()
  private readonly actionReads = new Map<RegistryName, ActionPolicyReads>()
  private readonly admitted = new Map<bigint, RegistryName>()

  activate(permissionId: Hex, grant: SessionGrant): void {
    this.grants.set(permissionId.toLowerCase(), { permissionId, grant, revoked: false })
  }

  revoke(permissionId: Hex): void {
    const g = this.grants.get(permissionId.toLowerCase())
    if (g) g.revoked = true
  }

  revokedIds(): Hex[] {
    return [...this.grants.values()].filter((g) => g.revoked).map((g) => g.permissionId)
  }

  get(permissionId: Hex): KnownGrant | undefined {
    return this.grants.get(permissionId.toLowerCase())
  }

  usesOf(permissionId: Hex): number {
    return this.uses.get(permissionId.toLowerCase()) ?? 0
  }

  usedOf(key: string): bigint {
    return this.cumulative.get(key) ?? 0n
  }

  /** Record a userOp that the chain included, with the calls the pre-check decoded. */
  recordIncluded(permissionId: Hex, calls: Execution[]): void {
    const pid = permissionId.toLowerCase()
    this.uses.set(pid, this.usesOf(permissionId) + 1)
    const known = this.grants.get(pid)
    if (!known) return
    for (const c of calls) {
      const a = matchAction(known.grant, c)
      if (!a) continue
      for (const [ri, rule] of a.action.params.entries()) {
        if (rule.cumulativeLimit === undefined) continue
        const key = cumulativeKey(permissionId, a.index, ri)
        this.cumulative.set(key, this.usedOf(key) + word(c.callData, rule.index))
      }
    }
  }

  /**
   * otto/mamoru#149: how much of its approval a grant has used, from the userOps the chain included: uses against the
   * usage limit, and the fullest cumulative rule (basis points of its cap; null when the grant has none).
   */
  usageOf(permissionId: Hex): { used: number; limit: number; spentBps: number | null } | undefined {
    const known = this.grants.get(permissionId.toLowerCase())
    if (!known) return undefined
    let spentBps: number | null = null
    for (const [ai, a] of known.grant.actions.entries()) {
      for (const [ri, rule] of a.params.entries()) {
        if (rule.cumulativeLimit === undefined) continue
        const used = this.usedOf(cumulativeKey(permissionId, ai, ri))
        const bps = rule.cumulativeLimit === 0n ? (used > 0n ? 10_000 : 0) : Number((used * 10_000n) / rule.cumulativeLimit)
        spentBps = Math.max(spentBps ?? 0, bps)
      }
    }
    return { used: this.usesOf(permissionId), limit: known.grant.userOp.usageLimit, spentBps }
  }

  // ---------------------------------------------------------------- spec 007 T4: action-policy watch state

  /** Registers (or updates) the config of a pool covered by a deployed MamoruActionPolicy. Idempotent: call it
   * every review a covered pool is touched, same as `watchActionPolicyPool` naming suggests — cheap, no RPC. */
  watchActionPolicyPool(config: ActionPolicyPoolConfig): void {
    this.actionPools.set(config.pool, config)
  }

  actionPolicyPool(pool: RegistryName): ActionPolicyPoolConfig | undefined {
    return this.actionPools.get(pool)
  }

  /** The fresh TWAP tick + on-chain Spend/generation reads for `pool` (one `observe` + one `spendOf` +
   * `generationOf` eth_call, made by the caller right before precheck — see action-policy.ts's file header). */
  syncActionPolicyReads(pool: RegistryName, reads: ActionPolicyReads): void {
    this.actionReads.set(pool, reads)
  }

  actionPolicyReads(pool: RegistryName): ActionPolicyReads | undefined {
    return this.actionReads.get(pool)
  }

  /** A tokenId minted through `MamoruActionPolicy.mint` for `pool` (mirrors the contract's `admittedPool`,
   * written only when the engine's own `enter_mint` confirms under a v4 pool — see engine.ts's `afterConfirmed`). */
  admitTokenId(tokenId: bigint, pool: RegistryName): void {
    this.admitted.set(tokenId, pool)
  }

  isAdmitted(tokenId: bigint, pool: RegistryName): boolean {
    return this.admitted.get(tokenId) === pool
  }

  clone(): SessionLedger {
    const l = new SessionLedger()
    for (const [k, v] of this.grants) l.grants.set(k, { ...v })
    for (const [k, v] of this.uses) l.uses.set(k, v)
    for (const [k, v] of this.cumulative) l.cumulative.set(k, v)
    for (const [k, v] of this.actionPools) l.actionPools.set(k, v)
    for (const [k, v] of this.actionReads) l.actionReads.set(k, v)
    for (const [k, v] of this.admitted) l.admitted.set(k, v)
    return l
  }
}

function cumulativeKey(permissionId: Hex, actionIndex: number, ruleIndex: number): string {
  return `${permissionId.toLowerCase()}:${actionIndex}:${ruleIndex}`
}

function word(callData: Hex, index: number): bigint {
  const start = 4 + index * 32
  if (size(callData) < start + 32) return -1n
  return hexToBigInt(slice(callData, start, start + 32))
}

function matchAction(grant: SessionGrant, c: Execution) {
  if (size(c.callData) < 4) return undefined
  const selector = slice(c.callData, 0, 4).toLowerCase()
  const index = grant.actions.findIndex((a) => isAddressEqual(a.targetAddress, c.target) && a.selector.toLowerCase() === selector)
  return index < 0 ? undefined : { index, action: grant.actions[index]! }
}

function holds(rule: ResolvedParamRule, value: bigint): boolean {
  if (value < 0n) return false
  switch (rule.condition) {
    case 'EQUAL':
      return value === rule.ref
    case 'GREATER_THAN':
      return value > rule.ref
    case 'LESS_THAN':
      return value < rule.ref
    case 'GREATER_THAN_OR_EQUAL':
      return value >= rule.ref
    case 'LESS_THAN_OR_EQUAL':
      return value <= rule.ref
    case 'NOT_EQUAL':
      return value !== rule.ref
  }
}

export type SessionUserOp = {
  sender: Address
  callData: Hex
  signature: Hex
  paymaster?: Address | undefined
  paymasterAndData?: Hex | undefined
}

export type PrecheckResult =
  | { ok: true; permissionId: Hex; calls: Execution[] }
  | { ok: false; code: ReasonCode; detail: string; permissionId?: Hex }

function deny(code: ReasonCode, detail: string, permissionId?: Hex): PrecheckResult {
  return { ok: false, code, detail, permissionId }
}

/** Splits Safe7579.execute calldata into executions. Returns a denial code for anything but single or batch, default exec type. */
export function decodeExecute(callData: Hex): { calls: Execution[] } | { code: ReasonCode; detail: string } {
  if (size(callData) < 4) return { code: 'POLICY_DENIED_TARGET', detail: 'empty callData' }
  const selector = slice(callData, 0, 4).toLowerCase()
  if (selector === SEL_EXECUTE_FROM_EXECUTOR || selector === SEL_EXECUTE_USER_OP) {
    return { code: 'POLICY_DENIED_CALLTYPE', detail: `account entry point ${selector}` }
  }
  if (selector !== SEL_EXECUTE) return { code: 'POLICY_DENIED_TARGET', detail: `account function ${selector}` }
  let mode: Hex
  let payload: Hex
  try {
    ;[mode, payload] = decodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes' }], slice(callData, 4))
  } catch {
    return { code: 'POLICY_DENIED_CALLTYPE', detail: 'undecodable execute' }
  }
  const callType = parseInt(mode.slice(2, 4), 16)
  const execType = parseInt(mode.slice(4, 6), 16)
  if (execType !== EXECTYPE_DEFAULT) return { code: 'POLICY_DENIED_CALLTYPE', detail: `exec type ${execType}` }
  if (BigInt(`0x${mode.slice(6)}`) !== 0n) return { code: 'POLICY_DENIED_CALLTYPE', detail: 'mode selector or payload set' }
  if (callType === CALLTYPE_SINGLE) {
    if (size(payload) < 52) return { code: 'POLICY_DENIED_CALLTYPE', detail: 'short single execution' }
    return {
      calls: [{ target: slice(payload, 0, 20) as Address, value: hexToBigInt(slice(payload, 20, 52)), callData: size(payload) > 52 ? slice(payload, 52) : '0x' }],
    }
  }
  if (callType === CALLTYPE_BATCH) {
    try {
      const [execs] = decodeAbiParameters(
        [{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'callData', type: 'bytes' }] }],
        payload,
      )
      return { calls: execs.map((e) => ({ target: e.target, value: e.value, callData: e.callData })) }
    } catch {
      return { code: 'POLICY_DENIED_CALLTYPE', detail: 'undecodable batch' }
    }
  }
  return { code: 'POLICY_DENIED_CALLTYPE', detail: `call type ${callType}` }
}

/**
 * FR-ACC-010: the engine's pre-check of a session userOp against the grant it
 * claims, before signing. Defence in depth; the chain still validates.
 */
export function precheck(op: SessionUserOp, ctx: { chainId: number; now: number; ledger: SessionLedger }): PrecheckResult {
  const sig = op.signature
  if (size(sig) < 1) return deny('SESSION_MISSING', 'no signature')
  const mode = slice(sig, 0, 1)
  if (mode !== '0x00') return deny('POLICY_DENIED_TARGET', `signature mode ${mode}`)
  if (size(sig) < 33) return deny('SESSION_MISSING', 'no permissionId')
  const permissionId = slice(sig, 1, 33)
  const known = ctx.ledger.get(permissionId)
  if (!known) return deny('SESSION_MISSING', 'unknown permissionId', permissionId)
  const g = known.grant
  if (known.revoked) return deny('SESSION_REVOKED', 'permissionId revoked', permissionId)
  if (ctx.chainId !== g.chainId) return deny('SIGN_CHAIN_NOT_ALLOWED', `chain ${ctx.chainId}, grant ${g.chainId}`, permissionId)
  if (!isAddressEqual(op.sender, g.account)) return deny('SESSION_MISSING', 'grant is for another account', permissionId)
  if (ctx.now < g.userOp.validAfter || ctx.now > g.userOp.validUntil) return deny('SESSION_EXPIRED', 'outside time frame', permissionId)
  if (ctx.ledger.usesOf(permissionId) >= g.userOp.usageLimit) return deny('SESSION_USAGE_SPENT', 'usage limit reached', permissionId)
  if (op.paymaster || (op.paymasterAndData && op.paymasterAndData !== '0x')) {
    return deny('POLICY_DENIED_TARGET', 'paymaster not permitted', permissionId)
  }

  const decoded = decodeExecute(op.callData)
  if ('code' in decoded) return deny(decoded.code, decoded.detail, permissionId)

  const spent = new Map<string, bigint>()
  // Spec 007 (#151) T4: MamoruActionPolicy is added as a SECOND policy next to UniActionPolicy (the grant-level
  // rules above) on a v4 grant's actions; every policy of an action must pass, so this accumulates (c)'s budget
  // charge across the whole batch the way `_spendOk` does in storage, call by call.
  const apSpent: ActionPolicySpendAcc = new Map()
  for (const c of decoded.calls) {
    if (c.value > 0n) return deny('POLICY_DENIED_VALUE', `native value to ${c.target}`, permissionId)
    if (isAddressEqual(c.target, g.account)) return deny('POLICY_DENIED_TARGET', 'call to the account itself', permissionId)
    const a = matchAction(g, c)
    if (!a) return deny('POLICY_DENIED_TARGET', `(${c.target}, ${size(c.callData) >= 4 ? slice(c.callData, 0, 4) : '0x'}) not granted`, permissionId)
    for (const [ri, rule] of a.action.params.entries()) {
      const v = word(c.callData, rule.index)
      if (!holds(rule, v)) return deny(rule.denial, `${a.action.signature} ${rule.field}`, permissionId)
      if (rule.cumulativeLimit !== undefined) {
        const key = cumulativeKey(permissionId, a.index, ri)
        const total = ctx.ledger.usedOf(key) + (spent.get(key) ?? 0n) + v
        if (total > rule.cumulativeLimit) return deny('POLICY_DENIED_CUMULATIVE', `${a.action.signature} ${rule.field}`, permissionId)
        spent.set(key, (spent.get(key) ?? 0n) + v)
      }
    }
    if (g.pool) {
      const apConfig = ctx.ledger.actionPolicyPool(g.pool)
      if (apConfig) {
        const pool = g.pool
        const apReads = ctx.ledger.actionPolicyReads(pool)
        const res = checkActionPolicyCall(c, apConfig, apReads, ctx.now, apSpent, (tokenId) => ctx.ledger.isAdmitted(tokenId, pool))
        if (!res.ok) return deny(res.code, res.detail, permissionId)
      }
    }
  }
  return { ok: true, permissionId, calls: decoded.calls }
}
