import type { OpView } from '@mamoru/domain'
import { shortHex } from './format.ts'
import { usd, usdPlain } from './money.ts'

const owner = (op: OpView) => op.opId.startsWith('own-')
/** Engine op kind from its id (eng-…-enter_swap), or null for an owner op. */
const engineKind = (op: OpView) => (owner(op) ? null : (/(enter_swap|enter_mint|harvest|close_position|convert)$/.exec(op.opId)?.[1] ?? null))

/** Failures that only mean another op took over (a newer approval, a stop): nothing for the user to do. */
const INTERNAL_FAILURES = new Set(['ARMED_SUPERSEDED', 'STOPPED', 'ALREADY_ACTIVE'])

/** Start refused because the deposit was over the cap. CAP_EXCEEDED is what operators before DEPOSIT_OVER_CAP stored. */
export function overCapRefusal(op: OpView): boolean {
  return op.kind === 'activate' && op.state === 'failed' && (op.code === 'DEPOSIT_OVER_CAP' || op.code === 'CAP_EXCEEDED')
}

/** An owner action that failed after the passkey signed it: the user approves it again. An over-cap refusal is not one: approving again cannot help. */
export function needsRetry(op: OpView): boolean {
  return owner(op) && op.state === 'failed' && !overCapRefusal(op)
}

function withdrewLine(op: OpView, done: boolean): string {
  const verb = done ? 'Withdrew' : 'Withdrawing'
  if (!op.amountUsdc) return `${verb} USDC`
  const to = op.to ? ` to ${shortHex(op.to)}` : ''
  return op.asset && op.asset !== 'USDC' ? `${verb} $${usd(op.amountUsdc)} as ${op.asset}${to}` : `${verb} ${usd(op.amountUsdc)} USDC${to}`
}

/** One plain line per operation: what happened to the money. */
export function opLine(op: OpView): string {
  const done = op.state === 'confirmed'
  const failed = op.state === 'failed'
  switch (op.kind) {
    case 'activate':
      if (overCapRefusal(op)) {
        return op.amountUsdc && op.capUsdc ? `Start refused: ${usd(op.amountUsdc)} USDC is over the ${usdPlain(op.capUsdc)} USDC cap` : 'Start refused: the deposit was over the cap'
      }
      if (failed) return 'Start needs another approval'
      if (done) return 'Mamoru started'
      return op.code === 'ARMED' || op.state === 'proposed' ? 'Start approved' : 'Starting Mamoru'
    case 'transfer':
      if (failed) return 'Withdrawal needs another approval'
      return withdrewLine(op, done)
    case 'exit':
      if (owner(op)) {
        if (failed) return 'Stop needs another approval'
        return done ? 'Allocation stopped' : 'Stopping allocation'
      }
      return done ? 'Closed USDC/cbBTC position' : 'Closing USDC/cbBTC position'
    case 'enter':
      if (engineKind(op) === 'enter_swap') return done ? 'Swapped USDC to cbBTC' : 'Swapping USDC to cbBTC'
      return done ? 'Opened USDC/cbBTC position' : 'Opening USDC/cbBTC position'
    case 'reduce':
      if (engineKind(op) === 'harvest') return done ? 'Collected fees' : 'Collecting fees'
      return done ? 'Rebalanced' : 'Rebalancing'
  }
}

export function opTone(op: OpView): 'done' | 'pending' | 'retry' {
  return op.state === 'failed' ? 'retry' : op.state === 'confirmed' ? 'done' : 'pending'
}

/**
 * What the history shows: confirmed actions, owner actions in flight, engine actions on chain, and an owner
 * failure only while it is the latest of its kind. Engine attempts that failed and superseded failures stay hidden.
 */
export function historyOps(ops: OpView[]): OpView[] {
  const sorted = [...ops].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const seen = new Set<OpView['kind']>()
  return sorted.filter((op) => {
    if (!owner(op)) return op.state === 'confirmed' || op.state === 'submitted'
    const latest = !seen.has(op.kind)
    seen.add(op.kind)
    if (op.state !== 'failed') return true
    return latest && !INTERNAL_FAILURES.has(op.code ?? '')
  })
}

export const TERMINAL = new Set<OpView['state']>(['confirmed', 'failed'])

/** True when the latest activation is armed or running (not failed). */
export function activationLive(ops: OpView[]): boolean {
  // Unsigned prepares (proposed, not armed, no tx) do not count.
  const last = [...ops].filter((o) => o.kind === 'activate' && !(o.state === 'proposed' && o.code !== 'ARMED' && !o.txHash)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  return last !== undefined && last.state !== 'failed'
}

/** The account ran before and was stopped: a confirmed activation exists. */
export function everStarted(ops: OpView[]): boolean {
  return ops.some((o) => owner(o) && o.kind === 'activate' && o.state === 'confirmed')
}
