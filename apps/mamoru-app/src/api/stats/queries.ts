// Spec 013 amendment A1: the Stats figures, from D1 only (never the operator or an RPC on a request, R13). Builds a
// GuardInput: every figure with the owners behind it and whether it is complete; privacy.ts decides what is published.
// Money is raw USDC (6 decimals) in D1 and plain USD here.
//
// Scope: accounts with env 'prod' or 'beta' that are not test accounts. An owner is a user: their Base account and
// their sleeves on other chains are one owner ("account" in A1's S7–S9 means the owner's accounts added up).
// Owners behind a figure are those contributing a non-zero amount to it.
import type { Db } from '../env.ts'
import { loadEarned } from '../earned.ts'
import { aprRun } from './privacy.ts'
import type { GuardAprDay, GuardDepositsDay, GuardEarnedDay, GuardFigure, GuardInput, GuardSlice, GuardSplit } from './privacy.ts'

const USD = 1_000_000
const DAY_S = 86_400
const BASE = 8453
const MONAD = 143
const CHAIN_NAMES: Record<number, string> = { [BASE]: 'Base', [MONAD]: 'Monad' }
/** USD stablecoins counted in S10 and in "Stable pairs". */
export const STABLES = new Set(['USDC', 'USDT', 'USDbC', 'DAI', 'USDT0', 'AUSD'])
/** A balance above this is "funded" (S8) and an account row above it must be fresh. */
const FUNDED = 1 * USD

type Account = { account_key: string; user_id: string; chain_id: number; created_day: string }
type Latest = { account_key: string; chain_id: number; total_usdc: number; idle_usdc: number; lp_usdc: number; fees_usdc: number; owed_usdc: number; read_at: string; block: number; positions_json: string; tokens_json: string | null }
type Position = { pool?: string; token0?: string; token1?: string; valueUsdc?: string; value0Usdc?: string; value1Usdc?: string; feesUsdc?: string; owedUsdc?: string }
type Bridge = { id: string; direction: string; account_key: string; amount_usdc: number; state: string; burn_block: number | null; minted_block: number | null }
type Daily = { day: string; account_key: string; chain_id: number; total_close_usdc: number; idle_close_usdc: number; lp_close_usdc: number; fees_open_usdc: number; fees_close_usdc: number; collected_usdc: number | null }

/** A read older than this makes the snapshot figures incomplete (A1: stale reads hide the figure). */
const STALE_READ_MS = 60 * 60 * 1000
/**
 * An owner backs an earned figure with any positive earning (raw USDC). Unlike a balance, earnings cannot be faked
 * with dust: they need a position that earns fees or vault yield. Balances need FUNDED.
 */
const EARNED_FLOOR = 1

/** Raw-USDC amounts per owner behind one figure; owners() counts those at or above a floor. */
class Contrib {
  readonly byUser = new Map<string, number>()
  add(user: string, v: number) {
    if (v) this.byUser.set(user, (this.byUser.get(user) ?? 0) + v)
  }
  get total() {
    let t = 0
    for (const v of this.byUser.values()) t += v
    return t
  }
  owners(floor: number): Set<string> {
    return new Set([...this.byUser.entries()].filter(([, v]) => v >= floor).map(([u]) => u))
  }
}

const ELIGIBLE = `SELECT account_key, user_id, chain_id, substr(created_at, 1, 10) AS created_day FROM accounts WHERE env IN ('prod', 'beta') AND COALESCE(is_test, 0) = 0`
const dayOfS = (s: number) => new Date(s * 1000).toISOString().slice(0, 10)
const dayAfter = (day: string) => new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_S * 1000).toISOString().slice(0, 10)
const minIso = (xs: readonly string[]) => (xs.length ? [...xs].sort()[0]! : null)

/**
 * USDC in flight now between an account's Safes (plan §3.5), from the stored journals and the blocks of the stored
 * reads on each chain. `unplaced`: a transfer the rule cannot place (a read or a block missing).
 */
