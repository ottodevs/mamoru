// Yield ledger writer (otto/mamoru#129), built on the snapshot loop (#136). The operator has no D1 binding
// (specs/003-snapshot-loop/spec.md), so this Worker pulls GET /snapshot through the same signed path /metrics
// uses and upserts account_snapshot_latest, account_daily (#136) and the position-level yield tables (#129).
// Behind the `yield_ledger` ops flag (D1, set from /ops; apps/mamoru-app/src/worker.ts `scheduled`, off by default).
import { metricsSignature } from '@mamoru/operator-auth'
import type { Db } from './env.ts'

export type OperatorFetch = (input: string, init: RequestInit) => Promise<Response>

export type PoolWire = { sqrtPriceX96: string; tick: number; feeGrowthGlobal0X128: string; feeGrowthGlobal1X128: string }
export type PositionWire = {
  tokenId: string
  pool: string
  token0: string
  token1: string
  liquidity: string
  tickLower: number
  tickUpper: number
  inRange: boolean
  amount0: string
  amount1: string
  accrued0: string
  accrued1: string
  owed0: string
  owed1: string
  collectable0: string
  collectable1: string
  valueUsdc: string
  feesUsdc: string
  owedUsdc: string
  /**
   * otto/mamoru#129: present only when the operator's snapshot loop is running with the yield wrapper
   * (yield-entries.ts, gated by the `yield_ledger` ops flag), and only on a tick where the position's pool was
   * priceable. `entryAmount0/1/Block/Day` are the exact baseline
   * `holdValueUsdc` was computed from: all four travel together with it, and a writer must store these, not a
   * position's current amount0/amount1, into yield_ledger_position_entry (code-review finding, PR #43).
   */
  holdValueUsdc?: string
  entryAmount0?: string
  entryAmount1?: string
  entryBlock?: number
  entryDay?: string
}
export type SafeWire = {
  accountKey: string
  safe: string
  active: boolean
  armed: boolean
  deployed: boolean
  eth: string
  tokens: Record<string, string>
  positions: PositionWire[]
  idleUsdc: string
  lpUsdc: string
  feesUsdc: string
  owedUsdc: string
  totalUsdc: string
}
/** One UTC day's full totals, not a delta: writing them again is a no-op. `collectedUsdc` is absent while a fee of that day is unpriced. */
export type DayReceiptWire = {
  day: string
  gasWei: string
  collectedUsdc?: string
  positions: { tokenId: string; collected0: string; collected1: string; collectedUsdc?: string }[]
}
export type SnapshotWire = {
  chainId: number
  block: string
  readAt: string
  pools: Record<string, PoolWire>
  safes: SafeWire[]
  calls: number
  lastError: string | null
  /**
   * otto/mamoru#129: gas and collected fees of every stored account's engine ops per UTC day (operator
   * yield-receipts.ts), the last few days only, including accounts the snapshot did not read (stopped). Absent from
   * an operator older than this field.
   */
  receipts?: { safe: string; days: DayReceiptWire[] }[]
}

export const SNAPSHOT_TIMEOUT_MS = 30_000

/**
 * Pulls the operator's latest snapshot, signed like GET /metrics (one HMAC, no account context: this reads
 * every account at once, nothing an owner session scopes). Null, never a thrown error, when the operator has
 * the loop off (404), has not read one yet (503), or is unreachable: the caller's cron tries again next time.
 */
export async function fetchSnapshot(operatorUrl: string, operatorSecret: string, fetcher: OperatorFetch): Promise<SnapshotWire | null> {
  const path = '/snapshot'
  const minute = Math.floor(Date.now() / 60_000)
  const sig = await metricsSignature(operatorSecret, 'GET', path, minute)
  try {
    const res = await fetcher(operatorUrl.replace(/\/+$/, '') + path, {
      method: 'GET',
      headers: { 'x-mamoru-sig': sig, accept: 'application/json' },
      signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
    })
    if (res.status !== 200) return null
    return (await res.json()) as SnapshotWire
  } catch (e) {
    console.error('yield-ledger: snapshot unreachable', e instanceof Error ? e.message : String(e))
    return null
  }
}

