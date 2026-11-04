import type { BridgeProgress, MoneyInFlight } from '@mamoru/domain'
import { chainLabel } from './positions.ts'

// otto/mamoru#263, #264: a CCTP transfer between the owner's Safes as three steps the owner can follow: it leaves the
// source chain (the burn), Circle confirms it (the attestation, 13 to 19 minutes at Standard finality from Base), and it
// arrives on the destination chain (the mint). Built from the money map's in-flight row or from a bridge op's progress.

export type Transfer = {
  from: number
  to: number
  amountUsdc: string
  recipient?: string
  /** 0 leaving, 1 waiting for Circle, 2 arriving, 3 arrived; -1 failed (nothing left the account). */
  step: -1 | 0 | 1 | 2 | 3
  burnTx?: string
  burnedAt?: string
  attestedAt?: string
  mintTx?: string
  mintedAt?: string
  eta?: { from: string; to: string; late: boolean }
  stuck: boolean
}

/** Standard finality from Base (CCTP V2): the window after the burn in which the mint is possible. */
const ETA_FROM_MS = 13 * 60_000
const ETA_TO_MS = 19 * 60_000

function etaOf(burnedAt: string | undefined, now: number): Transfer['eta'] {
  const t = burnedAt ? Date.parse(burnedAt) : NaN
  if (!Number.isFinite(t)) return undefined
  return { from: new Date(t + ETA_FROM_MS).toISOString(), to: new Date(t + ETA_TO_MS).toISOString(), late: now > t + ETA_TO_MS }
}

/** The money map's row: its stage says how far it got ('attested' and 'minting' are both "arriving"). */
export function transferOfFlight(t: MoneyInFlight, now: number = Date.now()): Transfer {
  const step = t.stage === 'failed' ? -1 : t.stage === 'sending' ? 0 : t.stage === 'burned' ? (t.attestedAt ? 2 : 1) : t.stage === 'minted' ? 3 : 2
  return {
    from: t.from, to: t.to, amountUsdc: t.amountUsdc, recipient: t.recipient, step,
    ...(t.burnTx ? { burnTx: t.burnTx } : {}), ...(t.burnedAt ? { burnedAt: t.burnedAt } : {}), ...(t.attestedAt ? { attestedAt: t.attestedAt } : {}),
    ...(t.mintTx ? { mintTx: t.mintTx } : {}), ...(t.mintedAt ? { mintedAt: t.mintedAt } : {}),
    ...(step === 1 || step === 2 ? { eta: t.eta ?? etaOf(t.burnedAt, now) } : {}),
    stuck: !!t.stuckAt && step >= 0 && step < 3,
  }
}

/** A bridge op's progress (its source is the account's own chain): 'burned' with an attestation seen is "arriving". */
export function transferOfBridge(b: BridgeProgress, from: number, now: number = Date.now()): Transfer {
  const step = b.state === 'failed' ? -1 : b.state === 'sending' ? 0 : b.state === 'minted' ? 3 : b.attestedAt ? 2 : 1
  return {
    from, to: b.chainId, amountUsdc: b.amountUsdc, step,
    ...(b.recipient ? { recipient: b.recipient } : {}),
    ...(b.burnTx ? { burnTx: b.burnTx } : {}), ...(b.burnedAt ? { burnedAt: b.burnedAt } : {}), ...(b.attestedAt ? { attestedAt: b.attestedAt } : {}),
    ...(b.mintTx ? { mintTx: b.mintTx } : {}), ...(b.mintedAt ? { mintedAt: b.mintedAt } : {}),
    ...(step === 1 || step === 2 ? { eta: b.eta ?? etaOf(b.burnedAt, now) } : {}),
    stuck: !!b.stuckAt && step >= 0 && step < 3,
  }
}

export const transferCopy = {
  steps: (from: string, to: string) => [`Leaves ${from}`, 'Circle confirms the transfer', `Arrives in your ${to} Safe`],
  now: (from: string, to: string) => [`Leaving ${from}`, 'Waiting for Circle to confirm', `Arriving on ${to}`, `Arrived on ${to}`],
  usually: 'Usually 13 to 19 minutes.',
  eta: (a: string, b: string) => `arrives ${a} to ${b}`,
  etaLong: (a: string, b: string) => `Expected between ${a} and ${b}.`,
  late: 'Taking longer than usual. Your money is safe and counted in your total.',
  counted: 'Counted in your total while it travels.',
  arrivedLine: (amount: string, from: string, to: string) => `${amount} USDC from ${from} arrived on ${to}`,
  updating: 'updating your balance',
  countedArrived: 'Already counted in your total.',
  sent: (explorer: string) => `Sent, on ${explorer}`,
  arrived: (explorer: string) => `Arrived, on ${explorer}`,
  to: (chain: string) => `To your ${chain} Safe`,
}

/** "Waiting for Circle to confirm": where the transfer is now, in words. */
export function transferNow(t: Transfer): string {
  return t.step < 0 ? '' : transferCopy.now(chainLabel(t.from), chainLabel(t.to))[t.step]!
}

/** Late by the operator's flag, or by the clock once the window has passed (a tab left open still flips). */
export function transferLate(t: Transfer, now: number = Date.now()): boolean {
  if (t.stuck) return true
  if (!t.eta || t.step < 1 || t.step > 2) return false
  return t.eta.late || (Number.isFinite(Date.parse(t.eta.to)) && Date.parse(t.eta.to) < now)
}
