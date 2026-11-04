import type { FundingView, OpView } from '@mamoru/domain'
import { opLine } from './ops.ts'
import { isMultichainTarget } from './policies.ts'
import { chainLabel } from './positions.ts'
import { usd, MIN_ENTRY_USDC } from './money.ts'
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

/**
 * The upgrade on screen, or null when there is none to show: no move to a mix with another chain offered or signed, a
 * routine renewal of an account already placed on Monad, or a move finished more than a day ago.
 */
export function upgradeJourney(f: FundingView | undefined, ops: OpView[], now: number = Date.now()): Upgrade | null {
  if (!f) return null
  const approvals = ops.filter((o) => owner(o) && (o.kind === 'renew' || o.kind === 'migrate-v4') && signed(o)).sort((a, b) => t(a.updatedAt) - t(b.updatedAt))
  const last = approvals.at(-1)
  if (!last) return null
  const group = approvals.filter((o) => t(o.updatedAt) >= t(last.updatedAt) - APPROVALS_WINDOW_MS)
  const start = group[0]!.updatedAt
  // Signed and not landed yet, or the last one failed: the move is still the one on offer.
  const inFlight = group.some((o) => o.state === 'submitted' || o.state === 'proposed') || group.at(-1)!.state === 'failed'
  const movingTo = inFlight && !!f.approval?.upgrade && isMultichainTarget(f.approval.upgradePolicy)
  const onMix = isMultichainTarget(f.approval?.policyId)
  if (!movingTo && !onMix) return null
  if (now - t(start) > DONE_FOR_MS) return null

  const remoteChain = f.remote?.chainId ?? 143
  const monad = f.money?.chains.filter((c) => c.chainId === remoteChain) ?? []
  const monadPositions = monad.reduce((n, c) => n + c.positions.length, 0)
  const monadIdle = monad.reduce((a, c) => a + c.idle.reduce((x, i) => x + BigInt(i.valueUsdc), 0n), 0n)
  const after = ops.filter((o) => !owner(o) && t(o.updatedAt) >= t(start) && (o.state === 'confirmed' || o.state === 'submitted'))
  const bridgeOp = after.filter((o) => o.bridge && o.bridge.chainId === remoteChain).at(-1)
  const flight = f.money?.inFlight.filter((x) => x.to === remoteChain && x.stage !== 'failed').at(-1)
  const transfer = flight ? transferOfFlight(flight, now) : bridgeOp?.bridge ? transferOfBridge(bridgeOp.bridge, 8453, now) : undefined
  // A routine renewal of an account already working on Monad is no move: nothing to follow.
  if (!movingTo && !transfer && monadPositions > 0) return null

  const failed = group.find((o) => o.state === 'failed' && o === group.at(-1))
  const approve: UpgradeStep = {
    id: 'approve', label: upgradeCopy.labels.approve,
    state: failed ? 'failed' : group.every((o) => o.state === 'confirmed') ? 'done' : 'active',
    at: group.filter((o) => o.state === 'confirmed').at(-1)?.updatedAt,
    detail: failed ? upgradeCopy.approveFailed : group.every((o) => o.state === 'confirmed') ? (group.length > 1 ? upgradeCopy.approvals(group.length) : undefined) : upgradeCopy.approving,
    links: group.flatMap((o) => (o.txHash ? [{ chainId: 8453, tx: o.txHash, text: opLine(o) }] : [])),
  }
  const approved = approve.state === 'done'
  const safeReady = !!f.remote?.ready || monad.some((c) => c.read.at !== null)
  const safe: UpgradeStep = {
    id: 'safe', label: upgradeCopy.labels.safe,
    state: safeReady ? 'done' : approved ? 'active' : 'pending',
    ...(safeReady || !approved ? {} : { detail: upgradeCopy.settingUp }),
    links: [],
    ...(f.remote ? { safe: { chainId: f.remote.chainId, address: f.remote.address } } : monad[0] ? { safe: { chainId: monad[0].chainId, address: monad[0].safe } } : {}),
  }
  const moves = after.filter((o) => !o.bridge)
  const busy = moves.some((o) => o.state === 'submitted') || (!!f.progress && f.progress.step !== 'bridging')
  const rebalance: UpgradeStep = {
    id: 'rebalance', label: upgradeCopy.labels.rebalance,
    state: !approved ? 'pending' : busy ? 'active' : moves.length || transfer ? 'done' : 'active',
    at: moves.filter((o) => o.state === 'confirmed').at(-1)?.updatedAt,
    ...(!approved ? {} : busy || (!moves.length && !transfer) ? { detail: upgradeCopy.rebalancing } : {}),
    links: moves.flatMap((o) => (o.txHash ? [{ chainId: 8453, tx: o.txHash, text: opLine(o) }] : [])),
  }
  const sent = !!transfer && transfer.step >= 1
  const bridge: UpgradeStep = {
    id: 'bridge', label: upgradeCopy.labels.bridge,
    state: sent ? 'done' : transfer?.step === 0 ? 'active' : transfer?.step === -1 ? 'failed' : 'pending',
    ...(transfer?.burnedAt ? { at: transfer.burnedAt } : {}),
    ...(transfer && !sent ? { detail: transferNow(transfer) } : {}),
    links: transfer?.burnTx ? [{ chainId: transfer.from, tx: transfer.burnTx, text: `${usd(transfer.amountUsdc)} USDC sent from ${chainLabel(transfer.from)}` }] : [],
    ...(transfer ? { transfer } : {}),
  }
  // Arrived: the transfer says minted, or it has left the map and Monad's read holds the money (or a position).
  const arrived = transfer ? transfer.step === 3 : monadPositions > 0 || monadIdle > 0n
  const arrive: UpgradeStep = {
    id: 'arrive', label: upgradeCopy.labels.arrive,
    state: arrived ? 'done' : sent ? (transfer!.stuck ? 'waiting' : 'active') : 'pending',
    ...(transfer?.mintedAt ? { at: transfer.mintedAt } : {}),
    ...(sent && !arrived ? { detail: transferNow(transfer!) } : {}),
    links: transfer?.mintTx ? [{ chainId: transfer.to, tx: transfer.mintTx, text: `Arrived on ${chainLabel(transfer.to)}` }] : [],
    ...(transfer ? { transfer } : {}),
  }
  const lp: UpgradeStep = {
    id: 'lp', label: upgradeCopy.labels.lp,
    state: monadPositions > 0 ? 'done' : arrived && monadIdle >= MIN_ENTRY_USDC ? 'waiting' : 'pending',
    ...(monadPositions === 0 && arrived && monadIdle >= MIN_ENTRY_USDC ? { detail: upgradeCopy.waitingLp(usd(monadIdle)) } : {}),
    links: [],
  }
  const steps = [approve, safe, rebalance, bridge, arrive, lp]
  const done = steps.every((s) => s.state === 'done')
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
