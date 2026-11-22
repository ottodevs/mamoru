// Spec 013 STATS-R14: the Portfolio's Total value chart. One point per UTC day: the owner's accounts on every chain
// (Base account and its sleeves, `sleevesOfUser`) summed from `account_daily.total_close_usdc`, today's row being the
// running close the cron keeps updating. Chains are aligned by last known value, never by an exact join: a chain with
// no row on a day contributes its previous close and the point says `partial`; before a chain's first row it adds
// nothing (the account did not exist). The last point is also `partial` when a chain's latest read is older than
// VALUE_STALE_MS. Each point also carries `deposited`, the owner's net deposited USDC at the end of that UTC day
// (otto/mamoru#380: the flows of `account_flows`, in minus out, on every chain, as the baseline of "vs idle USDC"). It is
// the difference `usd - deposited` the Portfolio charts. The flows are only as old as the operator kept them
// (deposits.ts: one day of first backfill): `netDeposited.status` says `partial` when value exists before the first
// known flow, `none` when no flow is known at all, so a reader shows "n/a" instead of a baseline that is wrong.
// Intraday points from `account_worked_samples` are left out on purpose: those samples omit idle money
// whenever positions exist, so a sum of them would understate the value. Pure D1 reads.
import type { Db } from '../env.ts'
import { sleevesOfUser } from './store.ts'

export const VALUE_STALE_MS = 30 * 60 * 1000

export type ValuePoint = { day: string; usd: number; partial?: true; /** Net deposited USDC at the end of this UTC day; absent when no flow is known. */ deposited?: number }
/** otto/mamoru#380: `usd` is the net deposited now (USDC sent minus withdrawn). `since`: the day of the first flow known. */
export type NetDeposited = { usd: number; status: 'complete' | 'partial' | 'none'; since?: string }
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
  const sleeves = await sleevesOfUser(db, userId)
  const perChain: { chainId: number; byDay: Map<string, number>; readAt: string | null }[] = []
  for (const s of sleeves) {
    const rows = (await db
      .prepare('SELECT day, total_close_usdc FROM account_daily WHERE chain_id = ? AND account_key = ? ORDER BY day')
      .bind(s.chain_id, s.account_key)
      .all<{ day: string; total_close_usdc: number }>()).results
    if (!rows.length) continue
    const last = await db
      .prepare('SELECT read_at FROM account_snapshot_latest WHERE chain_id = ? AND account_key = ?')
      .bind(s.chain_id, s.account_key)
      .first<{ read_at: string }>()
    perChain.push({ chainId: s.chain_id, byDay: new Map(rows.map((r) => [r.day, r.total_close_usdc])), readAt: last?.read_at ?? null })
  }
  if (!perChain.length) return { asOf: null, points: [], chains: [], netDeposited: { usd: 0, status: 'none' } }

  const days = [...new Set(perChain.flatMap((c) => [...c.byDay.keys()]))].sort()
  const firstDay = new Map(perChain.map((c) => [c.chainId, [...c.byDay.keys()].sort()[0]!]))
  const lastKnown = new Map<number, number>()
  const points: ValuePoint[] = days.map((day) => {
    let total = 0
    let partial = false
    for (const c of perChain) {
      if (day < firstDay.get(c.chainId)!) continue
      const v = c.byDay.get(day)
      if (v === undefined) {
        partial = true
        total += lastKnown.get(c.chainId) ?? 0
      } else {
        lastKnown.set(c.chainId, v)
        total += v
      }
    }
    return { day, usd: usd(total), ...(partial ? { partial: true as const } : {}) }
  })

  const netDeposited = applyFlows(points, await flowsOf(db, sleeves))

  const reads = perChain.map((c) => c.readAt)
  const known = reads.filter((r): r is string => r !== null).sort()
  const stale = reads.some((r) => r === null || now.getTime() - Date.parse(r) > VALUE_STALE_MS)
  if (stale && points.length) points[points.length - 1] = { ...points[points.length - 1]!, partial: true }
  return { asOf: known[0] ?? null, points, chains: perChain.map((c) => c.chainId), netDeposited }
}

type Flow = { kind: 'in' | 'out'; t_s: number; usd: number }

async function flowsOf(db: Db, sleeves: { chain_id: number; account_key: string }[]): Promise<Flow[]> {
  const out: Flow[] = []
  for (const s of sleeves) {
    const rows = (await db.prepare('SELECT kind, t_s, usd FROM account_flows WHERE chain_id = ? AND account_key = ? ORDER BY t_s').bind(s.chain_id, s.account_key).all<Flow>()).results
    out.push(...rows)
  }
  return out.sort((a, b) => a.t_s - b.t_s)
}

const DAY_S = 86_400

/** Sets `deposited` on every point (cumulative in - out up to the end of its UTC day) and says how far the flows can be trusted. */
function applyFlows(points: ValuePoint[], flows: Flow[]): NetDeposited {
  if (!flows.length) return { usd: 0, status: 'none' }
  const sinceDay = new Date(flows[0]!.t_s * 1000).toISOString().slice(0, 10)
  let net = 0
  let i = 0
  for (const p of points) {
    const endOfDay = Date.parse(`${p.day}T00:00:00.000Z`) / 1000 + DAY_S - 1
    while (i < flows.length && flows[i]!.t_s <= endOfDay) {
      net += flows[i]!.kind === 'in' ? flows[i]!.usd : -flows[i]!.usd
      i++
    }
    p.deposited = usd(Math.max(net, 0))
  }
  for (; i < flows.length; i++) net += flows[i]!.kind === 'in' ? flows[i]!.usd : -flows[i]!.usd
  // Value before the first known flow: the money came in before the operator's reach (early deposits were never kept).
  const partial = points[0] !== undefined && points[0].day < sinceDay
  return { usd: usd(Math.max(net, 0)), status: partial ? 'partial' : 'complete', since: sinceDay }
}