export const dayOf = (iso: string): string => iso.slice(0, 10)

/** The account_key of (chainId, address) from this Worker's own accounts table, or null if none owns it. */
type LedgerEnv = 'prod' | 'beta' | 'test' | 'unknown'
type ResolvedAccount = { accountKey: string; env: LedgerEnv }

/**
 * The account behind a Safe and the environment its ledger rows carry (otto/mamoru#130's accounts.env and
 * is_test): a test account is 'test' whatever host created it, so /ops keeps it out of prod numbers. Before
 * migration 0007 (no env/is_test columns) every row stays 'unknown', as before.
 */
async function resolveAccount(db: Db, chainId: number, address: string): Promise<ResolvedAccount | null> {
  try {
    const row = await db.prepare('SELECT account_key, env, is_test FROM accounts WHERE chain_id = ? AND LOWER(address) = LOWER(?)').bind(chainId, address.toLowerCase()).first<{ account_key: string; env: string | null; is_test: number | null }>()
    if (!row) return null
    const env: LedgerEnv = row.is_test === 1 ? 'test' : row.env === 'prod' || row.env === 'beta' ? row.env : 'unknown'
    return { accountKey: row.account_key, env }
  } catch (e) {
    if (!/no such column/i.test(e instanceof Error ? e.message : String(e))) throw e
    const row = await db.prepare('SELECT account_key FROM accounts WHERE chain_id = ? AND LOWER(address) = LOWER(?)').bind(chainId, address.toLowerCase()).first<{ account_key: string }>()
    return row ? { accountKey: row.account_key, env: 'unknown' } : null
  }
}

/** Cumulative totals for the whole UTC day this call's snapshot falls on, not one tx's delta: COALESCE on a later call with none keeps the running total, so a caller that passed only one harvest's amount would silently drop every earlier one on the same day once a call without a receipt follows it. */
export type AccountReceipt = { collectedUsd?: number; gasWei?: string }

/**
 * Upserts account_snapshot_latest (always current) and account_daily (open = first call of the UTC day, close =
 * every call) for every safe the snapshot carries, resolving each one's account_key from this Worker's own
 * `accounts` table by address (the operator truncates accountKey to 8 characters on the wire; address is not
 * truncated and is the join key `accounts` already has, migrations/0001_sprint.sql's accounts_chain_address).
 * `env` comes from the account (resolveAccount); an upsert also refreshes it, so a row written before an account
 * got its environment is corrected on the next pull.
 * `receipts`, keyed by account_key, carries collected_usdc/gas_paid_wei when a caller already knows them. The cron
 * fills those columns with writeReceipts instead, from the operator's per-day totals on the snapshot.
 * Returns how many safes were written and how many had no matching account (not written, not an error).
 */
