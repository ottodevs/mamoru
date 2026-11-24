// Spec 013 STATS-R14: the Portfolio's Total value chart. One point per UTC day: the owner's accounts on every chain
// (Base account and its sleeves, `sleevesOfUser`) summed from `account_daily.total_close_usdc`, today's row being the
// running close the cron keeps updating. Chains are aligned by last known value, never by an exact join: a chain with
// no row on a day contributes its previous close and the point says `partial`; before a chain's first row it adds
// nothing (the account did not exist). The last point is also `partial` when a chain's latest read is older than
// VALUE_STALE_MS. Intraday points from `account_worked_samples` are left out on purpose: those samples omit idle money
// whenever positions exist, so a sum of them would understate the value. Pure D1 reads.
//
// otto/mamoru#460: transfers between Base and Monad (yield_ledger_bridges). After Leave Monad the operator stops
// reading the Monad Safe, so its last close (read before the burn) was carried forward while the same USDC already
// counted on Base. Each day compares the transfers with that day's closing reads (`account_daily.block_close`, carried
// with the close), as Stats `inFlightNow` does for now: a transfer the source read still holds (read before the burn
// block, which is the burn tx's own block) and the destination read already holds (read at or after `minted_block`) is
// taken out of the source once. It is never added for a transfer in neither read: `minted_block` can be later than the
// real mint (an adopted mint records the block it was found at, mamoru-operator return-home.ts), so "not in the
// destination yet" is not certain and adding would count it twice. Such a day is only marked `partial`. With that
// upper bound the subtraction stays safe: at or after it the mint has happened. A chain whose placed value is under a
// cent is empty: a missing day of it is not partial, and its old read does not hold `asOf` back or make the series stale.
import type { Db } from '../env.ts'
import { sleevesOfUser } from './store.ts'

export const VALUE_STALE_MS = 30 * 60 * 1000
/** Raw USDC under one cent: an empty chain (a left sleeve's dust). */
const EMPTY = 10_000
const BASE = 8453
const MONAD = 143

export type ValuePoint = { day: string; usd: number; partial?: true }
export type ValueSeriesView = {
  /** Oldest latest read among the chains that have one (ISO), null before the first read. */
  asOf: string | null
  points: ValuePoint[]
  /** Chain ids that contributed at least one row. */
  chains: number[]
}

type Close = { total: number; block: number }
type Bridge = { direction: string; amount_usdc: number; state: string; burn_block: number | null; minted_block: number | null }

const usd = (baseUnits: number) => Math.round(baseUnits / 10_000) / 100

/**
 * What the bridges change in one day's closes: the amount each source chain still holds although its destination
 * already does (taken out of the source), and whether a transfer may be in neither read (the point is then partial).
 */
export function bridgeMoves(bridges: readonly Bridge[], base: Close | undefined, monad: Close | undefined): { out: Map<number, number>; unplaced: boolean } {
  const out = new Map<number, number>()
  let unplaced = false
  if (!base || !monad) return { out, unplaced }
  for (const b of bridges) {
    if ((b.state === 'burned' && b.burn_block === null) || (b.state === 'minted' && b.minted_block === null)) {
      unplaced = true
      continue
    }
    const [src, dst, srcChain] = b.direction === 'out' ? [base, monad, BASE] : [monad, base, MONAD]
    const inSource = b.burn_block === null ? b.state === 'sending' || b.state === 'requested' : src.block < b.burn_block
    const inDest = b.state === 'minted' && dst.block >= b.minted_block!
    if (inSource && inDest) {
      // The read is before the burn, but it holds the burned money only if nothing arrived on the source chain between
      // the two (review #426 r3). A transfer into that chain minted after the read and by the burn: not certain, so the
      // day is partial and nothing is taken out. A deposit from outside the app in that window is not visible here (the
      // same limit as Stats); the clamp at zero bounds what it can take out.
      const arrived = bridges.some((a) => a !== b && a.state === 'minted' && a.minted_block !== null && (a.direction === 'out' ? MONAD : BASE) === srcChain && a.minted_block > src.block && a.minted_block <= b.burn_block!)
      if (arrived) unplaced = true
      else out.set(srcChain, (out.get(srcChain) ?? 0) + b.amount_usdc)
    } else if (!inSource && !inDest) unplaced = true
  }
  return { out, unplaced }
}

