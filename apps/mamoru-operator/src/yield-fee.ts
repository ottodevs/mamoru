// otto/mamoru#371: Mamoru's yield fee. Ot, 4 Nov 2026: Mamoru keeps 10 % of the yield it collects for an account, paid
// for now to the operator's relayer (it pays the gas); a better destination comes after testing.
//
// The session policies let the engine pay no one but the account itself (MamoruActionPolicyV3/V4: every recipient is
// the Safe), so the fee is never taken by the engine. It is collected in the owner's next withdrawal: one more USDC
// transfer in the batch the owner signs, named on its own line of the summary, like the Safe-paid network fee.
//
// What it is owed on: the fees the receipts say this account's ops collected (yield-receipts.ts facts, every op, engine
// or owner), priced in USDC, since the account entered the fee's scope (never before YIELD_FEE_FROM): nothing
// collected before the fee existed, or while the account was out of scope, is charged. Fees are what Collect paid above
// the principal a DecreaseLiquidity of the same transaction freed (yield-receipts.ts). An
// unpriced fee is not owed yet (it is once a snapshot prices it). What was already charged: the fee of every withdrawal
// confirmed or on its way (one in flight counts, so two withdrawals never charge the same yield twice).

import type { StoredOp } from './state.ts'

/** 10 % of the yield, in basis points. */
export const YIELD_FEE_BPS = 1_000n
/** The fee counts yield collected from here on (UTC), never earlier. */
export const YIELD_FEE_FROM = '2026-11-05T00:00:00.000Z'
/** Below this (raw USDC, 0.01) nothing is charged: a transfer line for a fraction of a cent is noise. */
export const YIELD_FEE_MIN = 10_000n

export type YieldFee = {
  /** USDC (raw) the account's ops collected since YIELD_FEE_FROM, priced fees only. */
  collectedUsdc: bigint
  /** Collected fees not priced yet: owed once priced. */
  unpriced: number
  /** YIELD_FEE_BPS of collectedUsdc, rounded down. */
  feeUsdc: bigint
  /** Fees of withdrawals that did not fail (confirmed or in flight). */
  chargedUsdc: bigint
  /** What the next withdrawal pays: feeUsdc − chargedUsdc, never below zero; 0 under YIELD_FEE_MIN. */
  owedUsdc: bigint
}

/**
 * A withdrawal whose fee counts as paid: confirmed, or on its way (submitted, or created with a transaction sent). A
 * withdrawal op exists only once the owner signed it (submit); one that failed, or never left, pays nothing.
 */
function charged(op: StoredOp): boolean {
  return op.state === 'confirmed' || op.state === 'submitted' || (op.state === 'proposed' && !!op.txHash)
}

/** The later of the fee's start and the account's own start in scope (AccountState.yieldFeeFrom). */
export function feeFrom(accountFrom: string | undefined): string {
  return accountFrom && Date.parse(accountFrom) > Date.parse(YIELD_FEE_FROM) ? accountFrom : YIELD_FEE_FROM
}

export function yieldFee(ops: readonly StoredOp[], bps: bigint = YIELD_FEE_BPS, from: string = YIELD_FEE_FROM): YieldFee {
  const since = Date.parse(from)
  let collectedUsdc = 0n
  let unpriced = 0
  let chargedUsdc = 0n
  for (const op of ops) {
    if (op.facts && Date.parse(op.facts.at) >= since) {
      for (const f of op.facts.fees) {
        if (f.usdc === undefined) unpriced++
        else collectedUsdc += BigInt(f.usdc)
      }
    }
    if (op.kind === 'transfer' && op.feeUsdc && charged(op)) chargedUsdc += BigInt(op.feeUsdc)
  }
  const feeUsdc = (collectedUsdc * bps) / 10_000n
  const left = feeUsdc > chargedUsdc ? feeUsdc - chargedUsdc : 0n
  return { collectedUsdc, unpriced, feeUsdc, chargedUsdc, owedUsdc: left >= YIELD_FEE_MIN ? left : 0n }
}