export async function writeAccountSnapshot(db: Db, snapshot: SnapshotWire, now: Date, receipts: Map<string, AccountReceipt> = new Map()): Promise<{ written: number; unmatched: number }> {
  const day = dayOf(snapshot.readAt)
  let written = 0
  let unmatched = 0
  for (const safe of snapshot.safes) {
    const account = await resolveAccount(db, snapshot.chainId, safe.safe)
    if (!account) {
      unmatched++
      continue
    }
    const { accountKey, env } = account
    const address = safe.safe.toLowerCase()
    const positionsJson = JSON.stringify(safe.positions.map((p) => ({ tokenId: p.tokenId, pool: p.pool, inRange: p.inRange, valueUsdc: p.valueUsdc, accrued0: p.accrued0, accrued1: p.accrued1, owed0: p.owed0, owed1: p.owed1, feesUsdc: p.feesUsdc, owedUsdc: p.owedUsdc })))
    await db
      .prepare(
        `INSERT INTO account_snapshot_latest (chain_id, address, account_key, env, block, read_at, deployed, idle_usdc, lp_usdc, fees_usdc, owed_usdc, total_usdc, positions_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chain_id, address) DO UPDATE SET
           account_key = excluded.account_key, env = excluded.env, block = excluded.block, read_at = excluded.read_at, deployed = excluded.deployed,
           idle_usdc = excluded.idle_usdc, lp_usdc = excluded.lp_usdc, fees_usdc = excluded.fees_usdc, owed_usdc = excluded.owed_usdc,
           total_usdc = excluded.total_usdc, positions_json = excluded.positions_json, updated_at = excluded.updated_at`,
      )
      .bind(snapshot.chainId, address, accountKey, env, Number(snapshot.block), snapshot.readAt, safe.deployed ? 1 : 0, Number(safe.idleUsdc), Number(safe.lpUsdc), Number(safe.feesUsdc), Number(safe.owedUsdc), Number(safe.totalUsdc), positionsJson, now.toISOString())
      .run()

    const receipt = receipts.get(accountKey)
    await db
      .prepare(
        `INSERT INTO account_daily (day, chain_id, address, account_key, env, block_open, block_close, total_open_usdc, total_close_usdc, idle_close_usdc, lp_close_usdc, fees_open_usdc, fees_close_usdc, collected_usdc, gas_paid_wei)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day, chain_id, address) DO UPDATE SET
           env = excluded.env, block_close = excluded.block_close, total_close_usdc = excluded.total_close_usdc, idle_close_usdc = excluded.idle_close_usdc,
           lp_close_usdc = excluded.lp_close_usdc, fees_close_usdc = excluded.fees_close_usdc,
           collected_usdc = COALESCE(excluded.collected_usdc, account_daily.collected_usdc),
           gas_paid_wei = COALESCE(excluded.gas_paid_wei, account_daily.gas_paid_wei)`,
      )
      .bind(day, snapshot.chainId, address, accountKey, env, Number(snapshot.block), Number(snapshot.block), Number(safe.totalUsdc), Number(safe.totalUsdc), Number(safe.idleUsdc), Number(safe.lpUsdc), Number(safe.feesUsdc), Number(safe.feesUsdc), receipt?.collectedUsd ?? null, receipt?.gasWei ?? null)
      .run()
    written++
  }
  return { written, unmatched }
}

/** 10% of collected_usd, readiness for otto/mamoru#108: stored so it can decide with real numbers, never charged by this writer or anything that reads it. */
export const FEE_ON_YIELD_BPS = 1_000
export function feeReadinessUsd(collectedUsd: number | null | undefined): number | null {
  return collectedUsd == null ? null : Math.round((collectedUsd * FEE_ON_YIELD_BPS) / 10_000)
}

/** Same cumulative-day-total contract as AccountReceipt, per position. */
export type PositionReceipt = { collectedUsd?: number; collected0?: string; collected1?: string }

/**
 * Upserts yield_ledger_position_entry (once per token id) and yield_ledger_position_daily (open on the day's
 * first call, close on every call) for every position whose `holdValueUsdc` the operator computed (the same
 * `yield_ledger` flag turns that on there too; a position without it is skipped, counted, never written with a
 * guessed baseline). `receipts`, keyed by token id, carries collected amounts the same way writeAccountSnapshot's do;
 * the cron fills them with writeReceipts.
 */
