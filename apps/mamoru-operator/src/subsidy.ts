import type { AccountState } from './state.ts'

type Env = Record<string, string | undefined>

/**
 * What the relayer gives away at an activation is the gas reserve it sends into the Safe (otto/mamoru#82): it stays
 * there as ETH the owner can move out with their own passkey. Cycling fresh accounts through activations would turn
 * that reserve into a payout, so the reserve is paid only within the limits below. The Safe deploy and the
 * execTransaction gas are not part of it: they are spent on chain and give the owner nothing to take away.
 *
 * Every limit only decides who pays the reserve. A Safe that already holds it starts with no subsidy at all, so an
 * owner is never refused a start they fund themselves, and no exit path (withdrawal, stop) ever asks.
 */

/**
 * USDC (base units) the Safe must hold for the relayer to pay its reserve. The live policy is sized for 5-25 USDC
 * accounts; from 10 USDC a cycle locks ten times the dollar value it could take, and smaller accounts bring their
 * own ~0.0005 ETH.
 */
export const SUBSIDY_MIN_USDC = 10_000_000n
/** Reserves the relayer pays per Safe over its life, counted in full reserves (a partial refill counts its share). */
export const SUBSIDY_ACCOUNT_RESERVES = 2n
/** The same across every Safe of one passkey. */
export const SUBSIDY_PASSKEY_RESERVES = 3n
/** Funds that leave a Safe this soon after a paid reserve end its subsidy, and that of every Safe of its passkey. */
export const SUBSIDY_EARLY_EXIT_MS = 72 * 3_600_000
/** Reserves the relayer pays across all accounts in any 24 hours, unless MAMORU_SUBSIDY_PER_DAY says otherwise. */
export const DEFAULT_SUBSIDY_PER_DAY = 10
/** Share of the daily budget at which #mamoru-ops hears of it, before it runs out. */
export const SUBSIDY_ALERT_SHARE = 0.8
const DAY_MS = 24 * 3_600_000

export function subsidyPerDayFromEnv(env: Env = process.env): number {
  const raw = env.MAMORU_SUBSIDY_PER_DAY?.trim()
  if (!raw) return DEFAULT_SUBSIDY_PER_DAY
  const n = Number(raw)
  // 0 is a valid setting: no reserve is paid, every start brings its own.
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_SUBSIDY_PER_DAY
}

export type SubsidyCode = 'SUBSIDY_BELOW_MINIMUM' | 'SUBSIDY_EARLY_EXIT' | 'SUBSIDY_ACCOUNT_LIMIT' | 'SUBSIDY_PASSKEY_LIMIT' | 'SUBSIDY_DAILY_BUDGET'

/** `need`: wei the Safe lacks to reach the reserve (0: it starts on its own ETH). `code`: why the relayer will not pay it. */
export type SubsidyDecision = { need: bigint; code: SubsidyCode | null }

/** The passkey's public key; null for a record without one (never grouped with another). */
const passkeyOf = (a: AccountState) => (a.ctx?.passkey?.x && a.ctx.passkey.y ? `${a.ctx.passkey.x}:${a.ctx.passkey.y}`.toLowerCase() : null)
const paid = (a: AccountState) => (a.subsidies ?? []).reduce((s, x) => s + BigInt(x.wei), 0n)

/** Reserve wei paid in the last 24 hours across all accounts. */
export function paidToday(all: readonly AccountState[], now = Date.now()): bigint {
  const since = now - DAY_MS
  return all.reduce((s, a) => s + (a.subsidies ?? []).filter((x) => Date.parse(x.at) > since).reduce((t, x) => t + BigInt(x.wei), 0n), 0n)
}

/** Whether the relayer pays the `target - eth` this activation lacks. */
export function subsidyDecision(i: { acc: AccountState; all: readonly AccountState[]; usdc: bigint; eth: bigint; target: bigint; perDay: number; now?: number }): SubsidyDecision {
  const need = i.eth >= i.target ? 0n : i.target - i.eth
  if (need === 0n) return { need, code: null }
  if (i.usdc < SUBSIDY_MIN_USDC) return { need, code: 'SUBSIDY_BELOW_MINIMUM' }
  const key = passkeyOf(i.acc)
  const same = i.all.filter((a) => a === i.acc || (key !== null && passkeyOf(a) === key))
  if (same.some((a) => a.subsidyForfeitAt)) return { need, code: 'SUBSIDY_EARLY_EXIT' }
  if (paid(i.acc) + need > SUBSIDY_ACCOUNT_RESERVES * i.target) return { need, code: 'SUBSIDY_ACCOUNT_LIMIT' }
  if (same.reduce((s, a) => s + paid(a), 0n) + need > SUBSIDY_PASSKEY_RESERVES * i.target) return { need, code: 'SUBSIDY_PASSKEY_LIMIT' }
  if (paidToday(i.all, i.now) + need > BigInt(i.perDay) * i.target) return { need, code: 'SUBSIDY_DAILY_BUDGET' }
  return { need, code: null }
}

/** A withdrawal or stop confirmed on this account: inside the window after a paid reserve, the subsidy ends. */
export function noteExit(acc: AccountState, now = Date.now()): boolean {
  const last = (acc.subsidies ?? []).reduce((m, x) => Math.max(m, Date.parse(x.at) || 0), 0)
  if (!last || acc.subsidyForfeitAt || now - last > SUBSIDY_EARLY_EXIT_MS) return false
  acc.subsidyForfeitAt = new Date(now).toISOString()
  return true
}

const fmtEth = (wei: bigint) => {
  // Rounded up to 6 decimals: what the owner is told to send is never short.
  const micro = (wei + 999_999_999_999n) / 1_000_000_000_000n
  return `${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, '0')}`.replace(/\.?0+$/, '')
}

/** The refusal the app shows: why, and the self-funded way to start now. Built only from operator values. */
export function subsidyMessage(code: SubsidyCode, need: bigint, safe: string): string {
  const own = `To start now with your own gas, send ${fmtEth(need)} ETH on Base to your account ${safe}, then start again.`
  switch (code) {
    case 'SUBSIDY_BELOW_MINIMUM':
      return `Mamoru pays the gas reserve for accounts holding ${Number(SUBSIDY_MIN_USDC) / 1e6} USDC or more. Add USDC, or: ${own}`
    case 'SUBSIDY_EARLY_EXIT':
      return `Funds left this account within ${SUBSIDY_EARLY_EXIT_MS / 3_600_000} hours of a start Mamoru paid gas for, so its next start uses its own gas. ${own}`
    case 'SUBSIDY_ACCOUNT_LIMIT':
      return `Mamoru already paid the gas reserve of this account. ${own}`
    case 'SUBSIDY_PASSKEY_LIMIT':
      return `Mamoru already paid the gas reserve of the accounts of this passkey. ${own}`
    case 'SUBSIDY_DAILY_BUDGET':
      return `Starts with gas paid by Mamoru are used up for the next hours; try again later. ${own}`
  }
}
