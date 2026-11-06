// Income as events (spec 012 HRV-R5, R9; otto/mamoru#107), written by the same cron pull as the yield ledger
// (yield-ledger.ts) into yield_ledger_income and yield_ledger_vault_samples (migrations/d1/XXXX_income_events.sql).
// earned.ts reads them for "earned so far" and for Stats. Three kinds of rows:
// - fee events, one per Uniswap Collect, from the operator's receipt facts (`receipts[].events`): never overwritten,
//   a later pull only fills a usd that was not priced yet;
// - vault yield, per vault and pull: what the shares the account's own flows explain earned since the previous
//   sample, split at every flow in between (vaultYield);
// - backfill: the collected fees of a day the per-event detail does not cover yet (recomputed every pull, so it
//   shrinks to 0 once the operator has re-read that day's receipts), and the first sample of a vault.
import type { Db } from './env.ts'
import type { SnapshotWire } from './yield-ledger.ts'

export type IncomeEventWire = { id: string; t: number; source: 'harvest' | 're-range'; usdc?: string }
export type VaultFlowWire = { vault: string; kind: 'deposit' | 'withdraw'; assets: string; shares: string; logIndex: number; id: string; t: number }
export type AccountVaultWire = { flows: VaultFlowWire[]; explained: Record<string, string> | null }

const ONE = 10n ** 18n

/** Assets per share, scaled by 1e18. Null when there are no shares to divide by. */
const ppsOf = (assets: bigint, shares: bigint): bigint | null => (shares > 0n ? (assets * ONE) / shares : null)

export type VaultPoint = { t: number; shares: bigint; value: bigint; explained: bigint | null }

/**
 * What the explained shares earned over (prev.t, now.t]: the interval is split at each flow of this vault inside it,
 * each flow giving its own assets per share, and every segment counts the explained shares held during it times the
 * change in assets per share. Shares outside the explained ones never enter. Null when the previous sample's explained
 * shares are unknown. Raw USDC, may be negative (a share price that fell).
 */
export function vaultYield(prev: VaultPoint, now: VaultPoint, flows: readonly VaultFlowWire[]): bigint | null {
  if (prev.explained === null) return null
  let e = prev.explained
  let pps = ppsOf(prev.value, prev.shares)
  let usd = 0n
  const inside = flows.filter((f) => f.t > prev.t && f.t <= now.t).sort((a, b) => a.t - b.t || a.logIndex - b.logIndex)
  for (const f of inside) {
    const at = ppsOf(BigInt(f.assets), BigInt(f.shares))
    if (at !== null) {
      if (pps !== null) usd += (e * (at - pps)) / ONE
      pps = at
    }
    e += f.kind === 'deposit' ? BigInt(f.shares) : -BigInt(f.shares)
    if (e < 0n) e = 0n
  }
  const end = ppsOf(now.value, now.shares)
  if (end !== null && pps !== null) usd += (e * (end - pps)) / ONE
  return usd
}

/** Explained shares cover the whole holding, to the wei. */
export const isExplained = (shares: bigint, explained: bigint | null): boolean => explained !== null && (explained - shares <= 1n && shares - explained <= 1n)

type Account = { accountKey: string; env: 'prod' | 'beta' | 'test' | 'unknown' }
type Resolve = (chainId: number, address: string) => Promise<Account | null>
type SampleRow = { vault: string; t_s: number; shares: string; value_usdc: number; explained_shares: string | null }

const UPSERT_EVENT = `INSERT INTO yield_ledger_income (event_id, chain_id, account_key, env, source, t_s, from_s, usd, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(event_id) DO UPDATE SET usd = COALESCE(yield_ledger_income.usd, excluded.usd), env = excluded.env, updated_at = excluded.updated_at`

/**
 * Writes one pull's income rows. Fee events already stored with a price are skipped (one read per chain), so a pull
 * writes only what is new or newly priced. Vault samples are written for safes this snapshot read; a vault the
 * previous sample held and this one does not gets a zero sample, so the yield up to its last withdrawal is counted.
 */