export async function writeYieldLedger(db: Db, snapshot: SnapshotWire, now: Date, receipts: Map<string, PositionReceipt> = new Map()): Promise<{ written: number; skipped: number }> {
  const day = dayOf(snapshot.readAt)
  let written = 0
  let skipped = 0
  for (const safe of snapshot.safes) {
    const account = await resolveAccount(db, snapshot.chainId, safe.safe)
    if (!account) {
      skipped += safe.positions.length
      continue
    }
    const { accountKey, env } = account
    const address = safe.safe.toLowerCase()
    for (const p of safe.positions) {
      // holdValueUsdc and the four entry* fields travel together (yield-entries.ts's withHoldValue); any one
      // missing means the operator could not price this position's baseline on this tick, so none of it is
      // trustworthy. Never fall back to the position's current amount0/amount1 here: that is not the baseline.
      if (p.holdValueUsdc === undefined || p.entryAmount0 === undefined || p.entryAmount1 === undefined || p.entryBlock === undefined || p.entryDay === undefined) {
        skipped++
        continue
      }
      await db
        .prepare(
          `INSERT INTO yield_ledger_position_entry (chain_id, token_id, account_key, address, env, pool, entry_day, entry_block, entry_amount0, entry_amount1, captured_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(chain_id, token_id) DO UPDATE SET env = excluded.env`,
        )
        .bind(snapshot.chainId, Number(p.tokenId), accountKey, address, env, p.pool, p.entryDay, p.entryBlock, p.entryAmount0, p.entryAmount1, now.toISOString())
        .run()

      const receipt = receipts.get(p.tokenId)
      const feeAccruedUsd = feeReadinessUsd(receipt?.collectedUsd)
      await db
        .prepare(
          `INSERT INTO yield_ledger_position_daily (day, chain_id, token_id, account_key, address, env, pool, block_open, block_close, accrued0_open, accrued1_open, accrued_usd_open, accrued0_close, accrued1_close, accrued_usd_close, value_usd, hold_value_usd, collected0, collected1, collected_usd, fee_accrued_usd, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(day, chain_id, token_id) DO UPDATE SET
             env = excluded.env, block_close = excluded.block_close, accrued0_close = excluded.accrued0_close, accrued1_close = excluded.accrued1_close,
             accrued_usd_close = excluded.accrued_usd_close, value_usd = excluded.value_usd, hold_value_usd = excluded.hold_value_usd,
             collected0 = COALESCE(excluded.collected0, yield_ledger_position_daily.collected0),
             collected1 = COALESCE(excluded.collected1, yield_ledger_position_daily.collected1),
             collected_usd = COALESCE(excluded.collected_usd, yield_ledger_position_daily.collected_usd),
             fee_accrued_usd = COALESCE(excluded.fee_accrued_usd, yield_ledger_position_daily.fee_accrued_usd),
             updated_at = excluded.updated_at`,
        )
        .bind(
          day, snapshot.chainId, Number(p.tokenId), accountKey, address, env, p.pool,
          Number(snapshot.block), Number(snapshot.block),
          p.accrued0, p.accrued1, Number(p.feesUsdc),
          p.accrued0, p.accrued1, Number(p.feesUsdc),
          Number(p.valueUsdc), Number(p.holdValueUsdc),
          receipt?.collected0 ?? null, receipt?.collected1 ?? null, receipt?.collectedUsd ?? null, feeAccruedUsd,
          now.toISOString(),
        )
        .run()
      written++
    }
  }
  return { written, skipped }
}

async function digestOf(day: DayReceiptWire): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(day)))
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Writes the operator's per-day receipts (gas paid, fees collected). The operator serves every day it has, every
 * pull; a day is written only when its digest differs from the stored one (migration 0015), so the D1 work per pull
 * is the days that changed, and a day recovered late is still delivered. The totals are absolute, so a rewrite is a
 * no-op; a collected USD figure the operator could not price yet leaves the stored one as it was.
 * - yield_ledger_account_receipts and yield_ledger_position_collected: always written, with or without a snapshot
 *   row for that day (an account stopped right after an op, a position a rerange burned). loadYieldLedger reads these.
 * - account_daily and yield_ledger_position_daily: their collected/gas columns follow when that day's row exists.
 */
