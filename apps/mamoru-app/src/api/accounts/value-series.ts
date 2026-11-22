// Spec 013 STATS-R14: the Portfolio's Total value chart. One point per UTC day: the owner's accounts on every chain
// (Base account and its sleeves, `sleevesOfUser`) summed from `account_daily.total_close_usdc`, today's row being the
// running close the cron keeps updating. Chains are aligned by last known value, never by an exact join: a chain with
// no row on a day contributes its previous close and the point says `partial`; before a chain's first row it adds
// nothing (the account did not exist). The last point is also `partial` when a chain's latest read is older than
// VALUE_STALE_MS. Each point also carries `deposited`, the owner's net deposited USDC at the end of that UTC day
// (otto/mamoru#380: the flows of `account_flows`, in minus out, on every chain, as the baseline of "vs idle USDC"). It is
// the difference `usd - deposited` the Portfolio charts. The flows are the RECORDED ones only (the operator keeps one
// day of first backfill): `netDeposited.status` is always `partial` (or `none` with no flow); see applyFlows.
// Intraday points from `account_worked_samples` are left out on purpose: those samples omit idle money
// whenever positions exist, so a sum of them would understate the value. Pure D1 reads.
import type { Db } from '../env.ts'
import { sleevesOfUser } from './store.ts'

export const VALUE_STALE_MS = 30 * 60 * 1000

export type ValuePoint = { day: string; usd: number; partial?: true; /** Net deposited USDC at the end of this UTC day; absent when no flow is known. */ deposited?: number }
/** otto/mamoru#380: `usd` is the net deposited now (USDC sent minus withdrawn). `since`: the day of the first flow known. */
export type NetDeposited = { usd: number; status: 'partial' | 'none'; since?: string }
export type ValueSeriesView = {
  /** Oldest latest read among the chains that have one (ISO), null before the first read. */
  asOf: string | null
  points: ValuePoint[]
  /** Chain ids that contributed at least one row. */
  chains: number[]
  netDeposited: NetDeposited
}

const usd = (baseUnits: number) => Math.round(baseUnits / 10_000) / 100

export async function loadValueSeries(db: Db, userId: string, now: Date): Promise<ValueSeriesView> {
  return (await loadValueSeriesDetail(db, userId, now)).view
}

/**
 * The series plus, per day, the uncollected fees inside each day's total (account_daily.fees_close_usdc, carried the
 * same way, raw USDC): vs-idle.ts takes them out of a total, since pending fees are shown apart, not as earned.
 */
