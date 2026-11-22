// otto/mamoru#380: the external USDC flows of an account, so the Portfolio can draw net deposited (USDC sent minus
// withdrawn) as the baseline of "vs idle USDC". Nothing new is read from the chain: a deposit is a row the deposit
// look already keeps (deposits.ts, `AccountState.deposits`), a withdrawal is a confirmed owner transfer op. Both ride
// on the snapshot's `receipts` (yield-receipts.ts) and the Worker writes them into `account_flows`.
//
// Counted: USDC sent to the Safe from outside Mamoru (in), the USDC value of a confirmed owner transfer (out). Not
// counted: moves between the owner's own Safes (CCTP legs, bridges), the yield fee a transfer pays on top
// vault and pool moves.
// A withdrawal is out for what left the Safe to the owner AND to Mamoru as its fee (`amountUsdc + feeUsdc`): the fee is
// not a gain, and the reader subtracts the whole fee owed from the net once (vs-idle.ts), so a fee already paid must not
// stay inside the net deposited or it would be taken twice.
import { DEPOSITS_KEPT, type DepositRow } from './deposits.ts'
import type { StoredOp } from './state.ts'
import { gaveUp, needsFacts } from './yield-receipts.ts'

/**
 * `id` is stable across snapshots (the Worker keeps one row per id); `t` is unix seconds; `usdc` raw USDC (6 decimals).
 * `gap` is not money: the operator says it cannot vouch for the flows (usdc '0'), so the Worker marks the net deposited
 * partial instead of showing a baseline that may be short. `cover` (usdc '0') would be the operator vouching that its
 * flows are gap-free from `t` on; it is never emitted yet (otto/mamoru#438), so the net deposited stays partial.
 */
export type FlowWire = { id: string; t: number; kind: 'in' | 'out' | 'gap' | 'cover'; usdc: string }

const seconds = (iso: string): number | null => {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

/**
 * The account's flows, oldest first. A row that cannot be dated or has no positive amount is left out.
 * - A deposit is dated by its block (deposits.ts `at`).
 * - A withdrawal is dated by the block of its receipt (`facts.at`, yield-receipts.ts), never by when the operator
 *   reconciled it: one mined before midnight and reconciled after would otherwise move the next day's baseline. Until
 *   its receipt facts are read it is not emitted (the next snapshot has it); a receipt given up on, or a confirmed
 *   withdrawal with no transaction, is a `gap`.
 * - A deposit list at its cap (DEPOSITS_KEPT) may have dropped a new, smaller deposit before any snapshot carried it: `gap`.
 */
export function accountFlows(deposits: readonly DepositRow[] | undefined, ops: readonly StoredOp[], nowS: number = Math.floor(Date.now() / 1000)): FlowWire[] {
  const byId = new Map<string, FlowWire>()
  for (const d of deposits ?? []) {
    const t = seconds(d.at)
    if (t === null || !/^\d+$/.test(d.amountUsdc) || BigInt(d.amountUsdc) <= 0n) continue
    const id = `in:${d.txHash.toLowerCase()}:${d.logIndex}`
    if (!byId.has(id)) byId.set(id, { id, t, kind: 'in', usdc: d.amountUsdc })
  }
  if ((deposits?.length ?? 0) >= DEPOSITS_KEPT) byId.set('gap:deposits-cap', { id: 'gap:deposits-cap', t: nowS, kind: 'gap', usdc: '0' })
  for (const op of ops) {
    if (op.kind !== 'transfer' || op.state !== 'confirmed' || !op.opId.startsWith('own-') || !op.amountUsdc || !/^\d+$/.test(op.amountUsdc) || BigInt(op.amountUsdc) <= 0n) continue
    const at = op.txHash && op.facts?.txHash?.toLowerCase() === op.txHash.toLowerCase() ? op.facts.at : undefined
    const t = at === undefined ? null : seconds(at)
    if (t === null) {
      if (!op.txHash || gaveUp(op)) byId.set(`gap:${op.opId}`, { id: `gap:${op.opId}`, t: nowS, kind: 'gap', usdc: '0' })
      else if (!needsFacts(op)) byId.set(`gap:${op.opId}`, { id: `gap:${op.opId}`, t: nowS, kind: 'gap', usdc: '0' })
      continue
    }
    const id = `out:${op.txHash!.toLowerCase()}:${op.opId}`
    const fee = op.feeUsdc && /^\d+$/.test(op.feeUsdc) ? BigInt(op.feeUsdc) : 0n
    if (!byId.has(id)) byId.set(id, { id, t, kind: 'out', usdc: (BigInt(op.amountUsdc) + fee).toString() })
  }
  return [...byId.values()].sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1))
}
