// Spec 013 STATS-R14: the Portfolio's Total value chart. One point per UTC day: the owner's accounts on every chain
// (Base account and its sleeves, `sleevesOfUser`) summed from `account_daily.total_close_usdc`, today's row being the
// running close the cron keeps updating. Chains are aligned by last known value, never by an exact join: a chain with
// no row on a day contributes its previous close and the point says `partial`; before a chain's first row it adds
// nothing (the account did not exist). The last point is also `partial` when a chain's latest read is older than
// VALUE_STALE_MS. Intraday points from `account_worked_samples` are left out on purpose: those samples omit idle money
// whenever positions exist, so a sum of them would understate the value. Pure D1 reads.
//
// otto/mamoru#460: leaving a chain. After a minted home transfer (yield_ledger_bridges, Monad -> Base) the operator
// stops reading the sleeve's Safe, so its last close (read before the burn) would be carried forward forever while
// the same USDC already counts on Base. The rule is the one Stats uses (`inFlightNow`): when the sleeve's latest read
// is from before the burn block, from the mint day on the transferred amount is taken out of the sleeve's
// contribution. A sleeve left with (almost) nothing then counts as left: its old read no longer makes the series stale.
import type { Db } from '../env.ts'
import { sleevesOfUser } from './store.ts'

export const VALUE_STALE_MS = 30 * 60 * 1000
/** Under one cent (raw USDC) a sleeve that has sent its money home counts as left. */
const LEFT_DUST = 10_000
const BASE_CHAIN = 8453

export type ValuePoint = { day: string; usd: number; partial?: true }
export type ValueSeriesView = {
  /** Oldest latest read among the chains that have one (ISO), null before the first read. */
  asOf: string | null
  points: ValuePoint[]
  /** Chain ids that contributed at least one row. */
  chains: number[]
}

const usd = (baseUnits: number) => Math.round(baseUnits / 10_000) / 100

export async function loadValueSeries(db: Db, userId: string, now: Date): Promise<ValueSeriesView> {
  const sleeves = await sleevesOfUser(db, userId)
  const perChain: { chainId: number; byDay: Map<string, number>; readAt: string | null; block: number | null }[] = []
  for (const s of sleeves) {
    const rows = (await db
      .prepare('SELECT day, total_close_usdc FROM account_daily WHERE chain_id = ? AND account_key = ? ORDER BY day')
      .bind(s.chain_id, s.account_key)
      .all<{ day: string; total_close_usdc: number }>()).results
    if (!rows.length) continue
    const last = await db
      .prepare('SELECT read_at, block FROM account_snapshot_latest WHERE chain_id = ? AND account_key = ?')
      .bind(s.chain_id, s.account_key)
      .first<{ read_at: string; block: number }>()
    perChain.push({ chainId: s.chain_id, byDay: new Map(rows.map((r) => [r.day, r.total_close_usdc])), readAt: last?.read_at ?? null, block: last?.block ?? null })
  }
  if (!perChain.length) return { asOf: null, points: [], chains: [] }

  // Money a sleeve sent home that its stale reads still hold: [day it lands on Base, amount], per chain.
  const sentHome = new Map<number, { day: string; amount: number }[]>()
  const baseKey = sleeves.find((s) => s.chain_id === BASE_CHAIN)?.account_key
  if (baseKey) {
    let homes: { amount_usdc: number; burn_block: number | null; minted_at: string | null }[] = []
    try {
      homes = (await db
        .prepare("SELECT amount_usdc, burn_block, minted_at FROM yield_ledger_bridges WHERE account_key = ? AND direction = 'home' AND state = 'minted'")
        .bind(baseKey)
        .all<{ amount_usdc: number; burn_block: number | null; minted_at: string | null }>()).results
    } catch {
      homes = [] // table not migrated yet: no adjustment, the series as before
    }
    for (const c of perChain) {
      if (c.chainId === BASE_CHAIN || c.block === null) continue
      const held = homes.filter((h) => h.burn_block !== null && h.minted_at !== null && c.block! < h.burn_block)
      if (held.length) sentHome.set(c.chainId, held.map((h) => ({ day: h.minted_at!.slice(0, 10), amount: h.amount_usdc })))
    }
  }
  const outOf = (chainId: number, day: string, v: number) => {
    const sent = (sentHome.get(chainId) ?? []).filter((h) => h.day <= day).reduce((a, h) => a + h.amount, 0)
    return Math.max(0, v - sent)
  }

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
        // A chain whose money all went home is not missing a day: it is empty.
        const carried = outOf(c.chainId, day, lastKnown.get(c.chainId) ?? 0)
        if (carried >= LEFT_DUST) partial = true
        total += carried
      } else {
        lastKnown.set(c.chainId, v)
        total += outOf(c.chainId, day, v)
      }
    }
    return { day, usd: usd(total), ...(partial ? { partial: true as const } : {}) }
  })

  const today = days[days.length - 1]!
  const live = perChain.filter((c) => !sentHome.has(c.chainId) || outOf(c.chainId, today, lastKnown.get(c.chainId) ?? 0) >= LEFT_DUST)
  const reads = live.map((c) => c.readAt)
  const known = reads.filter((r): r is string => r !== null).sort()
  const stale = reads.some((r) => r === null || now.getTime() - Date.parse(r) > VALUE_STALE_MS)
  if (stale && points.length) points[points.length - 1] = { ...points[points.length - 1]!, partial: true }
  return { asOf: known[0] ?? null, points, chains: perChain.map((c) => c.chainId) }
}