export async function loadValueSeriesDetail(db: Db, userId: string, now: Date): Promise<{ view: ValueSeriesView; pending: Map<string, number> }> {
  const pending = new Map<string, number>()
  const sleeves = await sleevesOfUser(db, userId)
  const perChain: { chainId: number; byDay: Map<string, number>; fees: Map<string, number>; readAt: string | null }[] = []
  for (const s of sleeves) {
    const rows = (await db
      .prepare('SELECT day, total_close_usdc, fees_close_usdc FROM account_daily WHERE chain_id = ? AND account_key = ? ORDER BY day')
      .bind(s.chain_id, s.account_key)
      .all<{ day: string; total_close_usdc: number; fees_close_usdc: number }>()).results
    if (!rows.length) continue
    const last = await db
      .prepare('SELECT read_at FROM account_snapshot_latest WHERE chain_id = ? AND account_key = ?')
      .bind(s.chain_id, s.account_key)
      .first<{ read_at: string }>()
    perChain.push({ chainId: s.chain_id, byDay: new Map(rows.map((r) => [r.day, r.total_close_usdc])), fees: new Map(rows.map((r) => [r.day, r.fees_close_usdc])), readAt: last?.read_at ?? null })
  }
  if (!perChain.length) return { view: { asOf: null, points: [], chains: [], netDeposited: { usd: 0, status: 'none' } }, pending }

  const days = [...new Set(perChain.flatMap((c) => [...c.byDay.keys()]))].sort()
  const firstDay = new Map(perChain.map((c) => [c.chainId, [...c.byDay.keys()].sort()[0]!]))
  const lastKnown = new Map<number, number>()
  const lastFees = new Map<number, number>()
  const points: ValuePoint[] = days.map((day) => {
    let total = 0
    let partial = false
    let fees = 0
    for (const c of perChain) {
      if (day < firstDay.get(c.chainId)!) continue
      const v = c.byDay.get(day)
      if (v === undefined) {
        partial = true
        total += lastKnown.get(c.chainId) ?? 0
        fees += lastFees.get(c.chainId) ?? 0
      } else {
        lastKnown.set(c.chainId, v)
        const f = c.fees.get(day) ?? 0
        lastFees.set(c.chainId, f)
        total += v
        fees += f
      }
    }
    pending.set(day, fees)
    return { day, usd: usd(total), ...(partial ? { partial: true as const } : {}) }
  })

  const netDeposited = applyFlows(points, await flowsOf(db, sleeves))

  const reads = perChain.map((c) => c.readAt)
  const known = reads.filter((r): r is string => r !== null).sort()
  const stale = reads.some((r) => r === null || now.getTime() - Date.parse(r) > VALUE_STALE_MS)
  if (stale && points.length) points[points.length - 1] = { ...points[points.length - 1]!, partial: true }
  return { view: { asOf: known[0] ?? null, points, chains: perChain.map((c) => c.chainId), netDeposited }, pending }
}

type Flow = { kind: 'in' | 'out' | 'gap'; t_s: number; usd: number; chain_id: number }

async function flowsOf(db: Db, sleeves: { chain_id: number; account_key: string }[]): Promise<Flow[]> {
  const out: Flow[] = []
  for (const s of sleeves) {
    try {
      const rows = (await db.prepare('SELECT kind, t_s, usd, chain_id FROM account_flows WHERE chain_id = ? AND account_key = ? ORDER BY t_s').bind(s.chain_id, s.account_key).all<Flow>()).results
      out.push(...rows)
    } catch (e) {
      // Not migrated yet: the Total value chart must keep working; the baseline is simply unknown.
      if (!/no such table/i.test(e instanceof Error ? e.message : String(e))) throw e
    }
  }
  return out.sort((a, b) => a.t_s - b.t_s)
}

const DAY_S = 86_400
const signedOf = (f: Flow) => (f.kind === 'in' ? f.usd : f.kind === 'out' ? -f.usd : 0)

/**
 * Sets `deposited` on every point (cumulative in - out up to the end of its UTC day, signed: more out than in is a
 * negative baseline, the gains taken out). The net deposited is the RECORDED flows only and is always `partial`: the
 * operator keeps deposits for one day on a first look and 200 rows, so older money may be missing. What would make it
 * complete (per-chain coverage, gaps, a first-day check) is otto/mamoru#438; until then a reader labels it as recorded and
 * shows n/a for anything that needs a complete baseline (a withdrawal recorded without the principal it returned would
 * otherwise read as a gain).
 */
function applyFlows(points: ValuePoint[], flows: Flow[]): NetDeposited {
  const money = flows.filter((f) => f.kind === 'in' || f.kind === 'out')
  if (!money.length) return { usd: 0, status: 'none' }
  let net = 0
  let i = 0
  for (const p of points) {
    const endOfDay = Date.parse(`${p.day}T00:00:00.000Z`) / 1000 + DAY_S - 1
    while (i < money.length && money[i]!.t_s <= endOfDay) net += signedOf(money[i++]!)
    // Before the first recorded flow the baseline is unknown, not zero: a zero would chart the whole balance as gain.
    if (i > 0) p.deposited = usd(net)
  }
  for (; i < money.length; i++) net += signedOf(money[i]!)
  return { usd: usd(net), status: 'partial', since: new Date(money[0]!.t_s * 1000).toISOString().slice(0, 10) }
}
