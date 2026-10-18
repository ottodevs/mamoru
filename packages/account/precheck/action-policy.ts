// Spec 007 (otto/mamoru#151), tasks T4 and T6: precheck's own mirror of MamoruActionPolicy.checkAction's
// validation-time refusal classes — (a) price range on swaps (and the oracle check every priced action needs),
// (b) admission of positions for mint/decrease/collect/burn, (c) the per-pool value budget
// (contracts/action-policy/src/MamoruActionPolicy.sol) — so the engine's precheck (index.ts) refuses a call the
// deployed policy would refuse BEFORE it is ever signed and sent, never after. Pure: every read this mirror needs
// (the pool's two TWAPs, the policy's own on-chain spend counters, which tokenIds
// are admitted) is supplied by the caller (SessionLedger.watchActionPolicyPool / syncActionPolicyReads /
// admitTokenId in ./index.ts), from the same `observe` eth_call T3's `prepareCalls` already makes for the pool —
// this module makes no RPC calls of its own.
//
// (a): mirrors `_range`/`_swapBounds` at the FULL (1.0x) deployed band — never the engine's own narrower 0.8x
// band (`@mamoru/uniswap-v3/policy-bounds` does the math; T4 only calls it at a different band than T3's
// `prepareCalls` does). T6: the range is [max(long, short) - band + 1, min(long, short) + band], clipped to the
// pool's anchor if it has one, and refused outright when empty (`priceRange` returns null).
// (b): mint must target the policy (spec 007 "mint only through the policy"), with the same token0/token1/fee/
// recipient checks `checkAction`'s mint branch makes; decrease/collect/burn must name a tokenId the caller's
// admitted set covers for this pool (the engine's own allowedTokenIds/onMinted, plus tokenIds admitted at enable —
// `_isAdmitted` also checks `ownerOf`, which this mirror does not re-read). Decrease minimums are not re-checked
// here (the calldata has no tick range); the engine builds them from `decreaseMinsInRange` at a narrower band.
// (c): mirrors `_value`/`_bucket`/`_charge` exactly, charging swap `amountIn` and mint `amount*Desired` (both
// tokens valued in the pool's stable token at the range edge) call by call across one batch (a local accumulator
// here plays the role of the contract's storage write within one `validateUserOp`).
//
// (d) renewal is not mirrored here: a retired grant is already caught by the existing SESSION_REVOKED path (the
// engine revokes a grant's permissionId in its ledger at the same renewal that bumps the policy's generation), so
// `checkAction`'s own `b.generation != generationOf[account]` guard would never fire for a grant this engine still
// considers active.
import { decodeFunctionData, isAddressEqual, size, slice, toFunctionSelector, type Hex } from 'viem'
import type { Address, ReasonCode } from '@mamoru/domain'
import { nonfungiblePositionManagerAbi, swapRouter02Abi, type RegistryName } from '@mamoru/registry'
import { budgetAllows, budgetValue, priceRange, swapBoundsInRange, type OracleRead, type PolicySpend, type PriceAnchor, type PriceRange } from '@mamoru/uniswap-v3/policy-bounds'
import type { Execution } from '../safe/index.ts'

const SEL_EXACT_INPUT_SINGLE = toFunctionSelector('function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))')
const SEL_MINT = toFunctionSelector('function mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))')
const SEL_DECREASE = toFunctionSelector('function decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))')
const SEL_COLLECT = toFunctionSelector('function collect((uint256,address,uint128,uint128))')
const SEL_BURN = toFunctionSelector('function burn(uint256)')

/**
 * `MamoruActionPolicy.Init`, mirrored off chain (spec 007 T2's `mamoruInitFor`/`withActionPolicy` built it).
 * `bandTicks` here is the account's enabled (FULL, 1.0x) config — never the engine's own narrower band used to
 * build calls (`@mamoru/uniswap-v3/policy-bounds`'s `narrowBand`).
 */
export type ActionPolicyPoolConfig = {
  pool: RegistryName
  address: Address
  token0: Address
  token1: Address
  feePips: number
  bandTicks: number
  /** T6 H-1: Init.anchorTick/anchorBand (the stables pool's parity); absent = none. */
  anchor?: PriceAnchor
  /** T6 M-2: the budget unit is token1 (else token0) — the pool's stable token. */
  budgetIn1: boolean
  budgetWindowSeconds: number
  perWindow: bigint
  total: bigint
}

/** Mirrors `MamoruActionPolicy.Spend`, from one `spendOf(account, pool)` eth_call. */
export type ActionPolicySpend = PolicySpend

/** The reads the caller refreshes for a review that touches a covered pool: the pool's oracle (one
 * `observe([long, short, 0])`, `oracleFromObserve`) and the account's current `Spend` + `generationOf`. */
export type ActionPolicyReads = { oracle: OracleRead; spend: ActionPolicySpend; currentGeneration: bigint }

export type ActionPolicyCheck = { ok: true } | { ok: false; code: ReasonCode; detail: string }

