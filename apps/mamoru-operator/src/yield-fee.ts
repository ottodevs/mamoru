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
import { distinctFees, FACTS_VERSION, needsFacts, type VaultFlow } from './yield-receipts.ts'

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
 * the withdrawal; a vault absent from it (unreadable) counts nothing.
 */
export type VaultFeeInput = {
  from: string
  now: readonly VaultNow[]
  /** Called for each vault left uncharged because its history does not reconcile (or the whole account: vault ''), with why. */
  onSkip?: (vault: string, reason: VaultSkip) => void
}
export type VaultSkip = 'bad_start' | 'receipts_unread' | 'vault_unread' | 'unexplained_shares' | 'burn_exceeds_inventory'

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b

/**
 * otto/mamoru#433: growth of the account's vault shares, raw USDC, per vault summed.
 *
 * Every flow of the account (ERC-4626 Deposit/Withdraw of its shares, from receipts) keeps the share inventory right;
 * only some are *counted*: those of a transaction every stored copy of which was read in the fee's scope (`feeable`) and
 * dated at or after both YIELD_FEE_FROM and `input.from`. Counted deposits form the tracked lot: its basis is the assets
 * at entry, so USDC a harvest swept into a vault (charged when collected) is never charged twice. Any redemption burns
 * the tracked lot pro rata to the shares it holds in the vault (counted or not, so basis retires with the shares); only a
 * counted one realizes assets minus the basis it burns (an uncounted one realizes a loss, never a gain). What is still held is valued at the share price of `input.now`.
 * Per vault the total is realized + unrealized, never below zero.
 *
 * A vault contributes nothing (the owner is not charged) unless its history reconciles: no receipt of the account is
 * still unread, the vault was read, and the flows never burn more shares than the inventory holds nor leave more than
 * the account holds now (so shares held before the first flow read, or moved in without a flow, leave the vault uncharged).
 * Basis rounds up, value and realized assets round down.
 *
 * High-water: the fee is owed as max(0, fee − charged) (yieldFee). What a withdrawal already charged is never refunded when
 * growth later falls, and nothing new is charged until the growth exceeds what was already charged. `onSkip` names each
 * vault left out and why, so a history that stops reconciling is seen, not silent.
 */
export function vaultGrowth(ops: readonly StoredOp[], input: VaultFeeInput): bigint {
  const since = Math.max(Date.parse(YIELD_FEE_FROM), Date.parse(input.from))
  if (!Number.isFinite(since)) {
    input.onSkip?.('', 'bad_start')
    return 0n
  }
  // A receipt still to be read can hold a flow: the history is not whole.
  if (ops.some(needsFacts)) {
    input.onSkip?.('', 'receipts_unread')
    return 0n
  }
  // A transaction counts only when every stored copy of it was read in scope.
  const txFeeable = new Map<string, boolean>()
  for (const op of ops) {
    const tx = (op.txHash ?? op.facts?.txHash)?.toLowerCase()
    if (tx) txFeeable.set(tx, (txFeeable.get(tx) ?? true) && op.facts?.feeable === true && op.facts.txHash?.toLowerCase() === tx)
  }
  const byId = new Map<string, { flow: VaultFlow; t: number; block: number; counted: boolean }>()
  for (const op of ops) {
    const f = op.facts
    if (!f?.txHash || (f.v ?? 1) < FACTS_VERSION) continue
    const tx = f.txHash.toLowerCase()
    const t = Date.parse(f.at)
    for (const flow of f.vaultFlows ?? []) {
      const id = `${tx}:${flow.logIndex}`
      if (!byId.has(id)) byId.set(id, { flow, t, block: Number(f.block ?? 0), counted: txFeeable.get(tx) === true && t >= since })
    }
  }
  const flows = [...byId.values()].sort((a, b) => a.t - b.t || a.block - b.block || a.flow.logIndex - b.flow.logIndex)
  const vaults = new Set(flows.map((x) => x.flow.vault))
  let total = 0n
  for (const vault of vaults) {
    const held = input.now.find((v) => v.name === vault)
    if (!held) {
      input.onSkip?.(vault, 'vault_unread')
      continue
    }
    const mine = flows.filter((x) => x.flow.vault === vault)
    const net = mine.reduce((n, x) => n + (x.flow.kind === 'deposit' ? BigInt(x.flow.shares) : -BigInt(x.flow.shares)), 0n)
    // The flows must explain every share held: a transfer in, an unread deposit or older shares make the history unreconciled.
    if (net !== held.shares) {
      input.onSkip?.(vault, 'unexplained_shares')
      continue
    }
    let all = 0n
    let shares = 0n // tracked
    let basis = 0n
    let realized = 0n
    let whole = true
    for (const { flow, counted } of mine) {
      const sh = BigInt(flow.shares)
      const assets = BigInt(flow.assets)
      if (flow.kind === 'deposit') {
        all += sh
        if (counted) {
          shares += sh
          basis += assets
        }
        continue
      }
      if (sh > all || sh === 0n) {
        whole = false
        break
      }
      const take = (sh * shares) / all
      if (take > 0n) {
        const part = take === shares ? basis : ceilDiv(basis * take, shares)
        const diff = (assets * take) / sh - part
        // Out of scope a gain is forgone, but a loss still counts: basis retired uncounted never hides one.
        if (counted || diff < 0n) realized += diff
        basis -= part
        shares -= take
      }
      all -= sh
    }
    if (!whole) {
      input.onSkip?.(vault, 'burn_exceeds_inventory')
      continue
    }
    let gain = realized
    if (shares > 0n) gain += (shares * held.assets) / held.shares - basis
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