export async function writeReceipts(db: Db, snapshot: SnapshotWire, now: Date): Promise<void> {
  if (!snapshot.receipts?.length) return
  const stored = await db.prepare('SELECT address, day, digest FROM yield_ledger_account_receipts WHERE chain_id = ?').bind(snapshot.chainId).all<{ address: string; day: string; digest: string }>()
  const seen = new Map(stored.results.map((r) => [`${r.address}|${r.day}`, r.digest]))
  for (const r of snapshot.receipts) {
    const address = r.safe.toLowerCase()
    const pending: { d: DayReceiptWire; digest: string }[] = []
    for (const d of r.days) {
      const digest = await digestOf(d)
      if (seen.get(`${address}|${d.day}`) !== digest) pending.push({ d, digest })
    }
    if (!pending.length) continue
    const account = await resolveAccount(db, snapshot.chainId, r.safe)
    if (!account) continue
    for (const { d, digest } of pending) {
      const collected = d.collectedUsdc === undefined ? null : Number(d.collectedUsdc)
      await db
        .prepare('UPDATE account_daily SET gas_paid_wei = ?, collected_usdc = COALESCE(?, collected_usdc) WHERE day = ? AND chain_id = ? AND address = ?')
        .bind(d.gasWei, collected, d.day, snapshot.chainId, address)
        .run()
      for (const p of d.positions) {
        const usd = p.collectedUsdc === undefined ? null : Number(p.collectedUsdc)
        await db
          .prepare(
            `INSERT INTO yield_ledger_position_collected (day, chain_id, token_id, account_key, address, env, collected0, collected1, collected_usd, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(day, chain_id, token_id) DO UPDATE SET
               env = excluded.env, collected0 = excluded.collected0, collected1 = excluded.collected1,
               collected_usd = COALESCE(excluded.collected_usd, yield_ledger_position_collected.collected_usd), updated_at = excluded.updated_at`,
          )
          .bind(d.day, snapshot.chainId, Number(p.tokenId), account.accountKey, address, account.env, p.collected0, p.collected1, usd, now.toISOString())
          .run()
        await db
          .prepare(
            `UPDATE yield_ledger_position_daily SET collected0 = ?, collected1 = ?, collected_usd = COALESCE(?, collected_usd), fee_accrued_usd = COALESCE(?, fee_accrued_usd)
             WHERE day = ? AND chain_id = ? AND token_id = ? AND address = ?`,
          )
          .bind(p.collected0, p.collected1, usd, feeReadinessUsd(usd), d.day, snapshot.chainId, Number(p.tokenId), address)
          .run()
      }
      // Last: if a write above failed, the digest is not stored and the day is written again next pull.
      await db
        .prepare(
          `INSERT INTO yield_ledger_account_receipts (day, chain_id, address, account_key, env, gas_paid_wei, collected_usdc, digest, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(day, chain_id, address) DO UPDATE SET
             account_key = excluded.account_key, env = excluded.env, gas_paid_wei = excluded.gas_paid_wei,
             collected_usdc = COALESCE(excluded.collected_usdc, yield_ledger_account_receipts.collected_usdc),
             digest = excluded.digest, updated_at = excluded.updated_at`,
        )
        .bind(d.day, snapshot.chainId, address, account.accountKey, account.env, d.gasWei, collected, digest, now.toISOString())
        .run()
    }
  }
}

/** One cron tick: pull the operator's snapshot and write everything it can. No-op, never throws, when the operator answers nothing (loop off, not reachable, or no read yet). */
export async function pullYieldLedger(db: Db, operatorUrl: string, operatorSecret: string, fetcher: OperatorFetch, now: Date): Promise<{ accounts: number; positions: number } | null> {
  const snapshot = await fetchSnapshot(operatorUrl, operatorSecret, fetcher)
  if (!snapshot) return null
  const accounts = await writeAccountSnapshot(db, snapshot, now)
  const positions = await writeYieldLedger(db, snapshot, now)
  await writeReceipts(db, snapshot, now)
  return { accounts: accounts.written, positions: positions.written }
}
