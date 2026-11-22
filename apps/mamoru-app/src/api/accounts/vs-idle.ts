// otto/mamoru#380: the Portfolio's "vs idle USDC": what the owner has now against leaving the net deposited USDC
// untouched, and where the difference comes from. Pure D1 reads (value-series, income ledger, flows); never the operator.
//
//   net = total value - pending fees - net deposited - Mamoru fee
//   net = fees earned + price move - costs - Mamoru fee            (rows add up to net by construction)
//
// - total value: every chain of the owner, bucket + rewards + pending (value-series.ts).
// - fees earned: REALIZED yield only (Ot, 22 Nov): collected fees plus vault share growth, the income ledger's total
//   without the uncollected fees it adds (earned.ts). Pending fees are `pendingUsd`, apart, neither earned nor charged.
// - Mamoru fee: MAMORU_FEE_BPS of the income realized from MAMORU_FEE_FROM on, never earlier. This is the one place the
//   figure is made. A fee already paid left the Safe in a withdrawal, which the flows count as out (flows.ts), so the
//   whole fee owed is subtracted here once. The operator-side fee rule (otto/mamoru#433) replaces `mamoruFeeUsdc` here, nothing else reads it.
// - APR, 30-day average: the owner's real net APR, not the pool rate: realized income of the last 30 days, net of the
//   fee, over the capital that worked in that window times its time (worked.ts, in range only), annualised. Null for the
//   first 30 days of the account ('first-30-days': the app shows the Mamoru average then) and while nothing worked.
// - price move: the residual that makes the rows exact (what the volatile side of the pools did to the value).
// - costs: the gas the user's Safe paid (a userOp with no paymaster; relayer-sponsored owner transactions are not a user
//   cost and are not counted), in USDC as the operator priced it per op (receipts `gasUsdc`, summed over the owner's
//   chains). Slippage is not in the op facts (no realized vs quoted figure), so it is not counted: costs are gas only.
//   A day with gas not priced yet makes 'costs' partial (named in `notCounted`), never a zero. Costs are inside the
//   value already; the price move row is the residual, so it gives the costs back (value change = price move - costs).
// - net deposited is the baseline; when it is not complete (value before the first known flow, or no flow) the rows and
//   the series are null/empty, never a figure against a wrong baseline. `series` is net by day, ending on `net`.
import type { Db } from '../env.ts'
import { loadEarned } from '../earned.ts'
import { sleevesOfUser } from './store.ts'
import { loadWorked } from './worked.ts'
import { COVERAGE_MIN, coverage, sampledIntervals, sampledShare, type Interval } from './sampled.ts'
import { loadValueSeriesDetail, type NetDeposited } from './value-series.ts'

/** Mamoru's yield fee, 10 %. Mirrors the operator's rule (apps/mamoru-operator/src/yield-fee.ts); read here, never charged here. */
export const MAMORU_FEE_BPS = 1_000n
/** Income realized from here on (UTC, unix s) owes the fee. Nothing before 5 Nov is charged. */
export const MAMORU_FEE_FROM = Math.floor(Date.parse('2026-11-05T00:00:00.000Z') / 1000)

type IncomeRow = { t_s: number; usd: number; source?: string; from_s?: number | null; chain_id?: number; event_id?: string }

/** The fee owed on income realized up to `until` (unix s, exclusive): the seam for the operator-side change (#433). */
export function mamoruFeeUsdc(income: readonly IncomeRow[], until: number): bigint {
  let base = 0n
  // History rows (source 'backfill': a day's collected fees known only as a total, a vault's first-sample yield) are income
  // from before it was observed, not income realized from 5 Nov: only events of the operator's own record enter the base.
  for (const r of income) if (r.t_s >= MAMORU_FEE_FROM && r.t_s < until && r.source !== 'backfill' && !r.event_id?.startsWith('backfill:') && !r.event_id?.startsWith('vault-backfill:')) base += BigInt(Math.round(r.usd))
  return (base * MAMORU_FEE_BPS) / 10_000n
}

export type NotCounted = 'flows' | 'fees' | 'vault-yield' | 'history' | 'costs' | 'value'
/** `pct` null: `first-30-days` (the account is younger than the window) or `not-measured` (no worked capital or no read yet). */
/**
 * otto/mamoru#413 seam: harvested yield kept in the Stable vault as a separate savings layer. It is already inside total
 * value and inside `feesUsd` (it is earned), so no row changes; `savingsUsd` is only what the Working capital Stable row
 * shows next to the bucket amount. The ledger tagging is another session's: until it exists this is 0. Savings never
 * count toward a share or mix.
 */
export const SAVINGS_USD_UNTIL_TAGGED = 0

