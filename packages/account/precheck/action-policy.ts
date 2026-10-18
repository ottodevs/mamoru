// Spec 007 (otto/mamoru#151), task T4: precheck's own mirror of MamoruActionPolicy.checkAction's three
// validation-time refusal classes — (a) price band on swaps, (b) admission of positions for mint/decrease/
// collect/burn, (c) per-window and per-approval budgets (contracts/action-policy/src/MamoruActionPolicy.sol) — so
// the engine's precheck (index.ts) refuses a call the deployed policy would refuse BEFORE it is ever signed and
// sent, never after. Pure: every read this mirror needs (the pool's TWAP tick, the policy's own on-chain spend
// counters, which tokenIds are admitted) is supplied by the caller (SessionLedger.watchActionPolicyPool /
// syncActionPolicyReads / admitTokenId in ./index.ts), the same one-eth_call-per-review discipline T3's
// `prepareCalls` already follows for `poolTwapTick` — this module makes no RPC calls of its own.
//
// (a): mirrors `_swapOk`/`_swapBounds` at the FULL (1.0x) deployed band — never the engine's own narrower 0.8x
// band (`@mamoru/uniswap-v3/policy-bounds`'s `swapBoundsAtBand` already does the math; T4 only calls it at a
// different band than T3's `prepareCalls` does).
// (b): mint must target the policy (spec 007 "mint only through the policy"), with the same token0/token1/fee/
// recipient checks `checkAction`'s mint branch makes; decrease/collect/burn must name a tokenId the caller's
// admitted set covers for this pool (the engine's own allowedTokenIds/onMinted — `_isAdmitted` also checks
// `ownerOf`, which this mirror does not re-read: the caller removes a tokenId from its admitted set once it knows
// the account no longer holds it, same as `_isAdmitted`'s intent).
// (c): mirrors `_spendOk`'s epoch/generation reset rules exactly, charging swap `amountIn` and mint
// `amount*Desired` call by call across one batch (a local accumulator here plays the role of the contract's
// storage write within one `validateUserOp`), against the budget signed into `MamoruActionPolicy.Init` (the
// contract exposes no public getter for `Budget`, only for `Spend` — `spendOf` — so the caps are known only to
// whoever built this `PolicyVersion`, same as `@mamoru/policy`'s `mamoruInitFor`).
//
// (d) renewal is not mirrored here: a retired grant is already caught by the existing SESSION_REVOKED path (the
// engine revokes a grant's permissionId in its ledger at the same renewal that bumps the policy's generation), so
// `checkAction`'s own `c.generation != generationOf[account]` guard would never fire for a grant this engine still
// considers active.
import { decodeFunctionData, isAddressEqual, size, slice, toFunctionSelector, type Hex } from 'viem'
import type { Address, ReasonCode } from '@mamoru/domain'
import { nonfungiblePositionManagerAbi, swapRouter02Abi, type RegistryName } from '@mamoru/registry'
import { swapBoundsAtBand } from '@mamoru/uniswap-v3/policy-bounds'
import type { Execution } from '../safe/index.ts'

const SEL_EXACT_INPUT_SINGLE = toFunctionSelector('function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))')
const SEL_MINT = toFunctionSelector('function mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))')
const SEL_DECREASE = toFunctionSelector('function decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))')
const SEL_COLLECT = toFunctionSelector('function collect((uint256,address,uint128,uint128))')
const SEL_BURN = toFunctionSelector('function burn(uint256)')

/**
 * `MamoruActionPolicy.Init`, mirrored off chain: the contract exposes no public getter for `Budget` (only for
 * `Spend`, via `spendOf`), so the caps are known only to whoever built this `PolicyVersion` (spec 007 T2's
 * `mamoruInitFor`/`withActionPolicy`). `bandTicks` here is the account's enabled (FULL, 1.0x) config — never the
 * engine's own narrower band used to build calls (`@mamoru/uniswap-v3/policy-bounds`'s `narrowBand`).
 */
export type ActionPolicyPoolConfig = {
  pool: RegistryName
  address: Address
  token0: Address
  token1: Address
  feePips: number
  bandTicks: number
  budgetWindowSeconds: number
  perWindow0: bigint
  perWindow1: bigint
  total0: bigint
  total1: bigint
}