/** Value charged against one pool's budget so far in the batch being checked — mirrors what `_charge` writes to
 * storage, call by call, within one `validateUserOp`. */
export type ActionPolicySpendAcc = Map<RegistryName, bigint>

function deny(code: ReasonCode, detail: string): ActionPolicyCheck {
  return { ok: false, code, detail }
}

/** Mirrors `_range`: the full-band range, or a POLICY_PRICE_BAND denial when the policy would find it empty. */
function rangeOf(cfg: ActionPolicyPoolConfig, reads: ActionPolicyReads): PriceRange | ActionPolicyCheck {
  const r = priceRange(reads.oracle, cfg.bandTicks, cfg.anchor)
  if (r) return r
  const o = reads.oracle
  return deny('POLICY_PRICE_BAND', `${cfg.pool}: empty range (twap ${o.twapLong}/${o.twapShort}, band ${cfg.bandTicks}${cfg.anchor ? `, anchor ${cfg.anchor.tick}+-${cfg.anchor.band}` : ''})`)
}

/**
 * Mirrors `_charge`: the bucket refills since the last on-chain charge, the approval total resets on a newer
 * generation, then `value` (plus what this batch already charged) must fit both — failing closed (never charging)
 * otherwise. `now` is the block time the userOp is expected to validate at.
 */
function chargeBudget(cfg: ActionPolicyPoolConfig, reads: ActionPolicyReads, now: number, value: bigint, acc: ActionPolicySpendAcc): ActionPolicyCheck {
  const prior = acc.get(cfg.pool) ?? 0n
  // The binding's generation is the account's current one (a retired one never reaches here, see (d) above).
  const budget = { generation: reads.currentGeneration, windowSeconds: cfg.budgetWindowSeconds, perWindow: cfg.perWindow, total: cfg.total }
  const r = budgetAllows(reads.spend, budget, BigInt(now), prior + value)
  if (!r.ok) {
    return deny('POLICY_BUDGET', `${cfg.pool}: bucket ${r.debt} (cap ${cfg.perWindow}), approval ${r.spent} (cap ${cfg.total})`)
  }
  acc.set(cfg.pool, prior + value)
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
    if (!reads) return deny('POLICY_PRICE_BAND', `${cfg.pool}: no oracle/spend read for the action policy's checks`)
    let args: { tokenIn: Address; tokenOut: Address; amountIn: bigint; amountOutMinimum: bigint; sqrtPriceLimitX96: bigint }
    try {
      const d = decodeFunctionData({ abi: swapRouter02Abi, data: c.callData })
      if (d.functionName !== 'exactInputSingle') return { ok: true }
      args = d.args[0] as typeof args
    } catch {
      return deny('POLICY_PRICE_BAND', 'undecodable exactInputSingle')
    }
    const zeroForOne = isAddressEqual(args.tokenIn, cfg.token0)
    const range = rangeOf(cfg, reads)
    if ('ok' in range) return range
    const bound = swapBoundsInRange({ range, feePips: cfg.feePips, zeroForOne, tokenIn: args.tokenIn, tokenOut: args.tokenOut, amountIn: args.amountIn })
    if (args.amountOutMinimum < bound.minOut) {
      return deny('POLICY_PRICE_BAND', `amountOutMinimum ${args.amountOutMinimum} under the range minimum ${bound.minOut} (range ${range.lo}..${range.hi})`)
    }
    if (args.sqrtPriceLimitX96 === 0n) return deny('POLICY_PRICE_BAND', 'sqrtPriceLimitX96 is zero: no limit')
    const limitOk = zeroForOne ? args.sqrtPriceLimitX96 >= bound.sqrtPriceLimitX96 : args.sqrtPriceLimitX96 <= bound.sqrtPriceLimitX96
    if (!limitOk) return deny('POLICY_PRICE_BAND', `sqrtPriceLimitX96 ${args.sqrtPriceLimitX96} past the range edge ${bound.sqrtPriceLimitX96}`)
    const value = budgetValue({ range, in1: cfg.budgetIn1, token0: cfg.token0, token1: cfg.token1, amount0: zeroForOne ? args.amountIn : 0n, amount1: zeroForOne ? 0n : args.amountIn })
    return chargeBudget(cfg, reads, now, value, acc)
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
    if (!reads) return deny('POLICY_BUDGET', `${cfg.pool}: no oracle/spend read for the action policy's budget check`)
    const range = rangeOf(cfg, reads)
    if ('ok' in range) return range
    const value = budgetValue({ range, in1: cfg.budgetIn1, token0: cfg.token0, token1: cfg.token1, amount0: args.amount0Desired, amount1: args.amount1Desired })
    return chargeBudget(cfg, reads, now, value, acc)
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
    // A decrease is priced (its minimums come from the range): the policy refuses it when the range is empty.
    if (selector === SEL_DECREASE && reads) {
      const range = rangeOf(cfg, reads)
      if ('ok' in range) return range
    }
    return { ok: true }
  }

  return { ok: true }
}