export function inFlightNow(bridges: readonly Bridge[], latestOf: (chainId: number, accountKey: string) => Latest | undefined, sleeveOf: (baseKey: string) => string | undefined): { moves: { baseKey: string; chainId: number; amount: number }[]; unplaced: boolean } {
  const moves: { baseKey: string; chainId: number; amount: number }[] = []
  let unplaced = false
  for (const b of bridges) {
    const sleeveKey = sleeveOf(b.account_key)
    const base = latestOf(BASE, b.account_key)
    const sleeve = sleeveKey ? latestOf(MONAD, sleeveKey) : undefined
    const [src, dst, dstChain] = b.direction === 'out' ? [base, sleeve, MONAD] : [sleeve, base, BASE]
    if (!src || !dst) {
      if (b.state !== 'minted') unplaced = true
      continue
    }
    if ((b.state === 'burned' && b.burn_block === null) || (b.state === 'minted' && b.minted_block === null)) {
      unplaced = true
      continue
    }
    const inSource = b.burn_block === null ? b.state === 'sending' || b.state === 'requested' : src.block < b.burn_block
    const inDest = b.state === 'minted' && dst.block >= b.minted_block!
    // In neither read: add it once, on the destination chain. In both: the reads count it twice, take one out there.
    const amount = !inSource && !inDest ? b.amount_usdc : inSource && inDest ? -b.amount_usdc : 0
    if (amount) moves.push({ baseKey: b.account_key, chainId: dstChain, amount })
  }
  return { moves, unplaced }
}

/** One account row's value split by token, place and chain (raw USDC). Null when the row lacks the A1-D2 detail. */
export function rowExposure(r: Latest): { byToken: Map<string, number>; byPlace: Map<string, number> } | null {
  let positions: Position[]
  try {
    positions = JSON.parse(r.positions_json) as Position[]
  } catch {
    return null
  }
  const byToken = new Map<string, number>()
  const byPlace = new Map<string, number>()
  let bad = false
  const add = (m: Map<string, number>, k: string, v: number) => {
    if (!Number.isFinite(v)) bad = true
    else if (v) m.set(k, (m.get(k) ?? 0) + v)
  }
  // Idle, by token (operator `tokensUsdc`). A row with idle money and no split cannot be placed by token.
  if (r.idle_usdc > 0) {
    if (r.tokens_json === null) return null
    let tokens: Record<string, string>
    try {
      tokens = JSON.parse(r.tokens_json) as Record<string, string>
    } catch {
      return null
    }
    let sum = 0
    for (const [t, v] of Object.entries(tokens)) {
      add(byToken, t, Number(v))
      sum += Number(v)
    }
    // The split must add up to the row's idle balance (to a dollar), or it is not the same read.
    if (!(Math.abs(sum - r.idle_usdc) <= USD)) return null
  }
  add(byPlace, 'Idle', r.idle_usdc)
  for (const p of positions) {
    const value = Number(p.valueUsdc ?? 0)
    const extra = Number(p.feesUsdc ?? 0) + Number(p.owedUsdc ?? 0)
    if (value + extra <= 0) continue
    if (!p.token0 || !p.token1 || p.value0Usdc === undefined || p.value1Usdc === undefined) return null
    const v0 = Number(p.value0Usdc)
    const v1 = Number(p.value1Usdc)
    // Fees and owed amounts follow the position's legs in proportion (a fully one-sided position: all to that leg).
    const share0 = v0 + v1 > 0 ? v0 / (v0 + v1) : 0.5
    add(byToken, p.token0, v0 + extra * share0)
    add(byToken, p.token1, v1 + extra * (1 - share0))
    add(byPlace, STABLES.has(p.token0) && STABLES.has(p.token1) ? 'Stable pairs' : 'Volatile pairs', value + extra)
  }
  // Vaults are USDC vaults: what the row holds beyond idle, positions and their fees and owed amounts.
  const vault = r.total_usdc - r.idle_usdc - r.lp_usdc - r.fees_usdc - r.owed_usdc
  if (vault < -USD) return null
  add(byToken, 'USDC', Math.max(0, vault))
  add(byPlace, 'Stable vaults', Math.max(0, vault))
  return bad ? null : { byToken, byPlace }
}

/** Accrued uncollected fees at a time: Σ fees_usd of the account's latest sample at or before it. Null without samples. */
async function accruedAt(db: Db, chainId: number, accountKey: string, t: number): Promise<number | null> {
  try {
    const row = await db
      .prepare(
        `SELECT SUM(fees_usd) AS fees, COUNT(*) AS n, COUNT(CASE WHEN pool LIKE 'pool:%' THEN 1 END) AS lp, COUNT(CASE WHEN pool LIKE 'pool:%' AND fees_usd IS NOT NULL THEN 1 END) AS priced
         FROM account_worked_samples WHERE chain_id = ?1 AND account_key = ?2 AND t_s = (SELECT MAX(t_s) FROM account_worked_samples WHERE chain_id = ?1 AND account_key = ?2 AND t_s <= ?3)`,
      )
      .bind(chainId, accountKey, t)
      .first<{ fees: number | null; n: number; lp: number; priced: number }>()
    // No sample, or a position row without its fees (written before the column, or unpriced): not known.
    if (!row || row.n === 0 || row.priced < row.lp) return null
    return row.fees ?? 0
  } catch {
    return null
  }
}

