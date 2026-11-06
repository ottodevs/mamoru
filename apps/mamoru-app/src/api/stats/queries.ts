// Spec 013 amendment A1: the Stats figures, from D1 only (never the operator or an RPC on a request, R13). Builds a
// GuardInput: every figure with the owners behind it and whether it is complete; privacy.ts decides what is published.
// Money is raw USDC (6 decimals) in D1 and plain USD here.
//
// Scope: accounts with env 'prod' or 'beta' that are not test accounts. An owner is a user: their Base account and
// their sleeves on other chains are one owner ("account" in A1's S7–S9 means the owner's accounts added up).
// Owners behind a figure are those contributing a non-zero amount to it.
import type { Db } from '../env.ts'
import { loadEarned } from '../earned.ts'
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

type Account = { account_key: string; user_id: string; chain_id: number }
type Latest = { account_key: string; chain_id: number; total_usdc: number; idle_usdc: number; lp_usdc: number; fees_usdc: number; owed_usdc: number; read_at: string; block: number; positions_json: string; tokens_json: string | null }
type Position = { pool?: string; token0?: string; token1?: string; valueUsdc?: string; value0Usdc?: string; value1Usdc?: string; feesUsdc?: string; owedUsdc?: string }
type Bridge = { id: string; direction: string; account_key: string; amount_usdc: number; state: string; burn_block: number | null; minted_block: number | null }
type Daily = { day: string; account_key: string; chain_id: number; total_close_usdc: number; idle_close_usdc: number; lp_close_usdc: number; fees_open_usdc: number; fees_close_usdc: number; collected_usdc: number | null }

const ELIGIBLE = `SELECT account_key, user_id, chain_id FROM accounts WHERE env IN ('prod', 'beta') AND COALESCE(is_test, 0) = 0`
const dayOfS = (s: number) => new Date(s * 1000).toISOString().slice(0, 10)
const dayAfter = (day: string) => new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_S * 1000).toISOString().slice(0, 10)
const minIso = (xs: readonly string[]) => (xs.length ? [...xs].sort()[0]! : null)

/**
 * USDC in flight now between an account's Safes (plan §3.5), from the stored journals and the blocks of the stored
 * reads on each chain. `unplaced`: a transfer the rule cannot place (a read or a block missing).
 */
