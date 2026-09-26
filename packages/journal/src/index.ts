import { BASE_CHAIN_ID, FORBIDDEN_LAB_CHAIN_IDS, type ReasonCode } from '@mamoru/domain'

/** Plan §10: the states of one operation. */
export const OP_STATES = [
  'proposed',
  'discarded',
  'prepared',
  'simulated',
  'signed',
  'submitted',
  'included',
  'confirmed',
  'failed',
  'pending_reconciliation',
] as const
export type OpState = (typeof OP_STATES)[number]

export const OP_KINDS = ['enter_swap', 'enter_mint', 'harvest', 'close_position', 'convert'] as const
export type OpKind = (typeof OP_KINDS)[number]

const TERMINAL: ReadonlySet<OpState> = new Set(['discarded', 'confirmed', 'failed'])

export function isTerminal(state: OpState): boolean {
  return TERMINAL.has(state)
}

/** A code matches an edge by exact value or by a `PREFIX_*` family. */
type CodeRule = ReasonCode | `${string}_*`

const EDGES: Record<string, readonly CodeRule[]> = {
  'proposed>discarded': ['EHG_*', 'PURGA_*', 'SESSION_*', 'OP_PREEMPTED_BY_EXIT'],
  'proposed>prepared': ['EHG_OK'],
  'prepared>discarded': ['EHG_*', 'POLICY_DENIED_*', 'OP_PREEMPTED_BY_EXIT'],
  'prepared>simulated': ['EHG_OK', 'EHG_NO_GO_OVERRIDDEN_BY_EXIT'],
  'simulated>discarded': ['DRY_RUN_STOP', 'OP_DECISION_STALE', 'OP_NONCE_MOVED', 'EHG_OBSERVATION_STALE', 'EHG_OBSERVATION_REORGED', 'OP_PREEMPTED_BY_EXIT', 'SIGN_CHAIN_NOT_ALLOWED'],
  'simulated>signed': ['OP_SIGNED'],
  'signed>submitted': ['BUNDLER_ACCEPTED'],
  'signed>pending_reconciliation': ['RECON_SEND_UNKNOWN', 'BUNDLER_REJECTED', 'BUNDLER_UNAVAILABLE'],
  'submitted>included': ['OP_INCLUDED'],
  'submitted>pending_reconciliation': ['RECON_TIMEOUT'],
  'pending_reconciliation>submitted': ['RECON_RESENT_SAME_BYTES', 'RECON_REPLACED_FEE'],
  'pending_reconciliation>included': ['OP_INCLUDED'],
  'pending_reconciliation>failed': ['RECON_UNINCLUDABLE', 'RECON_NONCE_CONSUMED_BY_OTHER'],
  'included>confirmed': ['EXEC_OK'],
  'included>failed': ['EXEC_INNER_REVERT'],
  'included>pending_reconciliation': ['RECON_REORGED'],
}

function matches(rule: CodeRule, code: ReasonCode): boolean {
  return rule.endsWith('_*') ? code.startsWith(rule.slice(0, -1)) : rule === code
}

export type TransitionCheck = { ok: true } | { ok: false; code: 'SIGN_STATE_INVALID'; detail: string }

/** FR-ENG-004: a transition is legal only along an edge of plan §10 and with one of its codes. */
export function checkTransition(from: OpState, to: OpState, code: ReasonCode): TransitionCheck {
  const rules = EDGES[`${from}>${to}`]
  if (!rules) return { ok: false, code: 'SIGN_STATE_INVALID', detail: `no edge ${from} -> ${to}` }
  if (!rules.some((r) => matches(r, code))) return { ok: false, code: 'SIGN_STATE_INVALID', detail: `${code} does not move ${from} -> ${to}` }
  return { ok: true }
}

export type SignContext = {
  mode: 'production' | 'lab' | 'live'
  chainId: number
  signingChainIds: readonly number[]
  observationAgeSeconds: number
  observationTtlSeconds: number
  observationCanonical: boolean
  preparedNonce: bigint
  chainNonce: bigint
}

/**
 * Live mode (sprint amendment 2026-09-26, owner-approved real-funds path):
 * signing is allowed only on Base and only when the process runs with
 * MAMORU_LIVE=1. Production stays DRY_RUN_STOP; the lab is unchanged.
 */
export function liveSigningAllowed(chainId: number): boolean {
  return chainId === BASE_CHAIN_ID && typeof process !== 'undefined' && process.env?.MAMORU_LIVE === '1'
}

/**
 * Plan §10, "Firma": the four conditions that stop a signature, in order.
 * Returns null when the operation may be signed.
 */
export function signBlocker(ctx: SignContext): ReasonCode | null {
  if (ctx.mode === 'production') return 'DRY_RUN_STOP'
  if (ctx.mode === 'live') {
    if (!liveSigningAllowed(ctx.chainId) || !ctx.signingChainIds.includes(ctx.chainId)) return 'SIGN_CHAIN_NOT_ALLOWED'
  } else if (FORBIDDEN_LAB_CHAIN_IDS.includes(ctx.chainId) || !ctx.signingChainIds.includes(ctx.chainId)) return 'SIGN_CHAIN_NOT_ALLOWED'
  if (!ctx.observationCanonical) return 'EHG_OBSERVATION_REORGED'
  if (ctx.observationAgeSeconds > ctx.observationTtlSeconds) return 'EHG_OBSERVATION_STALE'
  if (ctx.preparedNonce !== ctx.chainNonce) return 'OP_NONCE_MOVED'
  return null
}