export async function loadValueSeries(db: Db, userId: string, now: Date): Promise<ValueSeriesView> {
  const sleeves = await sleevesOfUser(db, userId)
  const perChain: { chainId: number; byDay: Map<string, Close>; readAt: string | null }[] = []
  for (const s of sleeves) {
    const rows = (await db
      .prepare('SELECT day, total_close_usdc, block_close FROM account_daily WHERE chain_id = ? AND account_key = ? ORDER BY day')
      .bind(s.chain_id, s.account_key)
      .all<{ day: string; total_close_usdc: number; block_close: number }>()).results
    if (!rows.length) continue
    const last = await db
      .prepare('SELECT read_at FROM account_snapshot_latest WHERE chain_id = ? AND account_key = ?')
      .bind(s.chain_id, s.account_key)
      .first<{ read_at: string }>()
    perChain.push({
      chainId: s.chain_id,
      byDay: new Map(rows.map((r) => [r.day, { total: r.total_close_usdc, block: r.block_close }])),
      readAt: last?.read_at ?? null,
    })
  }
  if (!perChain.length) return { asOf: null, points: [], chains: [] }

  const baseKey = sleeves.find((s) => s.chain_id === BASE)?.account_key
  let bridges: Bridge[] = []
  if (baseKey && perChain.some((c) => c.chainId === MONAD)) {
    try {
      bridges = (await db
        .prepare("SELECT direction, amount_usdc, state, burn_block, minted_block FROM yield_ledger_bridges WHERE account_key = ? AND state IN ('sending', 'requested', 'burned', 'minted')")
        .bind(baseKey)
        .all<Bridge>()).results
    } catch {
      bridges = [] // table not migrated yet: closes as they are
    }
  }

  const days = [...new Set(perChain.flatMap((c) => [...c.byDay.keys()]))].sort()
  const firstDay = new Map(perChain.map((c) => [c.chainId, [...c.byDay.keys()].sort()[0]!]))
  const lastKnown = new Map<number, Close>()
  const placedOn = new Map<number, number>() // each chain's placed value on the last day
  const points: ValuePoint[] = days.map((day) => {
    const closes = new Map<number, { close: Close; carried: boolean }>()
    for (const c of perChain) {
      if (day < firstDay.get(c.chainId)!) continue
      const v = c.byDay.get(day)
      if (v !== undefined) lastKnown.set(c.chainId, v)
      closes.set(c.chainId, { close: v ?? lastKnown.get(c.chainId)!, carried: v === undefined })
    }
    const moves = bridgeMoves(bridges, closes.get(BASE)?.close, closes.get(MONAD)?.close)
    let total = 0
    let partial = moves.unplaced
    for (const [chainId, { close, carried }] of closes) {
      const placed = Math.max(0, close.total - (moves.out.get(chainId) ?? 0))
      placedOn.set(chainId, placed)
      if (carried && placed >= EMPTY) partial = true
      total += placed
    }
    return { day, usd: usd(total), ...(partial ? { partial: true as const } : {}) }
  })

  // An empty sleeve (left, or never refilled) is not read any more and says nothing about freshness. Base always counts.
  const live = perChain.filter((c) => c.chainId === BASE || (placedOn.get(c.chainId) ?? 0) >= EMPTY)
  const reads = live.map((c) => c.readAt)
  const known = reads.filter((r): r is string => r !== null).sort()
  const stale = reads.some((r) => r === null || now.getTime() - Date.parse(r) > VALUE_STALE_MS)
  if (stale && points.length) points[points.length - 1] = { ...points[points.length - 1]!, partial: true }
  return { asOf: known[0] ?? null, points, chains: perChain.map((c) => c.chainId) }
}