/** Mirrors `MamoruActionPolicy.Spend`, from one `spendOf(account, pool)` eth_call (spec 007 T4: "read the
 * policy's on-chain counters if there is a view for it, one eth_call"). */
export type ActionPolicySpend = { epoch: bigint; generation: bigint; window0: bigint; window1: bigint; total0: bigint; total1: bigint }

/** The reads the caller refreshes for a review that touches a covered pool: the pool's own TWAP tick (the same
 * `observe` eth_call T3's bound-building already makes for this pool) and the account's current `Spend` +
 * `generationOf` (two views, or one Multicall3 batch). */
export type ActionPolicyReads = { twapTick: number; spend: ActionPolicySpend; currentGeneration: bigint }

export type ActionPolicyCheck = { ok: true } | { ok: false; code: ReasonCode; detail: string }

/** Running (amount0, amount1) charged against one pool's budget so far in the batch being checked — mirrors what
 * `_spendOk` accumulates in storage, call by call, within one `validateUserOp`. */
export type ActionPolicySpendAcc = Map<RegistryName, { a0: bigint; a1: bigint }>

function deny(code: ReasonCode, detail: string): ActionPolicyCheck {
  return { ok: false, code, detail }
}

/**
 * Mirrors `_spendOk`: resets the window on an epoch change, resets everything on a generation change (the policy
 * was renewed since this `Spend` was last written), then charges `a0`/`a1` — failing closed (never charging) if
 * either budget is exceeded.
 */
function chargeBudget(cfg: ActionPolicyPoolConfig, reads: ActionPolicyReads, now: number, a0: bigint, a1: bigint, acc: ActionPolicySpendAcc): ActionPolicyCheck {
  const { spend, currentGeneration } = reads
  const freshGeneration = spend.generation === currentGeneration
  const nowEpoch = cfg.budgetWindowSeconds === 0 ? 0n : BigInt(Math.floor(now / cfg.budgetWindowSeconds))
  const sameEpoch = freshGeneration && spend.epoch === nowEpoch
  const baseWindow0 = sameEpoch ? spend.window0 : 0n
  const baseWindow1 = sameEpoch ? spend.window1 : 0n
  const baseTotal0 = freshGeneration ? spend.total0 : 0n
  const baseTotal1 = freshGeneration ? spend.total1 : 0n
  const prior = acc.get(cfg.pool) ?? { a0: 0n, a1: 0n }
  const w0 = baseWindow0 + prior.a0 + a0
  const w1 = baseWindow1 + prior.a1 + a1
  const t0 = baseTotal0 + prior.a0 + a0
  const t1 = baseTotal1 + prior.a1 + a1
  if (w0 > cfg.perWindow0 || w1 > cfg.perWindow1 || t0 > cfg.total0 || t1 > cfg.total1) {
    return deny('POLICY_BUDGET', `${cfg.pool}: window ${w0}/${w1} (cap ${cfg.perWindow0}/${cfg.perWindow1}), total ${t0}/${t1} (cap ${cfg.total0}/${cfg.total1})`)
  }
  acc.set(cfg.pool, { a0: prior.a0 + a0, a1: prior.a1 + a1 })
  return { ok: true }
}

/**
 * One call of a batch, evaluated the way `checkAction` would for calls this account's action-policy grants cover.
 * `cfg`/`reads` are already resolved for the ONE pool the calling grant is for — a v4 grant is always single-pool
 * (`packages/policy/src/v4-grants.ts`). A call this mirror does not recognise (an approve, or anything else the
 * grant's own rules already restrict) is left to those grant-level checks: this function only denies what
 * MamoruActionPolicy itself would refuse in ADDITION to them (spec 007: "added as a SECOND policy").
 */
