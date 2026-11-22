// otto/mamoru#380: the operator's external USDC flows (deposits in, owner withdrawals out) into `account_flows`, one
// row per flow id, written once. Pure D1 writes over the snapshot the cron already pulled; the reader is
// value-series.ts (net deposited).
import type { Db } from './env.ts'

export type FlowWire = { id: string; t: number; kind: 'in' | 'out'; usdc: string }
type Resolve = (chainId: number, address: string) => Promise<{ accountKey: string } | null>

const INSERT = 'INSERT INTO account_flows (chain_id, account_key, flow_id, kind, t_s, usd, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING'

/** Writes every flow of the snapshot's receipts for the accounts this Worker knows. Returns the flows offered (not the new rows). */
export async function writeFlows(db: Db, snapshot: { chainId: number; receipts?: { safe: string; flows?: FlowWire[] }[] }, now: Date, resolve: Resolve): Promise<number> {
  let offered = 0
  const at = now.toISOString()
  for (const r of snapshot.receipts ?? []) {
    if (!r.flows?.length) continue
    const account = await resolve(snapshot.chainId, r.safe.toLowerCase())
    if (!account) continue
    const stmts = r.flows
      .filter((f) => (f.kind === 'in' || f.kind === 'out') && Number.isFinite(f.t) && /^\d+$/.test(f.usdc) && BigInt(f.usdc) > 0n)
      .map((f) => db.prepare(INSERT).bind(snapshot.chainId, account.accountKey, f.id, f.kind, Math.floor(f.t), Number(f.usdc), at))
    offered += stmts.length
    if (stmts.length) await db.batch(stmts)
  }
  return offered
}
