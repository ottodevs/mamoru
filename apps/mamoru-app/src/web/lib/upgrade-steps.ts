import type { FundingView, OpView } from '@mamoru/domain'
import { opLine } from './ops.ts'
import { isMultichainTarget } from './policies.ts'
import { chainLabel, poolAddress } from './positions.ts'
import { usd, MIN_ENTRY_USDC } from './money.ts'
import { clockOrDate } from './time.ts'
import { transferNow, transferOfBridge, transferOfFlight, type Transfer } from './transfer.ts'

// otto/mamoru#263: the move of a running account to the mix with Monad, as the steps it really takes (Brais's beta, 1 Nov:
// two approvals, his Monad Safe, a trim and a swap on Base, the burn, Circle's confirmation, the mint, the Monad position),
// derived from what the app already reads: the account's ops (owner and engine), the Monad Safe the funding view names
// (`remote`), the money map (in-flight row, Monad's chain read) and the bridge op's progress. Nothing here is guessed: a
// step the data does not show yet is pending, never done.

export type StepState = 'done' | 'active' | 'waiting' | 'pending' | 'failed'
export type StepLink = { chainId: number; tx: string; text: string }
export type UpgradeStep = {
  id: 'approve' | 'safe' | 'rebalance' | 'bridge' | 'arrive' | 'lp'
  label: string
  state: StepState
  at?: string
  detail?: string
  links: StepLink[]
  /** The Monad Safe (step 'safe'). */
  safe?: { chainId: number; address: string }
  /** The transfer behind 'bridge' and 'arrive'. */
  transfer?: Transfer
}
export type Upgrade = { startedAt: string; steps: UpgradeStep[]; current: number; done: boolean; title: string }

export const upgradeCopy = {
  labels: {
    approve: 'Approve the move on Base',
    safe: 'Create your Safe on Monad',
    rebalance: 'Rebalance on Base',
    bridge: 'Send the Monad share',
    arrive: 'Arrive on Monad',
    lp: 'Open the Monad position',
  },
  done: 'Your new mix is in place on Base and Monad',
  approving: 'Confirming your approval on Base',
  approvals: (n: number) => `${n} approvals`,
  approveFailed: 'Needs another approval. Nothing has moved.',
  settingUp: 'Setting up your Safe on Monad',
  rebalancing: 'Mamoru is adjusting your Base positions',
  rebalanceNext: 'Starts once your approval is confirmed',
  sendFailed: 'The send did not go through. That money is still on Base.',
  finishedAfter: (time: string) => `Base finished its part at ${time}, while the Monad share was on its way.`,
  waitingLp: (amount: string) => `${amount} USDC is in your Monad Safe, waiting to be invested.`,
  step: (n: number, of: number) => `Step ${n} of ${of}`,
  headline: {
    approve: 'Confirming your approval on Base',
    approveFailed: 'Your approval needs another try',
    failed: 'This step did not complete',
    rebalance: 'Adjusting your Base positions',
    bridge: 'Sending the Monad share',
    arrive: 'Moving the Monad share',
    late: 'The Monad share is taking longer than usual',
    lp: 'Opening the Monad position',
    lpWaiting: 'Waiting to invest on Monad',
  },
}

/** How far back the approvals of one move can be (a plan split in two signatures lands within minutes). */
const APPROVALS_WINDOW_MS = 30 * 60_000
/** How long the finished view stays on Home. */
export const DONE_FOR_MS = 24 * 60 * 60_000

const owner = (o: OpView) => o.opId.startsWith('own-')
const signed = (o: OpView) => !(o.state === 'proposed' && o.code !== 'ARMED' && !o.txHash)
const t = (iso: string) => Date.parse(iso)

/** A pool of the remote chain only (Monad): an op on it is not a Base move and is never linked on Basescan. */
function remotePool(pool: string | undefined, remoteChain: number): boolean {
  return !!pool && poolAddress(pool, remoteChain) !== null && poolAddress(pool, 8453) === null
}

/**
 * The upgrade on screen, or null when there is none to show: no move to a mix with another chain offered or signed, a
 * routine renewal of an account that already sent money to Monad before it, or a move finished more than a day ago.
 * A move that is not finished stays, however long it takes (review r1 of #263).
 */