export function checkActionPolicyCall(
  c: Execution,
  cfg: ActionPolicyPoolConfig,
  reads: ActionPolicyReads | undefined,
  now: number,
  acc: ActionPolicySpendAcc,
  isAdmitted: (tokenId: bigint) => boolean,
): ActionPolicyCheck {
  if (size(c.callData) < 4) return { ok: true }
  const selector = slice(c.callData, 0, 4).toLowerCase() as Hex

  if (selector === SEL_EXACT_INPUT_SINGLE) {
    if (!reads) return deny('POLICY_PRICE_BAND', `${cfg.pool}: no TWAP/spend read for the action policy's checks`)
    let args: { tokenIn: Address; tokenOut: Address; amountIn: bigint; amountOutMinimum: bigint; sqrtPriceLimitX96: bigint }
    try {
      const d = decodeFunctionData({ abi: swapRouter02Abi, data: c.callData })
      if (d.functionName !== 'exactInputSingle') return { ok: true }
      args = d.args[0] as typeof args
    } catch {
      return deny('POLICY_PRICE_BAND', 'undecodable exactInputSingle')
    }
    const zeroForOne = isAddressEqual(args.tokenIn, cfg.token0)
    const bound = swapBoundsAtBand({ twap: reads.twapTick, bandTicks: cfg.bandTicks, feePips: cfg.feePips, zeroForOne, tokenIn: args.tokenIn, tokenOut: args.tokenOut, amountIn: args.amountIn })
    if (args.amountOutMinimum < bound.minOut) {
      return deny('POLICY_PRICE_BAND', `amountOutMinimum ${args.amountOutMinimum} under the band minimum ${bound.minOut} (twap ${reads.twapTick}, bandTicks ${cfg.bandTicks})`)
    }
    if (args.sqrtPriceLimitX96 === 0n) return deny('POLICY_PRICE_BAND', 'sqrtPriceLimitX96 is zero: no limit')
    const limitOk = zeroForOne ? args.sqrtPriceLimitX96 >= bound.sqrtPriceLimitX96 : args.sqrtPriceLimitX96 <= bound.sqrtPriceLimitX96
    if (!limitOk) return deny('POLICY_PRICE_BAND', `sqrtPriceLimitX96 ${args.sqrtPriceLimitX96} past the band edge ${bound.sqrtPriceLimitX96}`)
    return chargeBudget(cfg, reads, now, zeroForOne ? args.amountIn : 0n, zeroForOne ? 0n : args.amountIn, acc)
  }

  if (selector === SEL_MINT) {
    // Spec 007 "(b) positions": "mint only through the policy" — a mint for a covered pool that targets the
    // manager directly bypasses admission and the budget charge entirely, so it is refused here even though the
    // raw calldata would otherwise look fine.
    if (!isAddressEqual(c.target, cfg.address)) {
      return deny('POLICY_NOT_ADMITTED', `mint to ${c.target}, not through the policy ${cfg.address}`)
    }
    let args: { token0: Address; token1: Address; fee: number; amount0Desired: bigint; amount1Desired: bigint }
    try {
      const d = decodeFunctionData({ abi: nonfungiblePositionManagerAbi, data: c.callData })
      if (d.functionName !== 'mint') return { ok: true }
      args = d.args[0] as typeof args
    } catch {
      return deny('POLICY_NOT_ADMITTED', 'undecodable mint')
    }
    if (!isAddressEqual(args.token0, cfg.token0) || !isAddressEqual(args.token1, cfg.token1) || args.fee !== cfg.feePips) {
      return deny('POLICY_NOT_ADMITTED', `mint token0/token1/fee ${args.token0}/${args.token1}/${args.fee} do not match ${cfg.pool}`)
    }
    if (!reads) return deny('POLICY_BUDGET', `${cfg.pool}: no spend read for the action policy's budget check`)
    return chargeBudget(cfg, reads, now, args.amount0Desired, args.amount1Desired, acc)
  }

  if (selector === SEL_DECREASE || selector === SEL_COLLECT || selector === SEL_BURN) {
    let tokenId: bigint
    try {
      if (selector === SEL_BURN) {
        const d = decodeFunctionData({ abi: nonfungiblePositionManagerAbi, data: c.callData })
        if (d.functionName !== 'burn') return { ok: true }
        tokenId = d.args[0] as bigint
      } else {
        const d = decodeFunctionData({ abi: nonfungiblePositionManagerAbi, data: c.callData })
        if (d.functionName !== 'decreaseLiquidity' && d.functionName !== 'collect') return { ok: true }
        tokenId = (d.args[0] as { tokenId: bigint }).tokenId
      }
    } catch {
      return deny('POLICY_NOT_ADMITTED', 'undecodable decrease/collect/burn')
    }
    if (!isAdmitted(tokenId)) return deny('POLICY_NOT_ADMITTED', `tokenId ${tokenId} is not an admitted position of ${cfg.pool}`)
    return { ok: true }
  }

  return { ok: true }
}