export type AprView = { pct: number | null; reason: 'first-30-days' | 'not-measured' | null }
export type VsIdleView = {
  asOf: string | null
  /** Total value now, USDC (2 decimals). Null before the first read. */
  totalUsd: number | null
  netDeposited: NetDeposited
  /** The first day with a value. */
  since: string | null
  /** Rows in USDC (2 decimals), signed: fees earned +, price move ±, costs -, Mamoru fee -. Price move and net are null while the baseline is not complete. */
  breakdown: { feesUsd: number; priceMoveUsd: number | null; costsUsd: number; mamoruFeeUsd: number; netUsd: number | null } | null
  /** Uncollected fees inside the total value, shown apart from `breakdown`. */
  pendingUsd: number
  /** Savings layer inside the figures above (otto/mamoru#413 seam, 0 until the ledger tags it). */
  savingsUsd: number
  /** APR · 30-day avg, net of the fee (see the header). */
  apr: AprView
  status: 'complete' | 'partial'
  notCounted: NotCounted[]
  /** Net at the end of each UTC day; its last point is `breakdown.netUsd`. Empty while the baseline is not complete. */
  series: { day: string; netUsd: number }[]
}

const cents = (usd: number) => Math.round(usd * 100)
const toCents = (raw: bigint) => Number((raw + (raw < 0n ? -5_000n : 5_000n)) / 10_000n)
const usd = (c: number) => c / 100

/**
 * The net deposited can claim a gain only when it is complete (otto/mamoru#438 makes it so; value-series reports recorded
 * flows only, `partial`, until then): a withdrawal recorded without the principal it returned would read as a gain.
 * Without it, everything that needs the baseline (net, price move, the series) is null/empty and the app says n/a; fees
 * earned, costs, the Mamoru fee and the APR do not need it and are still given. `baselineComplete` is how #438's
 * evidence will reach this function; tests pass it to exercise the arithmetic.
 */
const isComplete = (nd: { status: string }) => nd.status === 'complete'

export async function loadVsIdle(db: Db, userId: string, now: Date, baselineComplete?: boolean): Promise<VsIdleView> {
  const { view, pending } = await loadValueSeriesDetail(db, userId, now)
  const complete = baselineComplete ?? isComplete(view.netDeposited)
  const last = view.points.at(-1)
  const empty: VsIdleView = { asOf: view.asOf, totalUsd: last?.usd ?? null, netDeposited: view.netDeposited, since: view.points[0]?.day ?? null, breakdown: null, pendingUsd: last ? usd(toCents(BigInt(pending.get(last.day) ?? 0))) : 0, savingsUsd: SAVINGS_USD_UNTIL_TAGGED, apr: { pct: null, reason: 'not-measured' }, status: 'partial', notCounted: [], series: [] }
  if (!last) return empty
  const notCounted = new Set<NotCounted>()
  // The value itself is stale or carries a chain forward (value-series `partial`): the figure is an estimate.
  if (last.partial) notCounted.add('value')
  if (!complete) notCounted.add('flows')

  const sleeves = await sleevesOfUser(db, userId)
  let realized = 0n
  let gasUsdc = 0n
  let gasKnown = true
  let earnedKnown = true
  const income: IncomeRow[] = []
  for (const s of sleeves) {
    const earned = await loadEarned(db, s.chain_id, s.account_key)
    const snap = await db.prepare('SELECT fees_usdc FROM account_snapshot_latest WHERE chain_id = ? AND account_key = ?').bind(s.chain_id, s.account_key).first<{ fees_usdc: number }>()
    if (!earned || !snap) {
      // A sleeve with value rows but no snapshot or income read cannot be counted: its fees and gas are unknown, never 0.
      const hasValue = await db.prepare('SELECT 1 AS x FROM account_daily WHERE chain_id = ? AND account_key = ? LIMIT 1').bind(s.chain_id, s.account_key).first<{ x: number }>()
      if (snap || earned || hasValue) {
        earnedKnown = false
        gasKnown = false
      }
      continue
    }
    realized += BigInt(Math.round(Number(earned.totalUsd))) - BigInt(Math.round(snap.fees_usdc))
    for (const n of earned.notCounted) if (n !== 'accrued-24h') notCounted.add(n) // that one belongs to the 24 h figure only
    income.push(...(await incomeRows(db, s.chain_id, s.account_key)))
    const gas = await gasRows(db, s.chain_id, s.account_key, last.day)
    for (const g of gas) {
      if (g.gas_paid_usdc === null) {
        if (BigInt(g.gas_paid_wei) > 0n) gasKnown = false
      } else gasUsdc += BigInt(g.gas_paid_usdc)
    }
  }
  if (!earnedKnown) notCounted.add('fees')
  if (!gasKnown) notCounted.add('costs')
  empty.apr = await netApr30d(db, sleeves, income, view.points[0]?.day ?? null)
  const status = (): 'complete' | 'partial' => (notCounted.size ? 'partial' : 'complete')
  const out = { ...empty, notCounted: [...notCounted].sort(), status: status() }
  if (!earnedKnown) return out

  const dayEnd = (day: string) => Date.parse(`${day}T00:00:00.000Z`) / 1000 + 86_400
  // Income newer than the balance read is not in the value yet: the fee is cut at that read, as earned.ts cuts the income.
  const readS = view.asOf ? Math.floor(Date.parse(view.asOf) / 1000) : Number.MAX_SAFE_INTEGER
  const feeAt = (day: string) => toCents(mamoruFeeUsdc(income, Math.min(dayEnd(day), Number.isFinite(readS) ? readS + 1 : dayEnd(day))))
  const netAt = (day: string, total: number, deposited: number) => cents(total) - toCents(BigInt(pending.get(day) ?? 0)) - cents(deposited) - feeAt(day)
  const fee = feeAt(last.day)
  const fees = toCents(realized)
  const costs = toCents(gasUsdc)
  if (!complete) return { ...out, breakdown: { feesUsd: usd(fees), priceMoveUsd: null, costsUsd: usd(-costs), mamoruFeeUsd: usd(-fee), netUsd: null } }
  const series = view.points.filter((p) => p.deposited !== undefined).map((p) => ({ day: p.day, netUsd: usd(netAt(p.day, p.usd, p.deposited!)) }))
  // The last point is today's running read: the figure shown now is that point, and the rows add up to it.
  const net = netAt(last.day, last.usd, last.deposited ?? view.netDeposited.usd)
  const breakdown = { feesUsd: usd(fees), priceMoveUsd: usd(net - fees + fee + costs), costsUsd: usd(-costs), mamoruFeeUsd: usd(-fee), netUsd: usd(net) }
  return { ...out, breakdown, series }
}

