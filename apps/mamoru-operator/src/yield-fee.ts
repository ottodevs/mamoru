// otto/mamoru#371: Mamoru's yield fee. Ot, 4 Nov 2026: Mamoru keeps 10 % of the yield it collects for an account, paid
// for now to the operator's relayer (it pays the gas); a better destination comes after testing.
//
// The session policies let the engine pay no one but the account itself (MamoruActionPolicyV3/V4: every recipient is
// the Safe), so the fee is never taken by the engine. It is collected in the owner's next withdrawal: one more USDC
// transfer in the batch the owner signs, named on its own line of the summary, like the Safe-paid network fee.
//
// What it is owed on: the fees the receipts say this account's ops collected (yield-receipts.ts facts, every op, engine
// or owner), priced in USDC, at or after YIELD_FEE_FROM, and only facts taken while the account was in the fee's scope
// (`feeable`): nothing collected before the fee existed, or while the account was out of scope, is charged. Fees are what Collect paid above
// the principal a DecreaseLiquidity of the same transaction freed (yield-receipts.ts). An
// unpriced fee is not owed yet (it is once a snapshot prices it). What was already charged: the fee of every withdrawal
// confirmed or on its way (one in flight counts, so two withdrawals never charge the same yield twice).
//
// otto/mamoru#433: the fee also counts what the account's ERC-4626 vault shares grew by with no harvest (yield that
// compounds into principal). Realized yield = collected fees + vault growth; pending, uncollected LP fees stay
// uncharged. See vaultGrowth below for the basis rules.

import type { StoredOp } from './state.ts'
import { distinctFees, FACTS_VERSION, type VaultFlow } from './yield-receipts.ts'

/** 10 % of the yield, in basis points. */
export const YIELD_FEE_BPS = 1_000n
/** The fee counts yield collected from here on (UTC), never earlier. */
export const YIELD_FEE_FROM = '2026-11-05T00:00:00.000Z'
/** Below this (raw USDC, 0.01) nothing is charged: a transfer line for a fraction of a cent is noise. */
export const YIELD_FEE_MIN = 10_000n

export type YieldFee = {
  /** USDC (raw) the account's ops collected since YIELD_FEE_FROM, priced fees only, plus its remote Safes' (#391). */
  collectedUsdc: bigint
  /** otto/mamoru#433: USDC (raw) the account's vault shares grew by since the vault fee started (VaultFeeInput.from); 0 without it. Part of the fee's base. */
  vaultGrowthUsdc: bigint
  /** Collected fees not priced yet: owed once priced. */
  unpriced: number
  /** YIELD_FEE_BPS of collectedUsdc + vaultGrowthUsdc, rounded down. */
  feeUsdc: bigint
  /** Fees of withdrawals that did not fail (confirmed or in flight). */
  chargedUsdc: bigint
  /** What the next withdrawal pays: feeUsdc − chargedUsdc, never below zero; 0 under YIELD_FEE_MIN. */
  owedUsdc: bigint
}

/**
 * A withdrawal whose fee counts as paid: any not failed. A withdrawal op exists only once the owner signed it (submit,
 * Operator.newOp), so a `proposed` one is being sent right now: counting it means a prepare in that window never
 * prices the same fee twice (when in doubt, the owner is not charged).
 */
function charged(op: StoredOp): boolean {
  return op.state !== 'failed'
}

/** otto/mamoru#433: a registry vault as the Safe holds it now (chain.ts VaultHolding): shares and their value in raw USDC. */
export type VaultNow = { name: string; shares: bigint; assets: bigint }

/**
 * otto/mamoru#433: what the vault fee needs. `from` is when the operator started charging vault growth (ISO, stamped once
 * on the first boot that has this code: nothing earlier is ever charged). `now` holds the vaults read at the same block as
 * the withdrawal; a vault absent from it (unreadable) counts only what its redemptions already realized.
 */
export type VaultFeeInput = { from: string; now: readonly VaultNow[] }

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b

/**
 * otto/mamoru#433: growth of the account's vault shares, raw USDC, per vault summed.
 *
 * Cost basis is kept by average cost over the account's own flows (ERC-4626 Deposit/Withdraw of its shares, read from
 * receipts) that were taken while the account was in the fee's scope (`feeable`, every copy of the transaction) and are
 * dated at or after both YIELD_FEE_FROM and `input.from`: a deposit's basis is its assets at entry, so USDC a harvest
 * swept into a vault (already charged when collected) is never charged twice. A redemption realizes
 * assets − the basis of the shares it burns; what is still held is valued at its share price now, less its basis.
 * Per vault the total is realized + unrealized, never below zero, so a loss on a vault is not netted against another's
 * gain and a drop in price never refunds. When in doubt the owner is not charged: shares held before the start have no
 * basis and no growth (a redemption of more shares than tracked realizes nothing on the excess), the held shares cap the
 * tracked ones (a redemption not read yet is never counted as growth), basis rounds up, value rounds down.
 */