export async function writeIncome(db: Db, snapshot: SnapshotWire & { receipts?: { safe: string; events?: IncomeEventWire[]; vault?: AccountVaultWire }[] }, now: Date, resolve: Resolve): Promise<{ events: number; samples: number }> {
  const t = Math.floor(Date.parse(snapshot.readAt) / 1000)
  if (!Number.isFinite(t)) return { events: 0, samples: 0 }
  const chainId = snapshot.chainId
  const at = now.toISOString()
  const known = new Set(
    (await db.prepare("SELECT event_id FROM yield_ledger_income WHERE chain_id = ? AND usd IS NOT NULL AND source IN ('harvest', 're-range')").bind(chainId).all<{ event_id: string }>()).results.map((r) => r.event_id),
  )
  const receipts = new Map((snapshot.receipts ?? []).map((r) => [r.safe.toLowerCase(), r]))
  const safes = new Set([...snapshot.safes.map((s) => s.safe.toLowerCase()), ...receipts.keys()])
  let events = 0
  let samples = 0
  for (const address of safes) {
    const account = await resolve(chainId, address)
    if (!account) continue
    const r = receipts.get(address)
    const stmts = []
    for (const ev of r?.events ?? []) {
      if (known.has(ev.id)) continue
      stmts.push(db.prepare(UPSERT_EVENT).bind(ev.id, chainId, account.accountKey, account.env, ev.source, ev.t, null, ev.usdc === undefined ? null : Number(ev.usdc), at))
      events++
    }
    const safe = snapshot.safes.find((s) => s.safe.toLowerCase() === address)
    if (safe) {
      const prevRows = (
        await db
          .prepare(
            `SELECT s.vault, s.t_s, s.shares, s.value_usdc, s.explained_shares FROM yield_ledger_vault_samples s
             WHERE s.chain_id = ? AND s.account_key = ? AND s.t_s = (SELECT MAX(x.t_s) FROM yield_ledger_vault_samples x WHERE x.chain_id = s.chain_id AND x.account_key = s.account_key AND x.vault = s.vault)`,
          )
          .bind(chainId, account.accountKey)
          .all<SampleRow>()
      ).results
      const held = new Map((safe.vaults ?? []).map((v) => [v.name, v]))
      const names = new Set([...held.keys(), ...prevRows.filter((p) => BigInt(p.shares) > 0n).map((p) => p.vault)])
      for (const vault of names) {
        const prev = prevRows.find((p) => p.vault === vault)
        if (prev && prev.t_s >= t) continue
        const cur = held.get(vault)
        const shares = BigInt(cur?.shares ?? '0')
        const value = BigInt(cur?.valueUsdc ?? '0')
        // No vault wire at all: the operator has no flow and no receipt waiting, so nothing is explained.
        const e = r?.vault ? (r.vault.explained === null ? null : BigInt(r.vault.explained[vault] ?? '0')) : 0n
        stmts.push(
          db
            .prepare('INSERT INTO yield_ledger_vault_samples (chain_id, account_key, vault, t_s, shares, value_usdc, explained_shares, explained) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
            .bind(chainId, account.accountKey, vault, t, shares.toString(), Number(value), e === null ? null : e.toString(), isExplained(shares, e) ? 1 : 0),
        )
        samples++
        const flows = (r?.vault?.flows ?? []).filter((f) => f.vault === vault)
        if (prev) {
          const usd = vaultYield({ t: prev.t_s, shares: BigInt(prev.shares), value: BigInt(prev.value_usdc), explained: prev.explained_shares === null ? null : BigInt(prev.explained_shares) }, { t, shares, value, explained: e }, flows)
          stmts.push(db.prepare(UPSERT_EVENT).bind(`vault:${chainId}:${account.accountKey}:${vault}:${t}`, chainId, account.accountKey, account.env, 'vault-yield', t, prev.t_s, usd === null ? null : Number(usd), at))
        } else if (shares > 0n) {
          // First sample: what the explained shares are worth now minus what the flows put in (net of what came out).
          const pps = ppsOf(value, shares)!
          const net = flows.filter((f) => f.t <= t).reduce((n, f) => n + (f.kind === 'deposit' ? BigInt(f.assets) : -BigInt(f.assets)), 0n)
          const usd = e === null || e === 0n ? null : (e * pps) / ONE - net
          stmts.push(db.prepare(UPSERT_EVENT).bind(`vault-backfill:${chainId}:${account.accountKey}:${vault}`, chainId, account.accountKey, account.env, 'backfill', t, null, usd === null ? null : Number(usd), at))
        }
      }
    }
    if (stmts.length) await db.batch(stmts)
  }
  await writeDayBackfill(db, chainId, at)
  return { events, samples }
}

/**
 * The collected fees a day's receipts hold above that day's fee events, as one 'backfill' row per account and day:
 * fees collected before the operator kept per-collect detail keep counting in "earned so far". Recomputed every pull
 * from both tables (an upsert of the difference), and skipped for a day with an unpriced event, so it is never
 * counted twice and drops to 0 once the events cover the day.
 */
export async function writeDayBackfill(db: Db, chainId: number, at: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO yield_ledger_income (event_id, chain_id, account_key, env, source, t_s, from_s, usd, updated_at)
       SELECT 'backfill:' || r.chain_id || ':' || r.account_key || ':' || r.day, r.chain_id, r.account_key, r.env, 'backfill',
              CAST(strftime('%s', r.day) AS INTEGER), NULL,
              MAX(0, r.collected_usdc - COALESCE((SELECT SUM(i.usd) FROM yield_ledger_income i
                WHERE i.chain_id = r.chain_id AND i.account_key = r.account_key AND i.source IN ('harvest', 're-range')
                  AND i.t_s >= CAST(strftime('%s', r.day) AS INTEGER) AND i.t_s < CAST(strftime('%s', r.day) AS INTEGER) + 86400), 0)),
              ?
       FROM yield_ledger_account_receipts r
       WHERE r.chain_id = ? AND r.collected_usdc IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM yield_ledger_income u WHERE u.chain_id = r.chain_id AND u.account_key = r.account_key
           AND u.source IN ('harvest', 're-range') AND u.usd IS NULL
           AND u.t_s >= CAST(strftime('%s', r.day) AS INTEGER) AND u.t_s < CAST(strftime('%s', r.day) AS INTEGER) + 86400)
       ON CONFLICT(event_id) DO UPDATE SET usd = excluded.usd, env = excluded.env, updated_at = excluded.updated_at`,
    )
    .bind(at, chainId)
    .run()
}