async function incomeRows(db: Db, chainId: number, accountKey: string): Promise<IncomeRow[]> {
  return (await db.prepare('SELECT t_s, usd, source, from_s, chain_id, event_id FROM yield_ledger_income WHERE chain_id = ? AND account_key = ? AND usd IS NOT NULL').bind(chainId, accountKey).all<IncomeRow>()).results
}

const DAY_S = 86_400
const MONTH_S = 30 * DAY_S
const YEAR_S = 365 * DAY_S

/** See the header. Income rows are the owner's, every chain; `firstDay` the first day with a value. */
async function netApr30d(db: Db, sleeves: { chain_id: number; account_key: string }[], allIncome: readonly IncomeRow[], firstDay: string | null): Promise<AprView> {
  const base = sleeves.find((s) => s.chain_id === 8453) ?? sleeves[0]
  const worked = base ? await loadWorked(db, base.chain_id, base.account_key) : null
  if (!worked || firstDay === null) return { pct: null, reason: 'not-measured' }
  let income = allIncome
  // Income only of the chains whose samples are in the capital-time below (Base, plus the sleeves loadWorked says contributed).
  const counted = new Set([base!.chain_id, ...(worked.chains?.month ?? [])])
  income = income.filter((r) => r.chain_id === undefined || counted.has(r.chain_id))
  const end = Math.floor(Date.parse(worked.asOf) / 1000)
  const start = end - MONTH_S
  if (!Number.isFinite(end) || Date.parse(`${firstDay}T00:00:00.000Z`) / 1000 > start) return { pct: null, reason: 'first-30-days' }
  // The capital-time below only exists where samples were taken, so the income counted is the income of those same
  // sampled intervals (per sleeve), and every contributing sleeve must have most of the window sampled (COVERAGE_MIN).
  const intervals = new Map<number, Interval[]>()
  for (const sl of sleeves) {
    if (!counted.has(sl.chain_id)) continue
    const iv = await sampledIntervals(db, sl.chain_id, sl.account_key, start, end)
    if (coverage(iv, start, end) < COVERAGE_MIN) return { pct: null, reason: 'not-measured' }
    intervals.set(sl.chain_id, iv)
  }
  const capitalSeconds = worked.month.reduce((n, p) => n + p.usdSeconds, 0) / 1e6
  if (!(capitalSeconds > 0)) return { pct: null, reason: 'not-measured' }
  let earned = 0
  for (const r of income) {
    // History rows hold income of days before per-event detail: no time inside the window to credit.
    if (r.source === 'backfill') continue
    const share = sampledShare(intervals.get(r.chain_id ?? base!.chain_id) ?? [], { kind: r.source === 'vault-yield' ? 'span' : 'point', t: r.t_s, from: r.from_s }, start, end)
    const gross = (r.usd / 1e6) * share
    earned += r.t_s >= MAMORU_FEE_FROM ? gross * (1 - Number(MAMORU_FEE_BPS) / 10_000) : gross
  }
  return { pct: Math.round((earned / capitalSeconds) * YEAR_S * 1000) / 10, reason: null }
}

/** Gas of the days up to the value's last day: a later op is not in the balance shown. */
async function gasRows(db: Db, chainId: number, accountKey: string, throughDay: string): Promise<{ gas_paid_wei: string; gas_paid_usdc: number | null }[]> {
  try {
    return (await db.prepare('SELECT gas_paid_wei, gas_paid_usdc FROM yield_ledger_account_receipts WHERE chain_id = ? AND account_key = ? AND day <= ?').bind(chainId, accountKey, throughDay).all<{ gas_paid_wei: string; gas_paid_usdc: number | null }>()).results
  } catch (e) {
    if (!/no such (table|column)|has no column named/i.test(e instanceof Error ? e.message : String(e))) throw e
    return [{ gas_paid_wei: '1', gas_paid_usdc: null }] // not migrated: gas is unknown, not zero
  }
}
