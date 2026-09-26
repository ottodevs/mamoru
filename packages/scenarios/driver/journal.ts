import type { Hex } from 'viem'
import type { UserOperation } from 'viem/account-abstraction'
import { ReasonError, type ReasonCode } from '@mamoru/domain'
import type { Decision, GateStep, Proposal } from '@mamoru/decide'
import { checkTransition, isTerminal, type OpKind, type OpState } from '@mamoru/journal'
import type { Simulation } from '@mamoru/rpc'
import type { Execution } from '@mamoru/account/safe'
import type { BundlerReceipt } from '@mamoru/erc4337'

export type Inclusion = { blockNumber: bigint; blockHash: Hex; txHash: Hex; success: boolean; actualGasCost: bigint }

/** Plan §11.2, kept in memory by the in-process driver. The Durable Object of T004 persists the same fields. */
export type OpRecord = {
  opId: string
  decisionId: Hex
  premiseHash: Hex
  kind: OpKind
  causeCode: ReasonCode
  intent: Proposal
  observationBlock: bigint
  observationHash: Hex
  policyVersion: string
  state: OpState
  stateCode: ReasonCode
  grantName: string
  permissionId?: Hex
  prepareBlock?: bigint
  quote?: { amountIn: bigint; amountOut: bigint; amountOutMinimum: bigint }
  calls?: Execution[]
  callData?: Hex
  precheck?: ReasonCode
  nonceKey?: bigint
  nonce?: bigint
  ehg: GateStep[]
  simulation?: Simulation
  userOp?: UserOperation<'0.7'>
  userOpHash?: Hex
  bundlerReceipt?: BundlerReceipt
  included?: Inclusion
  confirmedSafeBlock?: bigint
  mintedTokenId?: bigint
}

export type TransitionRecord = { opId: string; seq: number; from: OpState | null; to: OpState; code: ReasonCode; actor: 'workflow'; detail?: string }

export type DecisionRecord = { decision: Decision; opId: string | null; code?: 'REVIEW_DEDUPED' }

/**
 * The diary of one account in one process: decisions, operations and an
 * append-only transition history. Every move goes through the plan §10
 * machine, and a second live operation is refused (INV-SLOT).
 */
export class MemoryJournal {
  readonly decisions: DecisionRecord[] = []
  readonly ops: OpRecord[] = []
  readonly transitions: TransitionRecord[] = []
  /** userOp hashes in the order they reached `signed`, for INV-PERSIST-FIRST. */
  readonly signedHashes: Hex[] = []
  private liveOpId: string | null = null
  private seq = 0

  get live(): OpRecord | null {
    return this.liveOpId ? this.op(this.liveOpId) : null
  }

  op(opId: string): OpRecord {
    const o = this.ops.find((x) => x.opId === opId)
    if (!o) throw new Error(`no op ${opId}`)
    return o
  }

  lastDiscarded(): OpRecord | undefined {
    return [...this.ops].reverse().find((o) => o.state === 'discarded')
  }

  recordDecision(decision: Decision, code?: 'REVIEW_DEDUPED'): DecisionRecord {
    const r: DecisionRecord = { decision, opId: null, code }
    this.decisions.push(r)
    return r
  }

  /** FR-ENG-015: one decision, at most one operation. */
  propose(record: DecisionRecord, grantName: string): OpRecord {
    if (this.liveOpId) throw new ReasonError('OP_SLOT_BUSY', `op ${this.liveOpId} is live`)
    const d = record.decision
    if (!d.proposal) throw new Error('a hold decision has no operation')
    if (record.opId) throw new Error(`decision ${d.decisionId} already produced ${record.opId}`)
    const op: OpRecord = {
      opId: `op-${++this.seq}`,
      decisionId: d.decisionId,
      premiseHash: d.premiseHash,
      kind: d.proposal.kind,
      causeCode: d.reason,
      intent: d.proposal,
      observationBlock: d.observationRef.block,
      observationHash: d.observationRef.hash,
      policyVersion: d.policyRef.version,
      state: 'proposed',
      stateCode: d.reason,
      grantName,
      ehg: [],
    }
    this.ops.push(op)
    record.opId = op.opId
    this.liveOpId = op.opId
    this.transitions.push({ opId: op.opId, seq: 0, from: null, to: 'proposed', code: d.reason, actor: 'workflow' })
    return op
  }

  move(opId: string, to: OpState, code: ReasonCode, patch: Partial<OpRecord> = {}, detail?: string): OpRecord {
    const op = this.op(opId)
    const check = checkTransition(op.state, to, code)
    if (!check.ok) throw new ReasonError(check.code, `${opId}: ${check.detail}`)
    const from = op.state
    Object.assign(op, patch, { state: to, stateCode: code })
    const seq = this.transitions.filter((t) => t.opId === opId).length
    this.transitions.push({ opId, seq, from, to, code, actor: 'workflow', detail })
    if (to === 'signed' && op.userOpHash) this.signedHashes.push(op.userOpHash)
    if (isTerminal(to)) this.liveOpId = null
    return op
  }

  pathOf(opId: string): OpState[] {
    return this.transitions.filter((t) => t.opId === opId).map((t) => t.to)
  }
}
