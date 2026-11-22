// otto/mamoru#413 (spec 012 savings-layer.md): the savings layer of each account, as the operator's books serve it on
// the Base snapshot (SafeWire.savings), stored once per account, chain and UTC day (the day's last read wins). Savings
// are a part of the account's idle and vault values, never added to them: this table is only read to show them.

import type { AccountSavings } from '@mamoru/domain'
import type { Db } from './env.ts'
import { dayOf, resolveAccount, type SnapshotWire } from './yield-ledger.ts'

const isAmount = (s: unknown): s is string => typeof s === 'string' && /^\d{1,30}$/.test(s)

/** A wire figure written only when every amount is a plain non-negative integer: an odd one is skipped, never stored half. */
function valid(s: AccountSavings | undefined): s is AccountSavings {
  if (!s || !isAmount(s.usdc) || !isAmount(s.basisUsdc) || !isAmount(s.pendingUsdc)) return false
  if (s.status !== 'counted' && s.status !== 'partial') return false
  return Array.isArray(s.vaults) && s.vaults.every((v) => typeof v.vault === 'string' && isAmount(v.shares) && isAmount(v.usdc) && isAmount(v.basisUsdc))
}

/** Writes every Safe's savings of the snapshot; returns how many rows. Safes without the field (no books) are skipped. */
export async function writeSavings(db: Db, snapshot: SnapshotWire, now: Date): Promise<number> {
  const day = dayOf(snapshot.readAt)
  let written = 0
  for (const safe of snapshot.safes) {
    if (!valid(safe.savings)) continue
    const account = await resolveAccount(db, snapshot.chainId, safe.safe)
    if (!account) continue
    const s = safe.savings
    await db
      .prepare(
        `INSERT INTO account_savings_daily (day, chain_id, account_key, env, usdc, basis_usdc, pending_usdc, status, vaults_json, block, read_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_key, chain_id, day) DO UPDATE SET env = excluded.env, usdc = excluded.usdc, basis_usdc = excluded.basis_usdc,
           pending_usdc = excluded.pending_usdc, status = excluded.status, vaults_json = excluded.vaults_json, block = excluded.block,
           read_at = excluded.read_at, updated_at = excluded.updated_at
         WHERE excluded.block >= account_savings_daily.block`,
      )
      .bind(day, snapshot.chainId, account.accountKey, account.env, Number(s.usdc), Number(s.basisUsdc), Number(s.pendingUsdc), s.status, JSON.stringify(s.vaults), Number(snapshot.block), snapshot.readAt, now.toISOString())
      .run()
    written++
  }
  return written
}