export async function statsInput(db: Db, now: Date): Promise<GuardInput> {
  const nowMs = now.getTime()
  const accounts = (await db.prepare(ELIGIBLE).all<Account>()).results
  const userOf = new Map(accounts.map((a) => [`${a.chain_id}:${a.account_key}`, a.user_id]))
  const userOfKey = (chainId: number, key: string) => userOf.get(`${chainId}:${key}`)
  const chainsWithAccounts = new Set(accounts.map((a) => a.chain_id))
  const sleeveByUser = new Map(accounts.filter((a) => a.chain_id === MONAD).map((a) => [a.user_id, a.account_key]))
  const baseUserOf = new Map(accounts.filter((a) => a.chain_id === BASE).map((a) => [a.account_key, a.user_id]))

  // ---- Snapshots from the latest reads ----
  const latestRows = (await db
    .prepare("SELECT account_key, chain_id, total_usdc, idle_usdc, lp_usdc, fees_usdc, owed_usdc, read_at, block, positions_json, tokens_json FROM account_snapshot_latest WHERE env IN ('prod', 'beta')")
    .all<Latest>()).results.filter((r) => userOfKey(r.chain_id, r.account_key) !== undefined)
  const latest = new Map(latestRows.map((r) => [`${r.chain_id}:${r.account_key}`, r]))
  // Complete only if every chain with accounts has reads and every read is at most 1 h old. An account the operator
  // never read (created, never activated: no Safe it tracks) has no row and holds nothing it manages.
  const chainsRead = new Set(latestRows.map((r) => r.chain_id))
  const everyAccountRead = [...chainsWithAccounts].every((c) => chainsRead.has(c))
  const freshRows = latestRows.every((r) => nowMs - Date.parse(r.read_at) <= STALE_READ_MS)
  let bridges: Bridge[] = []
  let bridgesKnown = true
  try {
    bridges = (await db.prepare("SELECT id, direction, account_key, amount_usdc, state, burn_block, minted_block FROM yield_ledger_bridges WHERE state IN ('sending', 'requested', 'burned', 'minted')").all<Bridge>()).results.filter((b) => baseUserOf.has(b.account_key))
  } catch {
    bridgesKnown = false
  }
  const flight = inFlightNow(bridges, (c, k) => latest.get(`${c}:${k}`), (k) => sleeveByUser.get(baseUserOf.get(k) ?? ''))
  const snapshotComplete = latestRows.length > 0 && everyAccountRead && freshRows && bridgesKnown && !flight.unplaced
  const dataAsOf = minIso(latestRows.map((r) => r.read_at))

  // Contributions per owner; an owner backs a figure only with at least FUNDED in it (no dust owners, review P1).
  const s1 = new Contrib()
  const s2 = new Contrib()
  const s3 = new Contrib()
  const byToken = new Map<string, Contrib>()
  const byPlace = new Map<string, Contrib>()
  const byChain = new Map<string, Contrib>()
  const into = (m: Map<string, Contrib>, k: string) => m.get(k) ?? m.set(k, new Contrib()).get(k)!
  let splitComplete = snapshotComplete
  for (const r of latestRows) {
    const user = userOfKey(r.chain_id, r.account_key)!
    const working = r.total_usdc - r.idle_usdc - r.fees_usdc - r.owed_usdc
    s1.add(user, r.total_usdc)
    s2.add(user, Math.max(0, working))
    s3.add(user, r.idle_usdc)
    into(byChain, CHAIN_NAMES[r.chain_id] ?? String(r.chain_id)).add(user, r.total_usdc)
    const e = rowExposure(r)
    if (!e) {
      splitComplete = false
      continue
    }
    for (const [k, v] of e.byToken) into(byToken, k).add(user, v)
    for (const [k, v] of e.byPlace) into(byPlace, k).add(user, v)
  }
  // USDC in flight: counted once, as idle USDC, on the destination chain (a double count is taken out the same way).
  for (const m of flight.moves) {
    const user = baseUserOf.get(m.baseKey)!
    s1.add(user, m.amount)
    s3.add(user, m.amount)
    into(byToken, 'USDC').add(user, m.amount)
    into(byPlace, 'Idle').add(user, m.amount)
    into(byChain, CHAIN_NAMES[m.chainId]!).add(user, m.amount)
  }
  const funded = [...s1.byUser.entries()].filter(([, v]) => v > FUNDED)
  const fundedOwners = new Set(funded.map(([u]) => u))
  const stable = new Contrib()
  for (const [t, c] of byToken) if (STABLES.has(t)) for (const [u, v] of c.byUser) stable.add(u, v)
  const fig = (value: number, owners: ReadonlySet<string>, complete: boolean, at: string | null = dataAsOf): GuardFigure => ({ value, owners, complete, dataAsOf: at })
  const totalAccounts = new Set(accounts.filter((a) => a.chain_id === BASE).map((a) => a.user_id))
  const split = (m: Map<string, Contrib>, complete: boolean): GuardSplit => ({
    slices: [...m.entries()].map(([key, c]): GuardSlice => ({ key, usd: c.total / USD, owners: c.owners(FUNDED) })),
    complete,
    dataAsOf,
  })

  // ---- Earned (S4, S5): spec 012's earned.ts per account and chain ----
  let total = 0
  let last24 = 0
  let totalComplete = everyAccountRead && latestRows.length > 0
  let dayComplete = totalComplete
  const totalOwners = new Contrib()
  const dayOwners = new Contrib()
  const earnedAt: string[] = []
  for (const a of accounts) {
    if (!latest.has(`${a.chain_id}:${a.account_key}`)) continue
    const e = await loadEarned(db, a.chain_id, a.account_key)
    if (!e) {
      totalComplete = false
      dayComplete = false
      continue
    }
    earnedAt.push(e.asOf)
    const t = Number(e.totalUsd)
    let d = Number(e.last24hUsd)
    total += t
    totalOwners.add(a.user_id, t)
    if (e.status !== 'complete') totalComplete = false
    // earned.ts names the accrued change over the window as not counted until it reads fee samples; with them here
    // (spec 013 B5, account_worked_samples.fees_usd) the window is complete.
    let missing: string[] = e.last24hNotCounted.filter((x) => x !== 'accrued-24h')
    if (e.last24hNotCounted.includes('accrued-24h')) {
      const tA = Math.floor(Date.parse(e.asOf) / 1000)
      const [nowFees, thenFees] = await Promise.all([accruedAt(db, a.chain_id, a.account_key, tA), accruedAt(db, a.chain_id, a.account_key, tA - DAY_S)])
      if (nowFees === null || thenFees === null) missing = [...missing, 'accrued-24h']
      else d += nowFees - thenFees
    }
    if (missing.length) dayComplete = false
    last24 += d
    dayOwners.add(a.user_id, d)
  }
  const earnedAsOf = minIso(earnedAt)
  if (earnedAsOf && dataAsOf && Date.parse(dataAsOf) - Date.parse(earnedAsOf) > 15 * 60 * 1000) {
    totalComplete = false
    dayComplete = false
  }
  // Ot and Brais, 6 Nov: earned is published as the industry does, an approximate figure of what is counted (fees
  // collected and accrued, vault yield where the shares are explained), not hidden until every part is known. It still
  // needs every account read and at least one account with an earned figure.
  const earnedPublished = everyAccountRead && latestRows.length > 0 && earnedAt.length > 0
  totalComplete = earnedPublished
  dayComplete = earnedPublished

  // ---- Days (T1, T2, T3, S6) from account_daily ----
  const daily = (await db
    .prepare("SELECT d.day, d.account_key, d.chain_id, d.total_close_usdc, d.idle_close_usdc, d.lp_close_usdc, d.fees_open_usdc, d.fees_close_usdc, d.collected_usdc FROM account_daily d WHERE d.env IN ('prod', 'beta') ORDER BY d.day")
    .all<Daily>()).results.filter((r) => userOfKey(r.chain_id, r.account_key) !== undefined)
  // Receipts that exist but are not priced yet make their day incomplete (a NULL collected with no receipt is 0).
  const unpriced = new Set<string>()
  try {
    for (const r of (await db.prepare('SELECT day, chain_id, account_key FROM yield_ledger_account_receipts WHERE collected_usdc IS NULL').all<{ day: string; chain_id: number; account_key: string }>()).results) unpriced.add(`${r.day}:${r.chain_id}:${r.account_key}`)
  } catch {
    // no receipts table: nothing known unpriced
  }
  const vaultYield = new Map<string, number>()
  let incomeKnown = true
  try {
    for (const r of (await db.prepare("SELECT chain_id, account_key, t_s, usd FROM yield_ledger_income WHERE source = 'vault-yield'").all<{ chain_id: number; account_key: string; t_s: number; usd: number | null }>()).results) {
      const k = `${dayOfS(r.t_s)}:${r.chain_id}:${r.account_key}`
      vaultYield.set(k, r.usd === null ? Number.NaN : (vaultYield.get(k) ?? 0) + r.usd)
    }
  } catch {
    incomeKnown = false
  }
  // Days before the ledger: the backfill's full-day vault yield (stats_vault_daily) is taken over ledger rows.
  const vaultDaily = new Map<string, number>()
  try {
    for (const r of (await db.prepare('SELECT day, chain_id, account_key, usd FROM stats_vault_daily').all<{ day: string; chain_id: number; account_key: string; usd: number }>()).results) vaultDaily.set(`${r.day}:${r.chain_id}:${r.account_key}`, r.usd)
  } catch {
    // no backfill table: ledger rows only
  }
  const firstByChain = new Map<number, string>()
  for (const r of daily) if (!firstByChain.has(r.chain_id)) firstByChain.set(r.chain_id, r.day)
  // A1: a day counts only if every chain is known that day. A chain is needed from the day its first account was
  // created (before that it holds nothing); from then on it must have daily rows.
  const createdByChain = new Map<number, string>()
  for (const r of (await db.prepare(`SELECT chain_id, MIN(substr(created_at, 1, 10)) AS day FROM accounts WHERE env IN ('prod', 'beta') AND COALESCE(is_test, 0) = 0 GROUP BY chain_id`).all<{ chain_id: number; day: string }>()).results) createdByChain.set(r.chain_id, r.day)
  const chainsKnownOn = (day: string, chains: readonly number[]) => chains.every((c) => (createdByChain.get(c) ?? '9999') > day || (firstByChain.get(c) ?? '9999') <= day)
  const allKnownFrom = firstByChain.size ? [...firstByChain.values()].sort()[0]! : null
  const today = now.toISOString().slice(0, 10)
  type DayAcc = { earned: Contrib; collected: Contrib; capital: Contrib; deposits: Contrib; rows: Set<string>; complete: boolean }
  const newDay = (): DayAcc => ({ earned: new Contrib(), collected: new Contrib(), capital: new Contrib(), deposits: new Contrib(), rows: new Set(), complete: true })
  const perChainDays = (chain: number | null) => {
    const days = new Map<string, DayAcc>()
    const prevWorking = new Map<string, number>()
    for (const r of daily) {
      if (chain !== null && r.chain_id !== chain) continue
      const user = userOfKey(r.chain_id, r.account_key)!
      const acc = days.get(r.day) ?? days.set(r.day, newDay()).get(r.day)!
      const k = `${r.day}:${r.chain_id}:${r.account_key}`
      acc.rows.add(`${r.chain_id}:${r.account_key}`)
      const working = r.total_close_usdc - r.idle_close_usdc - r.fees_close_usdc
      const vaultClose = working - r.lp_close_usdc
      // The open of a day is the previous close (0 before the account's first row), as the chain script does.
      const prev = prevWorking.get(`${r.chain_id}:${r.account_key}`) ?? 0
      prevWorking.set(`${r.chain_id}:${r.account_key}`, working)
      const collected = r.collected_usdc ?? 0
      if (unpriced.has(k)) acc.complete = false
      // Vault money that day needs its yield (backfilled for the past, the ledger after); without it the day is short.
      let vy = 0
      const backfilled = vaultDaily.get(k)
      if (backfilled !== undefined) vy = backfilled
      else if (vaultClose > FUNDED) {
        const v = vaultYield.get(k)
        if (!incomeKnown || v === undefined || Number.isNaN(v)) acc.complete = false
        else vy = v
      }
      acc.earned.add(user, r.fees_close_usdc - r.fees_open_usdc + collected + vy)
      acc.collected.add(user, collected)
      acc.capital.add(user, (prev + working) / 2)
      acc.deposits.add(user, r.total_close_usdc)
    }
    return days
  }
  // No silent gaps (review P1): an account the cron writes (it has daily rows) must have one on every day from its
  // first row on, through its last row, or through today while its latest read still holds money.
  const span = new Map<string, { first: string; last: string }>()
  for (const r of daily) {
    const k = `${r.chain_id}:${r.account_key}`
    const x = span.get(k)
    span.set(k, x ? { first: x.first < r.day ? x.first : r.day, last: x.last > r.day ? x.last : r.day } : { first: r.day, last: r.day })
  }
  const rowsComplete = (day: string, d: DayAcc, chains: readonly number[]) =>
    [...span.entries()].every(([k, x]) => {
      if (!chains.includes(Number(k.split(':')[0]))) return true
      const live = (latest.get(k)?.total_usdc ?? 0) > FUNDED
      return day < x.first || (day > x.last && !live) || d.rows.has(k)
    })
  const dayList = (days: Map<string, DayAcc>, from: string | null, chains: readonly number[]) => {
    if (from === null) return []
    const out: (DayAcc & { day: string })[] = []
    // Closed days only: today has no close yet (S1 and S4 are the figures for now).
    for (let day = from; day < today; day = dayAfter(day)) {
      const d = days.get(day) ?? { ...newDay(), complete: false }
      out.push({ day, ...d, complete: d.complete && chainsKnownOn(day, chains) && rowsComplete(day, d, chains) })
    }
    return out
  }
  const aprDays = (chain: number | null): GuardAprDay[] => {
    const from = chain === null ? allKnownFrom : firstByChain.get(chain) ?? null
    // The APR's owners are those who earned (at least a cent) that day: the rate is their earnings over the capital.
    return dayList(perChainDays(chain), from, chain === null ? [...chainsWithAccounts] : [chain]).map((d) => ({ day: d.day, earned: d.earned.total / USD, capital: d.capital.total / USD, owners: d.earned.owners(EARNED_FLOOR), complete: d.complete }))
  }
  const allDays = dayList(perChainDays(null), allKnownFrom, [...chainsWithAccounts])
  const aprAll = aprDays(null)
  // S6: the 7-day figure of the last day, from the same series privacy.ts guards.
  // An incomplete trailing day is skipped (as the series do), so one unpriced day does not withhold the figure.
  const last7 = aprRun(aprAll).slice(-7)
  const s6Complete = last7.length === 7
  const s6 = s6Complete ? (last7.reduce((a, d) => a + d.earned, 0) / last7.reduce((a, d) => a + d.capital, 0)) * 365 * 100 : Number.NaN
  const s6Owners = new Set(last7.flatMap((d) => [...d.owners]))

  return {
    now,
    snapshots: {
      totalDeposits: fig(s1.total / USD, s1.owners(FUNDED), snapshotComplete),
      moneyWorking: fig(s2.total / USD, s2.owners(FUNDED), snapshotComplete),
      idleCapital: fig(s3.total / USD, s3.owners(FUNDED), snapshotComplete),
      earned24h: fig(last24 / USD, dayOwners.owners(EARNED_FLOOR), dayComplete, earnedAsOf),
      totalEarned: fig(total / USD, totalOwners.owners(EARNED_FLOOR), totalComplete, earnedAsOf),
      apr7d: fig(s6, s6Owners, s6Complete),
      // A count from the accounts table, read now: its time is the request's.
      totalAccounts: fig(totalAccounts.size, totalAccounts, true, now.toISOString()),
      averageAccount: fig(funded.length ? s1.total / USD / funded.length : Number.NaN, fundedOwners, snapshotComplete),
      largestAccount: fig(funded.length ? Math.max(...funded.map(([, v]) => v)) / USD : Number.NaN, fundedOwners, snapshotComplete),
      inStablecoins: fig(s1.total > 0 ? (stable.total / s1.total) * 100 : Number.NaN, stable.owners(FUNDED), splitComplete),
    },
    distributions: {
      byToken: split(byToken, splitComplete),
      byChain: split(byChain, snapshotComplete),
      byPlace: split(byPlace, splitComplete),
    },
    apr: {
      all: aprAll,
      ...(chainsWithAccounts.has(BASE) ? { base: aprDays(BASE) } : {}),
      ...(chainsWithAccounts.has(MONAD) ? { monad: aprDays(MONAD) } : {}),
    },
    earnedPerDay: allDays.map((d): GuardEarnedDay => ({ day: d.day, usd: d.earned.total / USD, collectedUsd: d.collected.total / USD, owners: d.earned.owners(EARNED_FLOOR), collectors: d.collected.owners(EARNED_FLOOR), complete: d.complete })),
    totalDeposits: allDays.map((d): GuardDepositsDay => ({ day: d.day, usd: d.deposits.total / USD, owners: d.deposits.owners(FUNDED), complete: d.complete })),
  }
}