export function upgradeJourney(f: FundingView | undefined, ops: OpView[], now: number = Date.now()): Upgrade | null {
  if (!f) return null
  const approvals = ops.filter((o) => owner(o) && (o.kind === 'renew' || o.kind === 'migrate-v4') && signed(o)).sort((a, b) => t(a.updatedAt) - t(b.updatedAt))
  const last = approvals.at(-1)
  if (!last) return null
  const window = approvals.filter((o) => t(o.updatedAt) >= t(last.updatedAt) - APPROVALS_WINDOW_MS)
  // A failed attempt that a later one replaced is a retry, not this move's state (review r1: it held "Confirming" forever).
  const group = window.filter((o, i) => o.state !== 'failed' || !window.slice(i + 1).some((x) => x.state !== 'failed'))
  const start = window[0]!.updatedAt
  const failed = group.at(-1)!.state === 'failed'
  // Signed and not landed yet, or the last one failed: the move is still the one on offer.
  const inFlight = failed || group.some((o) => o.state === 'submitted' || o.state === 'proposed')
  const movingTo = inFlight && !!f.approval?.upgrade && isMultichainTarget(f.approval.upgradePolicy)
  const onMix = isMultichainTarget(f.approval?.policyId)
  if (!movingTo && !onMix) return null

  const remoteChain = f.remote?.chainId ?? 143
  // Money already sent to that chain before this approval: the account was moved before, this is a routine renewal.
  if (!movingTo && ops.some((o) => o.bridge?.chainId === remoteChain && t(o.updatedAt) < t(start))) return null
  const monad = f.money?.chains.filter((c) => c.chainId === remoteChain) ?? []
  const monadPositions = monad.reduce((n, c) => n + c.positions.length, 0)
  const monadIdle = monad.reduce((a, c) => a + c.idle.reduce((x, i) => x + BigInt(i.valueUsdc), 0n), 0n)
  const after = ops.filter((o) => !owner(o) && t(o.updatedAt) >= t(start) && (o.state === 'confirmed' || o.state === 'submitted' || (o.state === 'failed' && !!o.bridge)))
  const bridgeOp = after.filter((o) => o.bridge && o.bridge.chainId === remoteChain).at(-1)
  // Only a transfer of this move (after its first approval), failed ones included: a failed send is said, not hidden.
  const flight = f.money?.inFlight.filter((x) => x.to === remoteChain && (x.burnedAt ? t(x.burnedAt) >= t(start) : !!bridgeOp)).at(-1)
  const transfer = flight ? transferOfFlight(flight, now) : bridgeOp?.bridge ? transferOfBridge(bridgeOp.bridge, 8453, now) : undefined
  // A routine renewal of an account already working on Monad is no move: nothing to follow.
  if (!movingTo && !transfer && monadPositions > 0) return null

  const live = group.filter((o) => o.state !== 'failed')
  const allConfirmed = !failed && live.every((o) => o.state === 'confirmed')
  const approve: UpgradeStep = {
    id: 'approve', label: upgradeCopy.labels.approve,
    state: failed ? 'failed' : allConfirmed ? 'done' : 'active',
    at: live.filter((o) => o.state === 'confirmed').at(-1)?.updatedAt,
    detail: failed ? upgradeCopy.approveFailed : allConfirmed ? (live.length > 1 ? upgradeCopy.approvals(live.length) : undefined) : upgradeCopy.approving,
    links: live.flatMap((o) => (o.txHash ? [{ chainId: 8453, tx: o.txHash, text: opLine(o) }] : [])),
  }
  const approved = approve.state === 'done'
  // Every later step waits for the approval: a Safe or Monad money that predates it is not this move's progress.
  const safeReady = approved && (!!f.remote?.ready || monad.some((c) => c.read.at !== null))
  const safe: UpgradeStep = {
    id: 'safe', label: upgradeCopy.labels.safe,
    state: safeReady ? 'done' : approved ? 'active' : 'pending',
    ...(approved && !safeReady ? { detail: upgradeCopy.settingUp } : {}),
    links: [],
    ...(f.remote ? { safe: { chainId: f.remote.chainId, address: f.remote.address } } : monad[0] ? { safe: { chainId: monad[0].chainId, address: monad[0].safe } } : {}),
  }
  const moves = after.filter((o) => !o.bridge && !remotePool(o.pool, remoteChain))
  const busy = moves.some((o) => o.state === 'submitted') || (!!f.progress && f.progress.step !== 'bridging')
  const sent = !!transfer && transfer.step >= 1
  // Base keeps placing its own share while the Monad share travels (Brais: the WETH swap and mint landed after the burn).
  // The step's time is its last move before the burn, so no later step reads as finished first; what Base did after the
  // burn is said with its own real time.
  const confirmedMoves = moves.filter((o) => o.state === 'confirmed')
  const burnAt = transfer?.burnedAt ? t(transfer.burnedAt) : null
  const beforeBurn = burnAt === null ? confirmedMoves : confirmedMoves.filter((o) => t(o.updatedAt) <= burnAt)
  const afterBurn = burnAt === null ? [] : confirmedMoves.filter((o) => t(o.updatedAt) > burnAt)
  // Done only once the share was sent (or its send failed, said on its own step) and nothing is in progress on Base: between two Base moves it is still active.
  const rebalanced = approved && (sent || transfer?.step === -1) && !busy
  const rebalance: UpgradeStep = {
    id: 'rebalance', label: upgradeCopy.labels.rebalance,
    state: !approved ? 'pending' : rebalanced ? 'done' : 'active',
    ...(rebalanced && beforeBurn.length ? { at: beforeBurn.at(-1)!.updatedAt } : {}),
    ...(!approved ? {} : !rebalanced ? { detail: upgradeCopy.rebalancing } : afterBurn.length ? { detail: upgradeCopy.finishedAfter(clockOrDate(afterBurn.at(-1)!.updatedAt)) } : {}),
    links: moves.flatMap((o) => (o.txHash ? [{ chainId: 8453, tx: o.txHash, text: opLine(o) }] : [])),
  }
  const bridge: UpgradeStep = {
    id: 'bridge', label: upgradeCopy.labels.bridge,
    state: sent ? 'done' : transfer?.step === 0 ? 'active' : transfer?.step === -1 ? 'failed' : 'pending',
    ...(transfer?.burnedAt && sent ? { at: transfer.burnedAt } : {}),
    ...(transfer?.step === 0 ? { detail: transferNow(transfer) } : transfer?.step === -1 ? { detail: upgradeCopy.sendFailed } : {}),
    links: transfer?.burnTx ? [{ chainId: transfer.from, tx: transfer.burnTx, text: `${usd(transfer.amountUsdc)} USDC sent from ${chainLabel(transfer.from)}` }] : [],
    ...(transfer ? { transfer } : {}),
  }
  // Arrived only by this move's transfer: Monad money that was there before (a deposit, dust) is no arrival.
  const arrived = sent && transfer!.step === 3
  const arrive: UpgradeStep = {
    id: 'arrive', label: upgradeCopy.labels.arrive,
    state: arrived ? 'done' : sent ? (transfer!.stuck ? 'waiting' : 'active') : 'pending',
    ...(arrived && transfer?.mintedAt ? { at: transfer.mintedAt } : {}),
    ...(sent && !arrived ? { detail: transferNow(transfer!) } : {}),
    links: transfer?.mintTx ? [{ chainId: transfer.to, tx: transfer.mintTx, text: `Arrived on ${chainLabel(transfer.to)}` }] : [],
    ...(transfer ? { transfer } : {}),
  }
  const lp: UpgradeStep = {
    id: 'lp', label: upgradeCopy.labels.lp,
    state: arrived && monadPositions > 0 ? 'done' : arrived && monadIdle >= MIN_ENTRY_USDC ? 'waiting' : 'pending',
    ...(arrived && monadPositions === 0 && monadIdle >= MIN_ENTRY_USDC ? { detail: upgradeCopy.waitingLp(usd(monadIdle)) } : {}),
    links: [],
  }
  const steps = [approve, safe, rebalance, bridge, arrive, lp]
  const done = steps.every((s) => s.state === 'done')
  // Done: stays a day after its last known step time (the Monad position has none of its own: the arrival's stands in).
  const doneAt = Math.max(...steps.flatMap((s) => (s.at ? [t(s.at)] : [])), ...afterBurn.map((o) => t(o.updatedAt)), t(start))
  if (done && now - doneAt > DONE_FOR_MS) return null
  const current = done ? steps.length - 1 : steps.findIndex((s) => s.state !== 'done')
  const cur = steps[current]!
  return { startedAt: start, steps, current, done, title: done ? upgradeCopy.done : headline(cur) }
}

/** The current step as the card's title: short, in words, what is happening now. */
function headline(s: UpgradeStep): string {
  const h = upgradeCopy.headline
  if (s.state === 'failed') return s.id === 'approve' ? h.approveFailed : h.failed
  switch (s.id) {
    case 'approve':
      return h.approve
    case 'safe':
      return upgradeCopy.settingUp
    case 'rebalance':
      return h.rebalance
    case 'bridge':
      return h.bridge
    case 'arrive':
      return s.transfer?.stuck ? h.late : s.transfer ? transferNow(s.transfer) : h.arrive
    case 'lp':
      return s.state === 'waiting' ? h.lpWaiting : h.lp
  }
}