export function vaultGrowth(ops: readonly StoredOp[], input: VaultFeeInput): bigint {
  const since = Math.max(Date.parse(YIELD_FEE_FROM), Date.parse(input.from))
  if (!Number.isFinite(since)) return 0n
  // One flow per transaction log (two stored ops can read the same transaction); counted only if every copy was feeable.
  const byId = new Map<string, { flow: VaultFlow; t: number; block: number; feeable: boolean }>()
  for (const op of ops) {
    const f = op.facts
    if (!f?.txHash || (f.v ?? 1) < FACTS_VERSION) continue
    const t = Date.parse(f.at)
    for (const flow of f.vaultFlows ?? []) {
      const id = `${f.txHash.toLowerCase()}:${flow.logIndex}`
      const prev = byId.get(id)
      if (prev) prev.feeable &&= f.feeable === true
      else byId.set(id, { flow, t, block: Number(f.block ?? 0), feeable: f.feeable === true })
    }
  }
  const flows = [...byId.values()].filter((x) => x.feeable && x.t >= since).sort((a, b) => a.t - b.t || a.block - b.block || a.flow.logIndex - b.flow.logIndex)
  const book = new Map<string, { shares: bigint; basis: bigint; realized: bigint }>()
  for (const { flow } of flows) {
    const b = book.get(flow.vault) ?? { shares: 0n, basis: 0n, realized: 0n }
    const shares = BigInt(flow.shares)
    const assets = BigInt(flow.assets)
    if (flow.kind === 'deposit') {
      b.shares += shares
      b.basis += assets
    } else if (b.shares > 0n && shares > 0n) {
      const take = shares < b.shares ? shares : b.shares
      const basis = take === b.shares ? b.basis : ceilDiv(b.basis * take, b.shares)
      b.realized += (assets * take) / shares - basis
      b.shares -= take
      b.basis -= basis
    }
    book.set(flow.vault, b)
  }
  let total = 0n
  for (const [vault, b] of book) {
    let gain = b.realized
    const held = input.now.find((v) => v.name === vault)
    if (held && b.shares > 0n && held.shares > 0n) {
      const tracked = b.shares < held.shares ? b.shares : held.shares
      const basis = tracked === b.shares ? b.basis : ceilDiv(b.basis * tracked, b.shares)
      gain += (tracked * held.assets) / held.shares - basis
    }
    if (gain > 0n) total += gain
  }
  return total
}

/**
 * `remoteUsdc` (otto/mamoru#391): what the account's remote Safes collected that owes the fee, as their operator answers
 * it (already priced, feeable and since `from` there). Added to the base here; charged only at home, so `chargedUsdc`
 * (this Safe's withdrawals) covers both.
 */
export function yieldFee(ops: readonly StoredOp[], bps: bigint = YIELD_FEE_BPS, from: string = YIELD_FEE_FROM, remoteUsdc: bigint = 0n, vault?: VaultFeeInput): YieldFee {
  const since = Date.parse(from)
  let collectedUsdc = remoteUsdc > 0n ? remoteUsdc : 0n
  let unpriced = 0
  let chargedUsdc = 0n
  // otto/mamoru#423: a collect read on several stored ops is charged once.
  for (const { facts, fee, feeable } of distinctFees(ops).fees) {
    if (!feeable || !(Date.parse(facts.at) >= since)) continue
    if (fee.usdc === undefined) unpriced++
    else collectedUsdc += BigInt(fee.usdc)
  }
  for (const op of ops) if (op.kind === 'transfer' && op.feeUsdc && charged(op)) chargedUsdc += BigInt(op.feeUsdc)
  const vaultGrowthUsdc = vault ? vaultGrowth(ops, vault) : 0n
  const feeUsdc = ((collectedUsdc + vaultGrowthUsdc) * bps) / 10_000n
  const left = feeUsdc > chargedUsdc ? feeUsdc - chargedUsdc : 0n
  return { collectedUsdc, vaultGrowthUsdc, unpriced, feeUsdc, chargedUsdc, owedUsdc: left >= YIELD_FEE_MIN ? left : 0n }
}
