// otto/mamoru#380: the external USDC flows of an account, so the Portfolio can draw net deposited (USDC sent minus
// withdrawn) as the baseline of "vs idle USDC". Nothing new is read from the chain: a deposit is a row the deposit
// look already keeps (deposits.ts, `AccountState.deposits`), a withdrawal is a confirmed owner transfer op. Both ride
// on the snapshot's `receipts` (yield-receipts.ts) and the Worker writes them into `account_flows`.
//
// Counted: USDC sent to the Safe from outside Mamoru (in), the USDC value of a confirmed owner transfer (out). Not
// counted: moves between the owner's own Safes (CCTP legs, bridges), the yield fee a transfer pays on top
// (`feeUsdc`: it is Mamoru's fee, a line of its own), vault and pool moves.
import type { DepositRow } from './deposits.ts'
import type { StoredOp } from './state.ts'

/** `id` is stable across snapshots (the Worker keeps one row per id); `t` is unix seconds; `usdc` raw USDC (6 decimals). */
export type FlowWire = { id: string; t: number; kind: 'in' | 'out'; usdc: string }

const seconds = (iso: string): number | null => {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

/** The account's flows, oldest first. A row that cannot be dated or has no positive amount is left out. */
export function accountFlows(deposits: readonly DepositRow[] | undefined, ops: readonly StoredOp[]): FlowWire[] {
  const byId = new Map<string, FlowWire>()
  for (const d of deposits ?? []) {
    const t = seconds(d.at)
    if (t === null || !/^\d+$/.test(d.amountUsdc) || BigInt(d.amountUsdc) <= 0n) continue
    const id = `in:${d.txHash.toLowerCase()}:${d.logIndex}`
    if (!byId.has(id)) byId.set(id, { id, t, kind: 'in', usdc: d.amountUsdc })
  }
  for (const op of ops) {
    if (op.kind !== 'transfer' || op.state !== 'confirmed' || !op.opId.startsWith('own-') || !op.amountUsdc || !/^\d+$/.test(op.amountUsdc) || BigInt(op.amountUsdc) <= 0n) continue
    const t = seconds(op.updatedAt)
    if (t === null) continue
    const id = `out:${(op.txHash ?? op.opId).toLowerCase()}`
    if (!byId.has(id)) byId.set(id, { id, t, kind: 'out', usdc: op.amountUsdc })
  }
  return [...byId.values()].sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1))
}
