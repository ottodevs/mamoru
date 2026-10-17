import type { OpView } from '@mamoru/domain'
import { formatAmount, shortHex } from './format.ts'
import { usd, usdPlain } from './money.ts'
import { pairLabel } from './positions.ts'

const owner = (op: OpView) => op.opId.startsWith('own-')
/** "USDC/cbBTC": the pool's pair, no spaces, matching the style history lines used before pools were tagged. */
const pair = (pool: string) => pairLabel(pool).replace(/ /g, '')
/** Engine op kind from its id (eng-…-enter_swap), or null for an owner op. */
const engineKind = (op: OpView) => (owner(op) ? null : (/(enter_swap|enter_mint|harvest|close_position|convert)$/.exec(op.opId)?.[1] ?? null))

/** Failures that only mean another op took over (a newer approval, a stop): nothing for the user to do. */
const INTERNAL_FAILURES = new Set(['ARMED_SUPERSEDED', 'STOPPED', 'ALREADY_ACTIVE'])

/** Start refused because the deposit was over the cap. CAP_EXCEEDED is what operators before DEPOSIT_OVER_CAP stored. */
export function overCapRefusal(op: OpView): boolean {
  return op.kind === 'activate' && op.state === 'failed' && (op.code === 'DEPOSIT_OVER_CAP' || op.code === 'CAP_EXCEEDED')
}

/**
 * Start refused because Mamoru does not pay this account's gas reserve (otto/mamoru#82). The owner can always start
 * with their own: the refusal at prepare names the exact ETH; this is the line history keeps.
 */
const SUBSIDY_REFUSED: Record<string, string> = {
  SUBSIDY_BELOW_MINIMUM: 'Start needs gas: add USDC, or send ETH on Base to your account',
  SUBSIDY_EARLY_EXIT: 'Start needs gas: funds left soon after a start Mamoru paid for. Send ETH on Base to your account',
  SUBSIDY_ACCOUNT_LIMIT: 'Start needs gas: Mamoru already paid this account\'s reserve. Send ETH on Base to your account',
  SUBSIDY_PASSKEY_LIMIT: 'Start needs gas: Mamoru already paid this passkey\'s reserves. Send ETH on Base to your account',
  SUBSIDY_DAILY_BUDGET: 'Start needs gas: Mamoru-paid starts are used up for now. Try later, or send ETH on Base to your account',
}

/**
 * A start whose transaction may still be on chain and that the operator left for a person to confirm (otto/mamoru#15:
 * `needsReview` on the op, sent by operators from that change on). Approving again meanwhile could act twice: the
 * app waits and says so.
 */
export function confirmingStart(op: OpView): boolean {
  return op.kind === 'activate' && op.state === 'failed' && (op as OpView & { needsReview?: boolean }).needsReview === true
}

export const CONFIRMING_START = "We're confirming your start. This usually settles within minutes; if it takes longer, support will confirm it with you."

/** An owner action that failed after the passkey signed it: the user approves it again. An over-cap refusal is not one: approving again cannot help, nor is a start being confirmed. */
export function needsRetry(op: OpView): boolean {
  return owner(op) && op.state === 'failed' && !overCapRefusal(op) && !confirmingStart(op)
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
      if (confirmingStart(op)) return CONFIRMING_START
      if (failed && op.code && SUBSIDY_REFUSED[op.code]) return SUBSIDY_REFUSED[op.code]!
      if (failed) return 'Start needs another approval'
      if (done) return 'Mamoru started'
      return op.code === 'ARMED' || op.state === 'proposed' ? 'Start approved' : 'Starting Mamoru'
    case 'renew':
      if (op.extend) {
        if (failed) return 'Approval needs another try'
        return done ? 'Approval extended' : 'Extending approval'
      }
      if (failed) return 'Renewal needs another approval'
      return done ? 'Approval renewed' : 'Renewing approval'
    case 'transfer':
      if (failed) return 'Withdrawal needs another approval'
      return withdrewLine(op, done)
    case 'exit':
      if (owner(op)) {
        if (failed) return 'Stop needs another approval'
        return done ? 'Allocation stopped' : 'Stopping allocation'
      }
      if (!op.pool) return done ? 'Closed a position' : 'Closing a position'
      return done ? `Closed ${pair(op.pool)} position` : `Closing ${pair(op.pool)} position`
    case 'enter':
      if (engineKind(op) === 'enter_swap') {
        if (!op.tokenIn || !op.tokenOut) return done ? 'Swapped' : 'Swapping'
        const from = op.amountIn ? formatAmount(op.amountIn, op.tokenIn) : op.tokenIn
        return done ? `Swapped ${from} to ${op.tokenOut}` : `Swapping ${from} to ${op.tokenOut}`
      }
      if (!op.pool) return done ? 'Opened a position' : 'Opening a position'
      return done ? `Opened ${pair(op.pool)} position` : `Opening ${pair(op.pool)} position`
    case 'reduce': {
      if (engineKind(op) === 'harvest') {
        const where = op.pool ? ` from ${pair(op.pool)}` : ''
        if (op.convert) return done ? `Collected fees${where}, converted ${op.convert} to USDC` : `Collecting fees${where}, converting ${op.convert} to USDC`
        return done ? `Collected fees${where}` : `Collecting fees${where}`
      }
      if (!op.pool) return done ? 'Rebalanced' : 'Rebalancing'
      return done ? `Rebalanced ${pair(op.pool)}` : `Rebalancing ${pair(op.pool)}`
    }
  }
}

export function opTone(op: OpView): 'done' | 'pending' | 'retry' {
  return confirmingStart(op) ? 'pending' : op.state === 'failed' ? 'retry' : op.state === 'confirmed' ? 'done' : 'pending'
}

/**
 * What the history shows: confirmed actions, owner actions in flight, engine actions on chain, and an owner
 * failure only while it is the latest of its kind. Engine attempts that failed and superseded failures stay hidden.
 *
 * otto/mamoru#131 asked whether this ever shows genuine duplicates (retries, a top-up into a bucket that
 * already has a position). It does not, by design: a retried failure is already collapsed server-side
 * (`collapseFailed` in the operator, by kind+code, before it ever reaches here), and a top-up mints a second,
 * real position (its own tokenId) rather than reusing the first one, so two rows for two deposits is correct,
 * not a duplicate. The one known way a stale row can linger — an engine op left `submitted` across an operator
 * restart that the next run does not reconcile — is tracked separately (otto/mamoru#124, engine op restart
 * reconciliation) and is not something this function can tell apart from a real pending op with the fields it has.
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
  // A start being confirmed is not over: no new Start is offered while it may still land.
  return last !== undefined && (last.state !== 'failed' || confirmingStart(last))
}

/** The account ran before and was stopped: a confirmed activation exists. */
export function everStarted(ops: OpView[]): boolean {
  return ops.some((o) => owner(o) && o.kind === 'activate' && o.state === 'confirmed')
}