export function inFlightNow(bridges: readonly Bridge[], latestOf: (chainId: number, accountKey: string) => Latest | undefined, sleeveOf: (baseKey: string) => string | undefined): { byAccount: Map<string, number>; unplaced: boolean } {
  const byAccount = new Map<string, number>()
  let unplaced = false
  for (const b of bridges) {
    const sleeveKey = sleeveOf(b.account_key)
    const base = latestOf(BASE, b.account_key)
    const sleeve = sleeveKey ? latestOf(MONAD, sleeveKey) : undefined
    const [src, dst] = b.direction === 'out' ? [base, sleeve] : [sleeve, base]
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
    const delta = !inSource && !inDest ? b.amount_usdc : inSource && inDest ? -b.amount_usdc : 0
    if (delta) byAccount.set(b.account_key, (byAccount.get(b.account_key) ?? 0) + delta)
  }
  return { byAccount, unplaced }
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
  const add = (m: Map<string, number>, k: string, v: number) => v && m.set(k, (m.get(k) ?? 0) + v)
  // Idle, by token (operator `tokensUsdc`). A row with idle money and no split cannot be placed by token.
  if (r.idle_usdc > 0) {
    if (r.tokens_json === null) return null
    let tokens: Record<string, string>
    try {
      tokens = JSON.parse(r.tokens_json) as Record<string, string>
    } catch {
      return null
    }
    for (const [t, v] of Object.entries(tokens)) add(byToken, t, Number(v))
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
  const vault = Math.max(0, r.total_usdc - r.idle_usdc - r.lp_usdc - r.fees_usdc - r.owed_usdc)
  add(byToken, 'USDC', vault)
  add(byPlace, 'Stable vaults', vault)
  return { byToken, byPlace }
}

/** Accrued uncollected fees at a time: Σ fees_usd of the account's latest sample at or before it. Null without samples. */
async function accruedAt(db: Db, chainId: number, accountKey: string, t: number): Promise<number | null> {
  try {
    const row = await db
      .prepare('SELECT SUM(fees_usd) AS fees, COUNT(*) AS n, COUNT(fees_usd) AS priced FROM account_worked_samples WHERE chain_id = ?1 AND account_key = ?2 AND t_s = (SELECT MAX(t_s) FROM account_worked_samples WHERE chain_id = ?1 AND account_key = ?2 AND t_s <= ?3)')
      .bind(chainId, accountKey, t)
      .first<{ fees: number | null; n: number; priced: number }>()
    if (!row || row.n === 0) return null
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
  const chainsRead = new Set(latestRows.map((r) => r.chain_id))
  // Every chain that has accounts must have been read, and every row that holds money must be fresh.
  const allChains = [...chainsWithAccounts].every((c) => chainsRead.has(c))
  const freshRows = latestRows.every((r) => r.total_usdc <= FUNDED || nowMs - Date.parse(r.read_at) <= 60 * 60 * 1000)
  let bridges: Bridge[] = []
  let bridgesKnown = true
  try {
    bridges = (await db.prepare("SELECT id, direction, account_key, amount_usdc, state, burn_block, minted_block FROM yield_ledger_bridges WHERE state IN ('sending', 'requested', 'burned', 'minted')").all<Bridge>()).results.filter((b) => baseUserOf.has(b.account_key))
  } catch {
    bridgesKnown = false
  }
  const flight = inFlightNow(bridges, (c, k) => latest.get(`${c}:${k}`), (k) => sleeveByUser.get(baseUserOf.get(k) ?? ''))
  const snapshotComplete = allChains && freshRows && bridgesKnown && !flight.unplaced
  const dataAsOf = minIso(latestRows.filter((r) => r.total_usdc > FUNDED).map((r) => r.read_at)) ?? minIso(latestRows.map((r) => r.read_at))

  const perUser = new Map<string, number>()
  const s1Owners = new Set<string>()
  const s2Owners = new Set<string>()
  const s3Owners = new Set<string>()
  let s1 = 0
  let s2 = 0
  let s3 = 0
  const tokenUsd = new Map<string, number>()
  const tokenOwners = new Map<string, Set<string>>()
  const placeUsd = new Map<string, number>()
  const placeOwners = new Map<string, Set<string>>()
  const chainUsd = new Map<string, number>()
  const chainOwners = new Map<string, Set<string>>()
  let splitComplete = snapshotComplete
  const addTo = (usd: Map<string, number>, owners: Map<string, Set<string>>, key: string, v: number, user: string) => {
    if (v <= 0) return
    usd.set(key, (usd.get(key) ?? 0) + v)
    owners.set(key, (owners.get(key) ?? new Set()).add(user))
  }
  for (const r of latestRows) {
    const user = userOfKey(r.chain_id, r.account_key)!
    const working = r.total_usdc - r.idle_usdc - r.fees_usdc - r.owed_usdc
    s1 += r.total_usdc
    s2 += Math.max(0, working)
    s3 += r.idle_usdc
    if (r.total_usdc > 0) s1Owners.add(user)
    if (working > 0) s2Owners.add(user)
    if (r.idle_usdc > 0) s3Owners.add(user)
    perUser.set(user, (perUser.get(user) ?? 0) + r.total_usdc)
    addTo(chainUsd, chainOwners, CHAIN_NAMES[r.chain_id] ?? String(r.chain_id), r.total_usdc, user)
    const e = rowExposure(r)
    if (!e) {
      splitComplete = false
      continue
    }
    for (const [k, v] of e.byToken) addTo(tokenUsd, tokenOwners, k, v, user)
    for (const [k, v] of e.byPlace) addTo(placeUsd, placeOwners, k, v, user)
  }
  // USDC in flight: counted once, as USDC, idle, on the destination chain.
  for (const [baseKey, amount] of flight.byAccount) {
    const user = baseUserOf.get(baseKey)!
    s1 += amount
    perUser.set(user, (perUser.get(user) ?? 0) + amount)
    if (amount > 0) {
      s1Owners.add(user)
      addTo(tokenUsd, tokenOwners, 'USDC', amount, user)
      addTo(placeUsd, placeOwners, 'Idle', amount, user)
      addTo(chainUsd, chainOwners, 'Monad', amount, user)
    }
  }
  const funded = [...perUser.entries()].filter(([, v]) => v > FUNDED)
  const fundedOwners = new Set(funded.map(([u]) => u))
  const stableUsd = [...tokenUsd.entries()].filter(([t]) => STABLES.has(t)).reduce((a, [, v]) => a + v, 0)
  const stableOwners = new Set([...tokenOwners.entries()].filter(([t]) => STABLES.has(t)).flatMap(([, o]) => [...o]))
  const fig = (value: number, owners: ReadonlySet<string>, complete: boolean, at: string | null = dataAsOf): GuardFigure => ({ value, owners, complete, dataAsOf: at })
  const totalAccounts = new Set(accounts.filter((a) => a.chain_id === BASE).map((a) => a.user_id))

  const split = (usd: Map<string, number>, owners: Map<string, Set<string>>, complete: boolean): GuardSplit => ({
    slices: [...usd.entries()].map(([key, v]): GuardSlice => ({ key, usd: v / USD, owners: owners.get(key) ?? new Set() })),
    complete,
    dataAsOf,
  })

  // ---- Earned (S4, S5): spec 012's earned.ts per account and chain ----
  let total = 0
  let last24 = 0
  let totalComplete = latestRows.length > 0
  let dayComplete = latestRows.length > 0
  const totalOwners = new Set<string>()
  const dayOwners = new Set<string>()
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
    if (t !== 0) totalOwners.add(a.user_id)
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
    if (d !== 0) dayOwners.add(a.user_id)
  }
  const earnedAsOf = minIso(earnedAt)
  if (earnedAsOf && dataAsOf && Date.parse(dataAsOf) - Date.parse(earnedAsOf) > 15 * 60 * 1000) {
    totalComplete = false
    dayComplete = false
  }

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
  const firstByChain = new Map<number, string>()
  for (const r of daily) if (!firstByChain.has(r.chain_id)) firstByChain.set(r.chain_id, r.day)
  // A day counts only once every chain that has accounts is known (A1: "since the first day every chain is known").
  const allKnownFrom = [...chainsWithAccounts].every((c) => firstByChain.has(c)) ? [...firstByChain.values()].sort().at(-1)! : null
  const today = now.toISOString().slice(0, 10)
  type DayAcc = { earned: number; collected: number; capital: number; deposits: number; earners: Set<string>; workers: Set<string>; holders: Set<string>; complete: boolean }
  const perChainDays = (chain: number | null) => {
    const days = new Map<string, DayAcc>()
    const prevWorking = new Map<string, number>()
    for (const r of daily) {
      if (chain !== null && r.chain_id !== chain) continue
      const user = userOfKey(r.chain_id, r.account_key)!
      const acc = days.get(r.day) ?? { earned: 0, collected: 0, capital: 0, deposits: 0, earners: new Set(), workers: new Set(), holders: new Set(), complete: true }
      days.set(r.day, acc)
      const k = `${r.day}:${r.chain_id}:${r.account_key}`
      const working = r.total_close_usdc - r.idle_close_usdc - r.fees_close_usdc
      const vaultClose = working - r.lp_close_usdc
      const prev = prevWorking.get(`${r.chain_id}:${r.account_key}`) ?? 0
      prevWorking.set(`${r.chain_id}:${r.account_key}`, working)
      const collected = r.collected_usdc ?? 0
      if (unpriced.has(k)) acc.complete = false
      // Vault money that day needs its yield in the ledger; without it the day's earnings are short.
      let vy = 0
      if (vaultClose > FUNDED) {
        const v = vaultYield.get(k)
        if (!incomeKnown || v === undefined || Number.isNaN(v)) acc.complete = false
        else vy = v
      }
      const earned = r.fees_close_usdc - r.fees_open_usdc + collected + vy
      acc.earned += earned / USD
      acc.collected += collected / USD
      acc.capital += (prev + working) / 2 / USD
      acc.deposits += r.total_close_usdc / USD
      if (earned !== 0) acc.earners.add(user)
      if (working > 0 || prev > 0) acc.workers.add(user)
      if (r.total_close_usdc > 0) acc.holders.add(user)
    }
    return days
  }
  const dayList = (days: Map<string, DayAcc>, from: string | null) => {
    if (from === null) return []
    const out: (DayAcc & { day: string })[] = []
    for (let day = from; day <= today; day = dayAfter(day)) out.push({ day, ...(days.get(day) ?? { earned: 0, collected: 0, capital: 0, deposits: 0, earners: new Set(), workers: new Set(), holders: new Set(), complete: false }) })
    return out
  }
  const aprDays = (chain: number | null): GuardAprDay[] => {
    const from = chain === null ? allKnownFrom : firstByChain.get(chain) ?? null
    return dayList(perChainDays(chain), from).map((d) => ({ day: d.day, earned: d.earned, capital: d.capital, owners: d.workers, complete: d.complete }))
  }
  const allDays = dayList(perChainDays(null), allKnownFrom)
  const aprAll = aprDays(null)
  // S6: the 7-day figure of the last day, from the same series privacy.ts guards.
  const last7 = aprAll.slice(-7)
  const s6Complete = last7.length === 7 && last7.every((d) => d.complete && d.capital > 0)
  const s6 = s6Complete ? (last7.reduce((a, d) => a + d.earned, 0) / last7.reduce((a, d) => a + d.capital, 0)) * 365 * 100 : Number.NaN
  const s6Owners = new Set(last7.flatMap((d) => [...d.owners]))

  return {
    now,
    snapshots: {
      totalDeposits: fig(s1 / USD, s1Owners, snapshotComplete),
      moneyWorking: fig(s2 / USD, s2Owners, snapshotComplete),
      idleCapital: fig(s3 / USD, s3Owners, snapshotComplete),
      earned24h: fig(last24 / USD, dayOwners, dayComplete, earnedAsOf),
      totalEarned: fig(total / USD, totalOwners, totalComplete, earnedAsOf),
      apr7d: fig(s6, s6Owners, s6Complete),
      totalAccounts: fig(totalAccounts.size, totalAccounts, true),
      averageAccount: fig(funded.length ? s1 / USD / funded.length : Number.NaN, fundedOwners, snapshotComplete),
      largestAccount: fig(funded.length ? Math.max(...funded.map(([, v]) => v)) / USD : Number.NaN, fundedOwners, snapshotComplete),
      inStablecoins: fig(s1 > 0 ? (stableUsd / s1) * 100 : Number.NaN, stableOwners, splitComplete),
    },
    distributions: {
      byToken: split(tokenUsd, tokenOwners, splitComplete),
      byChain: split(chainUsd, chainOwners, snapshotComplete),
      byPlace: split(placeUsd, placeOwners, splitComplete),
    },
    apr: {
      all: aprAll,
      ...(chainsWithAccounts.has(BASE) ? { base: aprDays(BASE) } : {}),
      ...(chainsWithAccounts.has(MONAD) ? { monad: aprDays(MONAD) } : {}),
    },
    earnedPerDay: allDays.map((d): GuardEarnedDay => ({ day: d.day, usd: d.earned, collectedUsd: d.collected, owners: d.earners, complete: d.complete })),
    // T3 is the value at each day's close: today has no close yet and is left out (S1 is the figure for now).
    totalDeposits: allDays.filter((d) => d.day !== today).map((d): GuardDepositsDay => ({ day: d.day, usd: d.deposits, owners: d.holders, complete: d.complete })),
  }
}
